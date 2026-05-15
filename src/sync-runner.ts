/**
 * Sync runner — walks the 4 Google-backed calendars, pulls events (full or
 * incremental), and persists them into the SQLite cache. Driven by the
 * 15-min systemd timer (`deploy/systemd/ai-calendar-adviser-sync.timer`).
 *
 * AP-2 discipline: a failure for one calendar does not abort the others.
 * The runner returns a `SyncCycleReport` enumerating per-calendar
 * outcomes — the caller decides whether to log, alert, or exit non-zero.
 * At boot-time (sub-item 2's boot-check) a single-calendar failure IS a
 * hard exit, but the in-flight sync runner trades that loudness for
 * resilience because the 15-min cadence will retry.
 *
 * Pacing: ≤ `CALENDAR_SYNC_RATE_PER_S` per-second across the 4 calendars
 * (well under Google's 50 req/s ceiling). The cap is in place per AP-6
 * (recorded empirical basis) so the next reviewer can recompute rather
 * than inherit.
 */

import type { CalendarSlot } from './calendar-config.js';
import { CALENDAR_SLOTS } from './calendar-config.js';
import type { CalendarCache, EventRow } from './cache.js';
import type { GoogleCalendarUserOauthAdapter } from './google-calendar-user-oauth-adapter.js';
import type { calendar_v3 } from 'googleapis';

// PATCH-EXPIRY: 2026-08-12 owner=calendar-adviser reason=https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md (calendar-adviser sub-item 3 magic-number register)
export const CALENDAR_SYNC_RATE_PER_S = 5;
// PATCH-EXPIRY: 2026-08-12 owner=calendar-adviser reason=same — initial-fetch window (no syncToken yet)
export const CALENDAR_LOOKBACK_DAYS = 30;

export interface SyncCycleDeps {
  readonly adapter: GoogleCalendarUserOauthAdapter;
  readonly cache: CalendarCache;
  readonly calendarIds: Record<CalendarSlot, string>;
  /** Clock seam for deterministic lookback windows in tests. */
  readonly now?: () => Date;
  /** Pacing seam — default sleeps. Tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PerCalendarResult {
  readonly slot: CalendarSlot;
  readonly calendarId: string;
  readonly status: 'ok' | 'error';
  readonly upserted: number;
  readonly nextSyncToken: string | null;
  readonly errorMessage?: string;
}

export interface SyncCycleReport {
  readonly startedAtIso: string;
  readonly endedAtIso: string;
  readonly results: readonly PerCalendarResult[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function eventRowFromGoogle(
  calendarId: string,
  ev: calendar_v3.Schema$Event,
  fetchedAtIso: string,
): EventRow | null {
  // No id → drop. Google sometimes emits placeholder rows; we don't cache them.
  if (!ev.id) return null;
  const startIso = ev.start?.dateTime ?? ev.start?.date ?? null;
  const endIso = ev.end?.dateTime ?? ev.end?.date ?? null;
  // All-day or cancelled events with missing bounds are dropped — the cache
  // schema mandates start_iso/end_iso as NOT NULL. Cancellation rows
  // (status='cancelled') in incremental-sync responses are similarly skipped
  // here; the upstream task is "current windows", not "audit log".
  if (!startIso || !endIso) return null;
  const tz = ev.start?.timeZone ?? ev.end?.timeZone ?? 'UTC';
  return {
    id: ev.id,
    calendarId,
    summary: ev.summary ?? null,
    startIso,
    endIso,
    tz,
    etag: ev.etag ?? null,
    updatedAt: ev.updated ?? fetchedAtIso,
    payloadJson: JSON.stringify(ev),
  };
}

async function syncOneCalendar(
  deps: SyncCycleDeps,
  slot: CalendarSlot,
  fetchedAtIso: string,
): Promise<PerCalendarResult> {
  const calendarId = deps.calendarIds[slot];
  const prior = deps.cache.getSyncState(calendarId);
  const now = (deps.now ?? (() => new Date()))();
  let upserted = 0;
  try {
    let result;
    if (prior?.syncToken) {
      result = await deps.adapter.listEvents({ calendarId, syncToken: prior.syncToken });
    } else {
      const timeMin = new Date(
        now.getTime() - CALENDAR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      result = await deps.adapter.listEvents({ calendarId, timeMin });
    }
    for (const ev of result.events) {
      const row = eventRowFromGoogle(calendarId, ev, fetchedAtIso);
      if (row) {
        deps.cache.upsertEvent(row);
        upserted += 1;
      }
    }
    deps.cache.setSyncState(calendarId, result.nextSyncToken, fetchedAtIso);
    return {
      slot,
      calendarId,
      status: 'ok',
      upserted,
      nextSyncToken: result.nextSyncToken,
    };
  } catch (err) {
    return {
      slot,
      calendarId,
      status: 'error',
      upserted,
      nextSyncToken: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Walk every calendar slot in order, sleeping between calls to honour the
 * fleet-wide per-second cap. AP-2: per-calendar errors are recorded and
 * the loop continues.
 */
export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleReport> {
  const startedAtIso = (deps.now ?? (() => new Date()))().toISOString();
  const sleep = deps.sleep ?? defaultSleep;
  const minSpacingMs = Math.ceil(1000 / CALENDAR_SYNC_RATE_PER_S);
  const results: PerCalendarResult[] = [];
  for (let i = 0; i < CALENDAR_SLOTS.length; i += 1) {
    const slot = CALENDAR_SLOTS[i];
    if (i > 0) {
      await sleep(minSpacingMs);
    }
    const r = await syncOneCalendar(deps, slot, startedAtIso);
    results.push(r);
  }
  const endedAtIso = (deps.now ?? (() => new Date()))().toISOString();
  return { startedAtIso, endedAtIso, results };
}

/** Single-line JSON renderer for journald. */
export function renderSyncReport(report: SyncCycleReport): string {
  const ok = report.results.filter((r) => r.status === 'ok').length;
  const failed = report.results.filter((r) => r.status === 'error').length;
  const upserted = report.results.reduce((acc, r) => acc + r.upserted, 0);
  return JSON.stringify({
    level: failed > 0 ? 'warn' : 'info',
    service: 'ai-calendar-adviser',
    phase: 'sync',
    msg: 'sync_cycle_complete',
    started_at: report.startedAtIso,
    ended_at: report.endedAtIso,
    calendars_ok: ok,
    calendars_failed: failed,
    events_upserted: upserted,
    failures: report.results
      .filter((r) => r.status === 'error')
      .map((r) => ({ slot: r.slot, error: r.errorMessage })),
  });
}
