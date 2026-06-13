/**
 * ai-calendar-adviser entry point.
 *
 * Lifecycle:
 *   1. runBootCheck — credentials + slot resolution + per-calendar smoke test.
 *   2. runSyncCycle (initial pass) — populate the cache before serving RPC.
 *   3. startRpcServer — long-running Unix-socket daemon at /var/run/...
 *
 * The 15-min sync cadence is driven by a separate systemd timer (sub-item 3
 * — `run-sync-once.ts`); this binary is the always-on RPC server. The two
 * processes write to the same SQLite cache via WAL mode.
 *
 * Graceful shutdown: SIGTERM / SIGINT close the listener and remove the
 * socket file. systemd issues SIGTERM on `systemctl stop` + waits the unit's
 * `TimeoutStopSec` before SIGKILL.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { BootCheckError, renderDiagnostic, runBootCheck } from './boot-check.js';
import { CalendarCache } from './cache.js';
import { buildContractValidator } from './contracts.js';
import { closeOpsDb, openOpsDb, runSyncWithTrace } from './ops-db.js';
import { type RunningRpcServer, startRpcServer } from './rpc-server.js';
import { renderSyncReport, runSyncCycle } from './sync-runner.js';

const DEFAULT_DB_PATH = '/var/lib/ai-calendar-adviser/calendar.db';
// systemd RuntimeDirectory=ai-calendar-adviser creates /run/ai-calendar-adviser/.
// Note: /var/run is a compat symlink to /run on every modern systemd
// distribution, so callers using either path resolve to the same socket.
const DEFAULT_SOCKET_PATH = '/run/ai-calendar-adviser/query.sock';

async function main(): Promise<number> {
  const dbPath = process.env.CALENDAR_DB_PATH ?? DEFAULT_DB_PATH;
  const socketPath = process.env.CALENDAR_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;

  // 1. Boot self-check.
  let bootResult: Awaited<ReturnType<typeof runBootCheck>>;
  try {
    bootResult = await runBootCheck();
  } catch (err) {
    if (err instanceof BootCheckError) {
      console.error(renderDiagnostic(err.diagnostic));
      return 1;
    }
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-calendar-adviser',
        phase: 'boot-check',
        msg: 'unhandled_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return 2;
  }
  const { calendarIds, adapter } = bootResult;

  // 2. Initial sync — pull events into cache before serving RPC.
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    try {
      await mkdir(socketDir, { recursive: true });
    } catch {
      // Best-effort. systemd RuntimeDirectory typically creates /run/...
    }
  }
  // Register the agents row + open the shared ops.db handle once at boot, so
  // calendar-adviser is visible to the dashboard fleet-liveness probe even
  // before the first 15-min sync timer fires (AI1). Bootstrap is an UPSERT,
  // so a registry change self-heals here. Best-effort: a boot-time ops.db
  // outage must not block the RPC daemon.
  try {
    await openOpsDb();
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        service: 'ai-calendar-adviser',
        phase: 'ops-db',
        msg: 'ops_db_open_failed_at_boot',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const cache = new CalendarCache(dbPath);
  try {
    // Trace the daemon's initial sync as a `runs` row too (fail-soft on trace).
    const report = await runSyncWithTrace(() => runSyncCycle({ adapter, cache, calendarIds }));
    console.log(renderSyncReport(report));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'ai-calendar-adviser',
        phase: 'sync',
        msg: 'initial_sync_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // Initial-sync failure does NOT abort boot — the RPC server may still be
    // useful against a stale cache (queries return what's there; the next
    // 15-min sync retries). The sync runner itself logs per-calendar errors
    // via its `SyncCycleReport`.
  }

  // 3. Long-running RPC server.
  const validator = buildContractValidator();
  let running: RunningRpcServer;
  try {
    running = await startRpcServer({ socketPath, cache, calendarIds, validator });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-calendar-adviser',
        phase: 'rpc',
        msg: 'listen_failed',
        socket_path: socketPath,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    cache.close();
    return 1;
  }

  // Graceful shutdown wiring.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'ai-calendar-adviser',
        phase: 'shutdown',
        msg: 'received_signal',
        signal,
      }),
    );
    try {
      await running.close();
    } finally {
      cache.close();
      await closeOpsDb().catch(() => {
        /* best-effort flush on shutdown */
      });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Hold the process open — the server's listener keeps the event loop alive.
  return new Promise<number>(() => {
    // Never resolves under normal operation; signals exit via `shutdown`.
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'fatal',
        service: 'ai-calendar-adviser',
        msg: 'unhandled_rejection',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(2);
  },
);
