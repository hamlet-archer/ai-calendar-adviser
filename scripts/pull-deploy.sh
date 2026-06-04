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

# R4.b — source the deploy-tick invariant helpers (template vendored from
# ai-ops-meta/deploy/templates/deploy-tick-invariant.sh per architect-
# backlog §R4). Helpers carry the "daemon-must-be-active after every
# deploy tick" invariant; wired below at the existing $DEPLOY_SCRIPT
# invocation site. UNIT is the long-running RPC daemon; reuse DAEMON_UNIT
# so the smoke-test override path stays single-source.
#
# Sourced by absolute path under $REPO_DIR rather than `dirname $0` because
# the puller runs from STABLE_PATH (outside the repo) — sibling lib/ would
# not be reachable from there. After deploy.sh's git reset the lib lives
# at $REPO_DIR/scripts/lib/.
#
# W6 — resilient source: the version-skew window. On the very tick that
# ships R4.b the working-tree copy is still the PRE-R4.b checkout (deploy.sh
# hasn't reset it yet — that runs AFTER this source), so $INVARIANT_LIB is
# either absent or a stale version that lacks the helpers. The pre-W6 code
# degraded to no-op stubs in exactly that case, which meant the recovery
# could not fire on the tick that introduces it — and the audited finding
# (W6 canonical; W7 e1fce182cbea + W8 6eb9b50ec9a8 are the same root cause)
# was that the daemon could then stay dead indefinitely.
#
# Fix: source resiliently, mirroring the N17 self-install pattern used below
# for pull-deploy.sh itself — prefer the working-tree copy, but if it's
# absent fetch the same-version helper straight out of origin/$BRANCH via
# `git show` into a temp file and source THAT. Only when even origin lacks
# it (a truly fresh repo with no lib committed yet) do we fall back to no-op
# stubs, so the puller never crashes. Sourcing must happen after `cd
# "$REPO_DIR"` + `git fetch` so the `git show origin/$BRANCH:...` ref is both
# valid and current; the actual source call is therefore deferred to
# source_invariant_lib() invoked below, post-fetch.
UNIT="$DAEMON_UNIT"
INVARIANT_LIB="${REPO_DIR}/scripts/lib/deploy-tick-invariant.sh"
INVARIANT_REL="scripts/lib/deploy-tick-invariant.sh"

# W6 — load the deploy-tick invariant helpers for THIS tick, regardless of
# checkout state. Called after `git fetch` (below) so origin/$BRANCH is a
# valid, up-to-date ref. Sets a shell-global so we only source once.
_invariant_sourced=
source_invariant_lib() {
  [[ -n "$_invariant_sourced" ]] && return 0
  if [[ -f "$INVARIANT_LIB" ]] && grep -q 'deploy_tick_invariant__post' "$INVARIANT_LIB" 2>/dev/null; then
    # shellcheck source=scripts/lib/deploy-tick-invariant.sh
    source "$INVARIANT_LIB"
    _invariant_sourced=1
    return 0
  fi
  # Working-tree copy absent or stale (pre-R4.b checkout on the introducing
  # tick). Fetch the same-version helper from origin/$BRANCH — same trick the
  # N17 self-install uses for the puller. `git show` reads straight out of
  # the object store; no working-tree reset needed (deploy.sh does that).
  local tmp_lib
  tmp_lib="$(mktemp)"
  if git show "origin/$BRANCH:$INVARIANT_REL" > "$tmp_lib" 2>/dev/null \
     && grep -q 'deploy_tick_invariant__post' "$tmp_lib" 2>/dev/null; then
    # shellcheck source=/dev/null
    source "$tmp_lib"
    rm -f "$tmp_lib"
    _invariant_sourced=1
    echo "W6: sourced deploy-tick-invariant.sh from origin/$BRANCH (working-tree copy absent/stale)" >&2
    return 0
  fi
  rm -f "$tmp_lib"
  # Even origin lacks it — truly fresh repo (or a test fixture that stages
  # neither). Final no-op-stub fallback so the puller still runs.
  deploy_tick_invariant__pre_state() { echo "unknown"; }
  deploy_tick_invariant__post() { return 0; }
  _invariant_sourced=1
}

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

# W6 — source the deploy-tick invariant helpers now, AFTER the fetch, so the
# origin/$BRANCH fallback ref is valid and current even on the introducing
# tick (the working-tree copy is still the pre-R4.b version at this point).
source_invariant_lib

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" ]]; then
  # No deploy needed — still probe daemon liveness so the no-op path
  # doesn't mask a daemon outage (the original N15 failure mode).
  #
  # W6 — recover on the no-deploy path too. This is the half of the bug
  # that actually causes "stays dead indefinitely": after a failed deploy
  # that stopped the daemon, every subsequent tick takes THIS LOCAL ==
  # REMOTE fast path (deploy.sh already advanced the repo), so the
  # post-deploy invariant below never runs again. The pre-W6 code only
  # `probe_daemon || true`'d here — observability, no recovery — so the
  # daemon stayed down until another code change happened to land.
  #
  # Fix: when the probe finds the daemon down, attempt the SAME one-shot
  # reset-failed + start the post-deploy invariant performs. We reuse the
  # invariant helper rather than duplicating its logic: pass deploy_status=1
  # (so it doesn't short-circuit on the success no-op) and pre_state="active"
  # (on the no-deploy path the daemon is expected to be up, so a down daemon
  # IS our outage to fix — there's no "deploy killed it" vs. "already dead"
  # ambiguity here, unlike the post-deploy path). A recovery failure is
  # surfaced via exit status, consistent with the post-deploy `exit
  # $deploy_status` pattern; a recovery success still exits 0.
  noop_status=0
  if ! probe_daemon; then
    deploy_tick_invariant__post 1 "active" || noop_status=$?
  fi
  exit "$noop_status"
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

# Normalize tree ownership BEFORE deploy.sh runs `npm ci`. The puller
# runs as `ubuntu` (per `User=ubuntu` in the unit), and so does
# deploy.sh. But recovery operations during an outage (e.g. `sudo npm
# install` while debugging an OAuth cascade) sometimes leave root-owned
# files inside /opt/ai-calendar-adviser/node_modules/ or the deploy-
# side npm-cache. When that happens, `npm ci`'s first move — unlinking
# the old tree to rebuild from package-lock.json — fails with
# "EACCES: permission denied, unlink '.../node_modules/...'", deploy.sh's
# `set -euo pipefail` exits BEFORE the `systemctl start` line, and the
# service stays stopped indefinitely. 27-min outage on 2026-05-27 10:33Z
# (after N18.d merged); incident
# `2026-05-27-ai-calendar-adviser-deploy-npm-eacces-27min-outage.md`.
# `sudo -n` is non-interactive (ubuntu has NOPASSWD ALL on this host;
# the existing deploy.sh already relies on sudo for `systemctl stop`).
# Silent no-op when ownership is already clean (the common case).
sudo -n /usr/bin/chown -R ubuntu:ubuntu \
  "$REPO_DIR" \
  /opt/ai-calendar-adviser-deploy/npm-cache \
  /opt/ai-calendar-adviser-deploy/npm-logs \
  /opt/ai-calendar-adviser-deploy/npm-prefix \
  /opt/ai-calendar-adviser-deploy/.npm \
  2>/dev/null || true

# deploy.sh reads ${REMOTE} via its own git fetch + reset; we just hand off.
# Use `||` to capture deploy failures so the post-deploy probe still runs
# and we exit with the underlying status. Without this, `set -e` would
# silently swallow the daemon-probe (= the only observability we have).
#
# R4.b — capture pre-deploy state BEFORE the deploy fires so the invariant
# helper can tell "deploy killed an active unit" from "unit was already
# dead going in" (the latter is somebody else's outage).
pre_deploy_state=$(deploy_tick_invariant__pre_state)
deploy_status=0
"$DEPLOY_SCRIPT" || deploy_status=$?

# R4.b — enforce the post-deploy invariant. If deploy.sh exited non-zero
# AND the daemon was active going in AND the daemon is now dead, do one
# `systemctl reset-failed` + `start` attempt. Any failure here is captured
# in deploy_status so the puller tick propagates Result=failure to systemd
# for stability-mode to escalate.
deploy_tick_invariant__post "$deploy_status" "$pre_deploy_state" || deploy_status=$?

# B8.10.3 — post-daemon-reload systemd-unit drift check. Mirrors the
# B8.10.2 block in ai-comms-adviser/scripts/deploy.sh, but hooked in the
# puller (not the deploy script) because ai-calendar-adviser's deploy.sh
# lives at /opt/ai-calendar-adviser-deploy/deploy.sh on the VPS — NOT in
# this repo — so the drift check cannot ride inside the daemon-reload
# subshell the way ai-comms-adviser's does. The puller is the closest
# in-repo hook point after deploy.sh's daemon-reload.
#
# Only runs when deploy.sh succeeded. On any drift between
# `systemctl cat <unit>` (with the `# /etc/systemd/system/<unit>` header
# stripped via tail -n +2) and the in-repo `deploy/systemd/<unit>` file,
# log the unit name + unified diff to stderr and set deploy_status=1.
# The puller's systemd unit Result=exit-code then propagates and the
# dashboard's `/health` page flips ai-calendar-adviser red within one
# heartbeat — matching the operator_observable for B8.10.3 (and the
# parent B8.10 row).
#
# Catches: (a) manual edits to /etc/systemd/system that bypassed deploy.sh's
# unit-file sync, (b) a future regression of that sync, (c) drop-in files
# under /etc/systemd/system/<unit>.d/ that change effective unit text.
if [[ "$deploy_status" -eq 0 ]]; then
  drift_ok=1
  shopt -s nullglob
  for unit_path in "$REPO_DIR"/deploy/systemd/*.service "$REPO_DIR"/deploy/systemd/*.timer; do
    unit_name=$(basename "$unit_path")
    diff_tmp=$(mktemp)
    if ! diff -u <("$SYSTEMCTL_BIN" cat "$unit_name" 2>/dev/null | tail -n +2) "$unit_path" > "$diff_tmp" 2>&1; then
      echo "drift: $unit_name differs between systemctl-cat and $unit_path" >&2
      cat "$diff_tmp" >&2
      drift_ok=
    fi
    rm -f "$diff_tmp"
  done
  shopt -u nullglob
  if [[ -z "${drift_ok:-}" ]]; then
    echo "B8.10.3 drift check FAILED — running systemd unit text differs from in-repo deploy/systemd/" >&2
    deploy_status=1
  fi
fi

# Post-deploy: probe daemon (deploy.sh may have restarted the unit; a
# failed restart should still surface here).
probe_daemon || true

# Propagate deploy failure if any — the systemd Result=exit-code is the
# audit signal step 2.6.1 in operator-runner.md uses to gate close-the-
# row.
exit $deploy_status
