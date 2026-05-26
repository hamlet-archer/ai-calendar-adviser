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

describe('pull-deploy.sh — N17 early self-install', () => {
  let stubsDir: string;
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeRepoDir();
  });

  afterEach(() => {
    if (stubsDir) rmSync(stubsDir, { recursive: true, force: true });
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  // The script only self-installs when `realpath "$0" == STABLE_PATH`.
  // For the test we run via a temp symlink whose realpath matches the
  // configured STABLE_PATH so the self-install branch is exercised.
  function runViaStablePath(stubs: Record<string, string>): {
    result: RunResult;
    stablePath: string;
  } {
    stubsDir = makeStubsDir(stubs);
    const stablePath = join(stubsDir, 'stable-pull-deploy.sh');
    // Copy the real script into stable-pull-deploy.sh so its realpath
    // == STABLE_PATH inside the test, and the self-install branch fires.
    const r = spawnSync('cp', [SCRIPT, stablePath], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    chmodSync(stablePath, 0o755);
    const path = `${stubsDir}:/usr/bin:/bin`;
    const out = spawnSync('bash', [stablePath], {
      env: {
        ...process.env,
        PATH: path,
        REPO_DIR: repoDir,
        DEPLOY_SCRIPT: join(stubsDir, 'deploy.sh'),
        STABLE_PATH: stablePath,
        DAEMON_UNIT: 'fake-daemon.service',
        SYSTEMCTL_BIN: 'systemctl',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return {
      result: {
        status: out.status ?? -1,
        stdout: out.stdout ?? '',
        stderr: out.stderr ?? '',
      },
      stablePath,
    };
  }

  // Helper: write a sentinel file the git stub will `cat` when invoked
  // as `git show origin/$BRANCH:scripts/pull-deploy.sh`. Returns the
  // path so the test can assert on the file's content separately.
  function writeSentinelFile(dir: string, content: string): string {
    const p = join(dir, 'fake-origin-pull-deploy.sh');
    writeFileSync(p, content, 'utf8');
    return p;
  }

  it('self-installs the new pull-deploy.sh BEFORE deploy.sh runs, even when deploy.sh fails', () => {
    // git rev-parse: returns LOCAL on first call, REMOTE on second.
    // git show origin/main:scripts/pull-deploy.sh: cats the sentinel file.
    // deploy.sh: exits 1 (simulates the npm EACCES that's kept the
    //   daemon down since 2026-05-13).
    stubsDir = makeStubsDir({
      git: `case "$1" in
  rev-parse)
    STATE="$(dirname "$0")/.git-rev-parse-count"
    if [[ ! -f "$STATE" ]]; then
      echo aaaaaaaaaaaaaaaa
      echo 1 > "$STATE"
    else
      echo bbbbbbbbbbbbbbbb
    fi
    ;;
  show)
    cat "$(dirname "$0")/fake-origin-pull-deploy.sh"
    ;;
  *)
    exit 0
    ;;
esac`,
      systemctl: 'if [[ "$1" == "is-active" ]]; then exit 0; fi',
      logger: 'exit 0',
      'deploy.sh': 'echo "deploy ran (simulated failure)"; exit 1',
    });
    writeSentinelFile(stubsDir, '#!/usr/bin/env bash\n# N17-SENTINEL-NEW-PULLER\n');
    const stablePath = join(stubsDir, 'stable-pull-deploy.sh');
    const cp = spawnSync('cp', [SCRIPT, stablePath], { encoding: 'utf8' });
    expect(cp.status).toBe(0);
    chmodSync(stablePath, 0o755);
    const path = `${stubsDir}:/usr/bin:/bin`;
    const out = spawnSync('bash', [stablePath], {
      env: {
        ...process.env,
        PATH: path,
        REPO_DIR: repoDir,
        DEPLOY_SCRIPT: join(stubsDir, 'deploy.sh'),
        STABLE_PATH: stablePath,
        DAEMON_UNIT: 'fake-daemon.service',
        SYSTEMCTL_BIN: 'systemctl',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(out.stdout ?? '').toMatch(/self-installed updated pull-deploy\.sh/);
    expect(out.stdout ?? '').toContain('deploy ran (simulated failure)');
    expect(out.status).not.toBe(0);
    // Stable file now contains the sentinel — proof the install actually wrote.
    const stableContents = spawnSync('cat', [stablePath], { encoding: 'utf8' }).stdout;
    expect(stableContents).toContain('N17-SENTINEL-NEW-PULLER');
  });

  it('does not self-install on no-op path (LOCAL == REMOTE)', () => {
    stubsDir = makeStubsDir({
      git: `case "$1" in
  rev-parse) echo deadbeefdeadbeef ;;
  show) cat "$(dirname "$0")/fake-origin-pull-deploy.sh" ;;
  *) exit 0 ;;
esac`,
      systemctl: 'if [[ "$1" == "is-active" ]]; then exit 0; fi',
      logger: 'exit 0',
    });
    writeSentinelFile(stubsDir, '#!/usr/bin/env bash\n# WRONG-SHOULD-NOT-INSTALL\n');
    const stablePath = join(stubsDir, 'stable-pull-deploy.sh');
    const cp = spawnSync('cp', [SCRIPT, stablePath], { encoding: 'utf8' });
    expect(cp.status).toBe(0);
    chmodSync(stablePath, 0o755);
    const out = spawnSync('bash', [stablePath], {
      env: {
        ...process.env,
        PATH: `${stubsDir}:/usr/bin:/bin`,
        REPO_DIR: repoDir,
        DEPLOY_SCRIPT: join(stubsDir, 'deploy.sh'),
        STABLE_PATH: stablePath,
        DAEMON_UNIT: 'fake-daemon.service',
        SYSTEMCTL_BIN: 'systemctl',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    const stableContents = spawnSync('cat', [stablePath], { encoding: 'utf8' }).stdout;
    expect(stableContents).not.toContain('WRONG-SHOULD-NOT-INSTALL');
  });

  it('propagates deploy.sh non-zero exit so systemd surfaces the failure', () => {
    // Make sure a deploy-side failure isn't swallowed by `set -e` + the
    // probe_daemon || true at the end. The puller's exit status feeds
    // the systemd Result= the §2.6.1 verifier reads.
    const r = runViaStablePath({
      git: `case "$1" in
  rev-parse)
    STATE="$(dirname "$0")/.git-rev-parse-count"
    if [[ ! -f "$STATE" ]]; then
      echo aaaaaaaaaaaaaaaa
      echo 1 > "$STATE"
    else
      echo bbbbbbbbbbbbbbbb
    fi
    ;;
  show) exit 0 ;;
  *) exit 0 ;;
esac`,
      systemctl: 'if [[ "$1" == "is-active" ]]; then exit 0; fi',
      logger: 'exit 0',
      'deploy.sh': 'echo failing; exit 42',
    });
    expect(r.result.status).toBe(42);
  });
});
