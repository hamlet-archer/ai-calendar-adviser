/**
 * N15 smoke test — `scripts/pull-deploy.sh` emits a structured
 * `calendar_adviser_daemon_down` line when the long-running RPC
 * daemon's systemctl probe fails. Without this check the pull-deploy
 * timer fires cleanly every 2 min while the daemon has been down for
 * days (2026-05-14 → 2026-05-26 audit).
 *
 * We drive the real bash script via stub `systemctl`/`logger`/`git`
 * binaries on PATH — no live systemd needed. The stubs let us shape
 * the daemon-up vs. daemon-down vs. deploy-needed cases.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'pull-deploy.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function makeStubsDir(stubs: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'n15-stubs-'));
  for (const [name, body] of Object.entries(stubs)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
    chmodSync(p, 0o755);
  }
  return dir;
}

function makeRepoDir(): string {
  // Bare directory with a `.git` symlink-stub isn't enough — we stub
  // `git` itself, so the script never enters real git logic. We only
  // need cd to succeed.
  const d = mkdtempSync(join(tmpdir(), 'n15-repo-'));
  mkdirSync(join(d, '.git'));
  return d;
}

function run(opts: {
  stubsDir: string;
  repoDir: string;
  env?: Record<string, string>;
}): RunResult {
  const path = `${opts.stubsDir}:/usr/bin:/bin`;
  const r = spawnSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      PATH: path,
      REPO_DIR: opts.repoDir,
      DEPLOY_SCRIPT: join(opts.stubsDir, 'deploy.sh'),
      STABLE_PATH: join(opts.stubsDir, 'stable-pull-deploy.sh'),
      DAEMON_UNIT: 'fake-daemon.service',
      SYSTEMCTL_BIN: 'systemctl', // resolved off the stubs dir
      ...(opts.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('pull-deploy.sh — N15 daemon-down probe', () => {
  let stubsDir: string;
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeRepoDir();
  });

  afterEach(() => {
    if (stubsDir) rmSync(stubsDir, { recursive: true, force: true });
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it('exits 0 silently when HEAD is up-to-date AND daemon is active', () => {
    stubsDir = makeStubsDir({
      git: 'if [[ "$1" == "rev-parse" ]]; then echo deadbeefdeadbeef; else exit 0; fi',
      // systemctl is-active --quiet → exit 0 (active)
      systemctl: 'exit 0',
      logger: 'exit 0',
    });
    const result = run({ stubsDir, repoDir });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('calendar_adviser_daemon_down');
  });

  it('emits structured calendar_adviser_daemon_down on the no-op path when daemon is inactive', () => {
    stubsDir = makeStubsDir({
      git: 'if [[ "$1" == "rev-parse" ]]; then echo deadbeefdeadbeef; else exit 0; fi',
      // is-active --quiet → exit 3 (inactive); show -p SubState → "failed"
      systemctl:
        'if [[ "$1" == "is-active" ]]; then exit 3; elif [[ "$1" == "show" ]]; then echo failed; fi',
      // logger no-op (script also echoes to stderr as a backup)
      logger: 'exit 0',
    });
    const result = run({ stubsDir, repoDir });
    // exit 0 — daemon-down is observability, not a deploy failure
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'calendar_adviser_daemon_down unit=fake-daemon.service substate=failed',
    );
  });

  it('still emits calendar_adviser_daemon_down after a successful deploy when daemon stays down', () => {
    // Two rev-parse calls — first returns LOCAL, second returns REMOTE.
    // Use a deterministic state file under the stubs dir (which IS the
    // shared workspace for sibling stub invocations) — $$ would change
    // per stub PID and defeat the toggle.
    stubsDir = makeStubsDir({
      git: `STATE_FILE="$(dirname "$0")/.git-call-count"
case "$1" in
  rev-parse)
    if [[ ! -f "$STATE_FILE" ]]; then
      echo aaaaaaaaaaaaaaaa
      echo 1 > "$STATE_FILE"
    else
      echo bbbbbbbbbbbbbbbb
    fi
    ;;
  *)
    exit 0
    ;;
esac`,
      systemctl:
        'if [[ "$1" == "is-active" ]]; then exit 3; elif [[ "$1" == "show" ]]; then echo failed; fi',
      logger: 'exit 0',
      'deploy.sh': 'echo deploy ran',
    });
    const result = run({ stubsDir, repoDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deploy ran');
    expect(result.stderr).toContain('calendar_adviser_daemon_down');
  });

  it('reports SubState "unknown" when systemctl show errors', () => {
    stubsDir = makeStubsDir({
      git: 'if [[ "$1" == "rev-parse" ]]; then echo deadbeefdeadbeef; else exit 0; fi',
      systemctl:
        'if [[ "$1" == "is-active" ]]; then exit 3; elif [[ "$1" == "show" ]]; then exit 1; fi',
      logger: 'exit 0',
    });
    const result = run({ stubsDir, repoDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('substate=unknown');
  });
});
