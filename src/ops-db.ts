/**
 * Control-plane wrapper — opens the shared ops.db on golden-ai-ops via
 * `@hamlet-archer/ai-ops-control-plane`, so the dashboard's fleet-liveness
 * probe sees a fresh `runs.started_at` for calendar-adviser every sync cadence
 * (architect-backlog AI1: this agent previously emitted zero ops.db traces and
 * was therefore invisible to ops.db-based liveness).
 *
 * Path resolution is delegated to the lib (OPS_DB_PATH →
 * /var/lib/ai-ops/ops.db → ~/.local/share/ai-ops/ops.db). The bootstrap UPSERT
 * registers the agents row with the shape the lib needs — an existence guard at
 * boot would otherwise UnknownAgentError on a fresh dev database. Unlike the
 * runner-heartbeat INSERT-OR-IGNORE seed, the lib bootstrap is an UPSERT, so a
 * registry change (status / blast radius) self-heals on the next boot.
 *
 * `validatorMode: 'warn'` — calendar-adviser serves RPC contracts
 * (calendar.query.v1 / calendar.find_free_slot.v1) but emits no control-plane
 * handoffs and bootstraps no contract rows here, so handoff-payload validation
 * has nothing to bind to. (The agent's own RPC-side contract validation lives in
 * src/contracts.ts and is unaffected.)
 */

import { type ControlPlane, open } from '@hamlet-archer/ai-ops-control-plane';

import type { SyncCycleReport } from './sync-runner.js';

const CALENDAR_ADVISER_AGENT_ROW = {
  id: 'calendar-adviser',
  name: 'Calendar Adviser',
  status: 'active' as const,
  blastRadius: 'domain-write' as const,
  notionPageId: null,
  repoUrl: 'https://github.com/hamlet-archer/ai-calendar-adviser',
  acceptedIntents: ['calendar.query.v1', 'calendar.find_free_slot.v1'],
};

let _cp: ControlPlane | null = null;

export async function openOpsDb(): Promise<ControlPlane> {
  if (_cp) return _cp;
  _cp = await open({
    agentId: 'calendar-adviser',
    validatorMode: 'warn',
    bootstrap: { agents: [CALENDAR_ADVISER_AGENT_ROW] },
  });
  return _cp;
}

export async function closeOpsDb(): Promise<void> {
  if (!_cp) return;
  await _cp.close();
  _cp = null;
}

/**
 * Wrap one sync cycle in a control-plane run so each 15-min oneshot (and the
 * daemon's initial sync) writes a `runs` row + an `events` row on failure.
 * Returns the `SyncCycleReport` unchanged so callers keep their existing
 * render / exit-code logic.
 *
 * Fail-soft on the *trace*, never on the *sync*. The whole point of this wiring
 * is observability; it must not reduce availability. If ops.db is unreachable
 * (locked, disk full, perms drift) `openOpsDb`/`startRun` is caught and the sync
 * runs untraced with a single warn line — mirroring the runner-heartbeat's
 * "never crash the cycle on emit-failure" discipline. A genuine sync failure
 * still propagates so systemd's non-zero exit semantics are preserved.
 *
 * Five Whys (per docs/architecture.md §1.7 G2): (1) why catch open failure? so
 * a transient ops.db lock can't turn a green sync RED; (2) why would that
 * happen? the oneshot and the always-on RPC daemon both write ops.db (WAL,
 * concurrent writers) plus the runner heartbeat; (3) why does a red sync matter?
 * it manufactures a false "sync broken" signal — the opposite of this row's
 * intent; (4) why not let it crash like email-triage? email-triage opens once at
 * boot where a crash is acceptable; the advisers' sync oneshot IS the liveness
 * signal; (5) root cause: observability wiring added to a critical path must
 * degrade, not fail. PATCH-EXPIRY: none — this is a permanent design invariant,
 * not a temporary band-aid.
 */
export async function runSyncWithTrace(
  runSync: () => Promise<SyncCycleReport>,
): Promise<SyncCycleReport> {
  let cp: ControlPlane;
  let run: Awaited<ReturnType<ControlPlane['startRun']>>;
  try {
    cp = await openOpsDb();
    run = await cp.startRun({ triggeredBy: 'cron' });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        service: 'ai-calendar-adviser',
        phase: 'ops-db',
        msg: 'ops_db_unavailable_untraced',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return runSync();
  }

  try {
    const report = await runSync();
    const upserted = report.results.reduce((acc, r) => acc + r.upserted, 0);
    run.bumpItems(upserted);
    const failures = report.results.filter((r) => r.status === 'error');
    const okCount = report.results.length - failures.length;
    // AJ2a: per-cycle success-path trace event so the dashboard /feed shows the
    // sync OUTCOME (calendars synced, failures, events upserted), not just that
    // the sync ran (the `runs` row from AI1). Sibling of
    // email-triage.cycle_complete.v1; contract sync.cycle_complete.v1 in
    // ai-ops-meta. Fires on every non-throwing cycle — including partial-success
    // (failures.length > 0 but the sync did not throw); the `sync.failed`
    // catch-path emit below covers the thrown-error case. Fail-soft: a failed
    // emit never fails the sync (the sync oneshot IS the liveness signal, so
    // observability wiring must degrade, not fail — same invariant as the
    // open-failure catch above).
    try {
      await cp.emit({
        run,
        kind: 'sync.cycle_complete',
        severity: 'info',
        payload: {
          contract_id: 'sync.cycle_complete.v1',
          sources_ok: okCount,
          sources_failed: failures.length,
          rows_upserted: upserted,
          detail: `calendars_ok=${okCount} events_upserted=${upserted}`,
        },
      });
    } catch (emitErr) {
      console.error(
        JSON.stringify({
          level: 'warn',
          service: 'ai-calendar-adviser',
          phase: 'ops-db',
          msg: 'sync_cycle_complete_emit_failed',
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        }),
      );
    }
    if (failures.length > 0) {
      run.bumpErrors(failures.length);
      await run.end({
        status: 'failed',
        summary: `calendars_ok=${okCount} calendars_failed=${failures.length} events_upserted=${upserted}`,
        errorSummary: failures.map((f) => `${f.slot}: ${f.errorMessage ?? 'error'}`).join('; '),
      });
    } else {
      await run.end({
        status: 'done',
        summary: `calendars_ok=${okCount} events_upserted=${upserted}`,
      });
    }
    return report;
  } catch (err) {
    run.bumpErrors(1);
    await cp.emit({
      run,
      kind: 'sync.failed',
      severity: 'error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    await run.end({
      status: 'failed',
      errorSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
