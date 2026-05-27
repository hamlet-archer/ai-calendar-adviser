/**
 * Handler for `calendar.query.v1` — returns events from the local cache,
 * filtered by the per-person calendar set + window. Read-only.
 *
 * Response shape (not contract-schema-validated; we own this side):
 *   { contract_id: 'calendar.query.v1', trace_id, events: [...], truncated, queried_calendars }
 *
 * Per-event row matches the cache's `EventRow` projected to a stable shape:
 *   { id, calendar_id, summary, start, end, tz, etag }
 *
 * Errors are returned as `{ ok: false, code, message }` rather than thrown
 * — the RPC server serialises both forms back to the caller.
 */

import type { CalendarCache } from '../cache.js';
import type { CalendarSlot } from '../calendar-config.js';
import type { ContractEnvelope } from '../contracts.js';
import type { Person } from '../person-calendar-map.js';
import { resolveCalendarIds, slotsForPerson } from '../person-calendar-map.js';

export interface CalendarQueryDeps {
  readonly cache: CalendarCache;
  readonly calendarIds: Record<CalendarSlot, string>;
}

export interface CalendarQueryResponse {
  readonly ok: true;
  readonly contract_id: 'calendar.query.v1';
  readonly trace_id: string;
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly calendar_id: string;
    readonly summary: string | null;
    readonly start: string;
    readonly end: string;
    readonly tz: string;
    readonly etag: string | null;
  }>;
  readonly truncated: boolean;
  readonly queried_calendars: readonly string[];
}

export interface HandlerError {
  readonly ok: false;
  readonly code: 'bad_query' | 'internal_error';
  readonly message: string;
}

/**
 * Documented `unavailable` envelope for queries that resolve to Kelvin's
 * calendars. Per G6.5c (2026-05-15) the agent no longer reads Kelvin's
 * calendars via service-account or per-user OAuth — see
 * `feedback_no_kelvin_account_impersonation`. The envelope lets callers
 * degrade gracefully (per AP-1) without fabricating availability.
 */
export interface CalendarQueryUnavailable {
  readonly ok: true;
  readonly contract_id: 'calendar.query.v1';
  readonly trace_id: string;
  readonly status: 'unavailable';
  readonly reason: 'kelvin_calendar_not_accessible_per_no_impersonation_policy';
}

function unavailableEnvelope(traceId: string): CalendarQueryUnavailable {
  return {
    ok: true,
    contract_id: 'calendar.query.v1',
    trace_id: traceId,
    status: 'unavailable',
    reason: 'kelvin_calendar_not_accessible_per_no_impersonation_policy',
  };
}

const KELVIN_ONLY_CALENDAR_SLOTS = new Set(['calendar.primary', 'calendar.others']);

// Per contract: max 31-day span. Wider windows return `bad_query`.
const MAX_QUERY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export function handleCalendarQuery(
  envelope: ContractEnvelope,
  deps: CalendarQueryDeps,
): CalendarQueryResponse | CalendarQueryUnavailable | HandlerError {
  const window = envelope.window as { start: string; end: string; tz: string };
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, code: 'bad_query', message: 'window.end must be > window.start' };
  }
  if (endMs - startMs > MAX_QUERY_WINDOW_MS) {
    return { ok: false, code: 'bad_query', message: 'window span exceeds 31 days' };
  }

  const personRaw = envelope.person as string;
  const explicitCalendars = envelope.calendars as readonly string[] | undefined;
  const limit = (envelope.limit as number | undefined) ?? 100;

  // G6.5c: kelvin@-bound requests resolve to a documented unavailable
  // envelope. Two paths reach it — `person: 'kelvin'` and the explicit
  // `calendar.primary` / `calendar.others` slot ids (still in the v1
  // contract enum). Both are kelvin-only surfaces the agent no longer
  // authenticates against.
  if (personRaw === 'kelvin') {
    return unavailableEnvelope(envelope.trace_id);
  }
  if (explicitCalendars && explicitCalendars.some((s) => KELVIN_ONLY_CALENDAR_SLOTS.has(s))) {
    return unavailableEnvelope(envelope.trace_id);
  }

  const person = personRaw as Person;

  // Resolve calendar ids: explicit override > per-person default. The
  // contract enum's domain strings translate to typed slots here; `staff`
  // is a real calendar (no more composed-view skip).
  let queryIds: readonly string[];
  if (explicitCalendars && explicitCalendars.length > 0) {
    const mapped: string[] = [];
    for (const slot of explicitCalendars) {
      if (slot === 'calendar.mkkk') mapped.push(deps.calendarIds.mkkk);
      else if (slot === 'calendar.mkkk-others') mapped.push(deps.calendarIds['mkkk-others']);
      else if (slot === 'staff.schedules') mapped.push(deps.calendarIds.staff);
      // calendar.primary / calendar.others are handled above (unavailable envelope).
    }
    queryIds = mapped;
  } else {
    queryIds = resolveCalendarIds(slotsForPerson(person), deps.calendarIds);
  }

  const rows =
    queryIds.length === 0
      ? []
      : deps.cache.eventsForRange({
          calendars: queryIds,
          start: window.start,
          end: window.end,
        });

  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;

  return {
    ok: true,
    contract_id: 'calendar.query.v1',
    trace_id: envelope.trace_id,
    events: sliced.map((r) => ({
      id: r.id,
      calendar_id: r.calendarId,
      summary: r.summary,
      start: r.startIso,
      end: r.endIso,
      tz: r.tz,
      etag: r.etag,
    })),
    truncated,
    queried_calendars: queryIds,
  };
}
