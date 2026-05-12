/**
 * ai-calendar-adviser entry point.
 *
 * Today this binary runs the boot self-check (sub-item 2) and exits 0 on
 * success / 1 on failure. The post-boot flow — the 15-min sync runner and
 * the long-running Unix-socket RPC server — lands in sub-items 3 + 4.
 *
 * Implementation tracked in ai-ops-meta `architect-backlog.md` under the
 * Phase 3 grounding-source agents section. Design lives in
 * `docs/architecture.md` §6.8 in the same repo.
 */

import { BootCheckError, renderDiagnostic, runBootCheck } from './boot-check.js';

async function main(): Promise<number> {
  try {
    const { calendarIds } = await runBootCheck();
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'ai-calendar-adviser',
        phase: 'boot-check',
        msg: 'boot_ok',
        calendar_slot_count: Object.keys(calendarIds).length,
        next: 'sub-item 3 wires runSyncCycle + 15-min systemd timer',
      }),
    );
    return 0;
  } catch (err) {
    if (err instanceof BootCheckError) {
      // eslint-disable-next-line no-console
      console.error(renderDiagnostic(err.diagnostic));
      return 1;
    }
    // eslint-disable-next-line no-console
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
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // eslint-disable-next-line no-console
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
