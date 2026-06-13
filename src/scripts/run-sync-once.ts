/**
 * One-shot CLI: boot self-check → sync cycle → exit. Invoked by the
 * `ai-calendar-adviser-sync.timer` every 15 minutes.
 *
 * Exit codes:
 *   0 — every calendar synced clean.
 *   1 — boot self-check failed (credentials/config gap). Diagnostic on
 *       stderr per AP-4.
 *   2 — boot ok, but ≥1 calendar's sync errored. Per-calendar AP-2
 *       resilience kept the cycle going; the timer will retry in 15min.
 *       The non-zero exit gives systemd / observability a clean "partial
 *       failure" signal without blocking the cadence.
 */

import { BootCheckError, renderDiagnostic, runBootCheck } from '../boot-check.js';
import { CalendarCache } from '../cache.js';
import { closeOpsDb, runSyncWithTrace } from '../ops-db.js';
import { renderSyncReport, runSyncCycle } from '../sync-runner.js';

const DEFAULT_DB_PATH = process.env.CALENDAR_DB_PATH ?? '/var/lib/ai-calendar-adviser/calendar.db';

async function main(): Promise<number> {
  let calendarIds, adapter;
  try {
    const checked = await runBootCheck();
    calendarIds = checked.calendarIds;
    adapter = checked.adapter;
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

  const cache = new CalendarCache(DEFAULT_DB_PATH);
  try {
    // Wrap the cycle in a control-plane run so each timer fire writes an ops.db
    // `runs` row — the dashboard's fleet-liveness probe (AI1). runSyncWithTrace
    // returns the report unchanged and is fail-soft on the trace, so exit-code
    // semantics below are preserved even if ops.db is unreachable.
    const report = await runSyncWithTrace(() => runSyncCycle({ adapter, cache, calendarIds }));

    console.log(renderSyncReport(report));
    const failed = report.results.some((r) => r.status === 'error');
    return failed ? 2 : 0;
  } finally {
    cache.close();
    await closeOpsDb();
  }
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
