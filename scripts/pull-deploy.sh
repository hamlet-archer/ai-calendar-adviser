#!/usr/bin/env bash
# pull-deploy.sh — poll origin/main; if HEAD changed, invoke the
# server-side /opt/ai-calendar-adviser-deploy/deploy.sh which handles the
# heavy lifting (git reset, npm ci, build, systemd unit refresh, service
# restart). Run by systemd timer ai-calendar-adviser-pull-deploy.timer
# every ~2 min on golden-ai-ops.
#
# Mirrors ai-comms-adviser's polling-deploy pattern: cloud-egress webhook
# POSTs are unreliable from inside Anthropic's remote-trigger sandbox, so
# polling closes the loop deterministically.
#
# Stable runtime path: /opt/ai-calendar-adviser-deploy/pull-deploy.sh
# (lives outside /opt/ai-calendar-adviser so git resets inside the repo
# cannot wipe it). Source of truth is the copy in this repo at
# scripts/pull-deploy.sh; the puller self-installs the stable copy
# IMMEDIATELY after git fetch, BEFORE invoking deploy.sh — see N17 in
# ai-ops-meta architect-backlog.md. Doing the self-install last meant
# every code-change deploy that tripped over the npm EACCES at line 22
# of deploy.sh (since 2026-05-13) failed to ship the new pull-deploy.sh,
# so observability + deploy-script fixes couldn't reach production until
# the underlying daemon-restart issue was resolved.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/ai-calendar-adviser}"
BRANCH="${BRANCH:-main}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-/opt/ai-calendar-adviser-deploy/deploy.sh}"
STABLE_PATH="${STABLE_PATH:-/opt/ai-calendar-adviser-deploy/pull-deploy.sh}"
# N15 — name of the long-running RPC daemon we probe after every tick.
# Overridable for the smoke test (which points it at an inert unit name).
DAEMON_UNIT="${DAEMON_UNIT:-ai-calendar-adviser.service}"
# Override for the systemctl binary — lets the smoke test point at a
# stub that doesn't require root or a live systemd. Defaults to whatever
# `systemctl` resolves to on PATH.
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"

# systemd ProtectHome=read-only hides ~/.ssh — match the deploy.sh
# pattern and point at the staged key + known_hosts under /etc.
export GIT_SSH_COMMAND="ssh -i /etc/ai-calendar-adviser-deploy/ssh/key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/ai-calendar-adviser-deploy/ssh/known_hosts -o StrictHostKeyChecking=yes -o HostName=ssh.github.com -p 443"

# N15 — surface the silent failure where the pull-deploy timer fires
# cleanly every 2 min but the long-running RPC daemon has been down for
# days. Emit ONE structured journald line per tick on daemon-down so
# the audit + dashboard can render it. Two lines on transition (down→
# up) would be nicer but the script is stateless across ticks; the
# audit already counts down-ticks per window, which is sufficient.
#
# Runs at the end of every tick regardless of whether a deploy happened
# — the original bug was the no-op path (LOCAL == REMOTE) silently
# masking a daemon outage.
probe_daemon() {
  if "$SYSTEMCTL_BIN" is-active --quiet "$DAEMON_UNIT"; then
    return 0
  fi
  # systemctl exited non-zero. Capture the substate for the journald
  # event so the operator can tell "failed" (crashed/CREDENTIALS) from
  # "inactive" (never started) from "activating" (boot race) without
  # SSHing in. `--no-pager --plain` keeps it parseable on every distro.
  local substate
  substate="$("$SYSTEMCTL_BIN" show -p SubState --value "$DAEMON_UNIT" 2>/dev/null || echo unknown)"
  # `logger` is part of util-linux on every Ubuntu — journald-bound by
  # default. Structured KV pairs match the convention used by the other
  # bash deploy scripts in the fleet.
  logger --tag ai-calendar-adviser-pull-deploy --priority user.warning \
    "calendar_adviser_daemon_down unit=${DAEMON_UNIT} substate=${substate}"
  # Echo to stderr too so the systemd unit's StandardError captures it
  # even if `logger` is unavailable in a test sandbox.
  echo "calendar_adviser_daemon_down unit=${DAEMON_UNIT} substate=${substate}" >&2
  return 1
}

cd "$REPO_DIR"

git fetch --quiet origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" ]]; then
  # No deploy needed — still probe daemon liveness so the no-op path
  # doesn't mask a daemon outage (the original N15 failure mode).
  probe_daemon || true   # probe failure is observability, not a deploy failure
  exit 0
fi

echo "HEAD differs (${LOCAL:0:7} → ${REMOTE:0:7}); delegating to ${DEPLOY_SCRIPT}"

# N17 — self-update the stable copy IMMEDIATELY, BEFORE deploy.sh runs.
# Read the new pull-deploy.sh straight out of origin/$BRANCH via `git show`
# (no working-tree reset needed — deploy.sh will do that itself). If
# deploy.sh later fails (npm ci EACCES, build break, daemon refuse-to-
# start), the next timer tick already runs the newest pull-deploy.sh and
# can deliver fixes that depend on the puller's own logic.
#
# `install` is atomic (writes-then-renames) — safe even when the source
# file equals the currently-executing script. Resolve both sides via
# `realpath` so platform-specific symlinks (e.g. macOS `/var` → `/private/var`
# under tmpdir, which the smoke test exercises) don't defeat the equality
# check.
SELF_REAL="$(realpath "$0")"
STABLE_REAL="$(realpath "$STABLE_PATH" 2>/dev/null || echo "$STABLE_PATH")"
if [[ "$SELF_REAL" == "$STABLE_REAL" ]]; then
  TMP_PULLER="$(mktemp)"
  if git show "origin/$BRANCH:scripts/pull-deploy.sh" > "$TMP_PULLER" 2>/dev/null \
     && [[ -s "$TMP_PULLER" ]]; then
    install -m 755 "$TMP_PULLER" "$STABLE_PATH"
    echo "self-installed updated pull-deploy.sh (from origin/$BRANCH) before deploy"
  fi
  rm -f "$TMP_PULLER"
fi

# deploy.sh reads ${REMOTE} via its own git fetch + reset; we just hand off.
# Use `||` to capture deploy failures so the post-deploy probe still runs
# and we exit with the underlying status. Without this, `set -e` would
# silently swallow the daemon-probe (= the only observability we have).
deploy_status=0
"$DEPLOY_SCRIPT" || deploy_status=$?

# Post-deploy: probe daemon (deploy.sh may have restarted the unit; a
# failed restart should still surface here).
probe_daemon || true

# Propagate deploy failure if any — the systemd Result=exit-code is the
# audit signal step 2.6.1 in operator-runner.md uses to gate close-the-
# row.
exit $deploy_status
