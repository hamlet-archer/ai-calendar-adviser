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
# scripts/pull-deploy.sh; deploy.sh self-installs the stable copy on
# each successful run.

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

# deploy.sh reads ${REMOTE} via its own git fetch + reset; we just hand off.
"$DEPLOY_SCRIPT"

# Self-update the stable copy after the deploy succeeds, so the next
# timer tick uses whatever version of this script we just pulled.
# `install` writes-then-renames atomically — safe to overwrite the file
# currently executing.
if [[ -f "$REPO_DIR/scripts/pull-deploy.sh" ]] && [[ "$(realpath "$0")" == "$STABLE_PATH" ]]; then
  install -m 755 "$REPO_DIR/scripts/pull-deploy.sh" "$STABLE_PATH"
fi

# Post-deploy: probe daemon again (deploy.sh may restart the unit; a
# failed restart should still surface here).
probe_daemon || true
