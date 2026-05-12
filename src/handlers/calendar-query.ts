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

import type { CalendarSlot } from '../calendar-config.js';
import type { CalendarCache } from '../cache.js';
import type { ContractEnvelope } from '../contracts.js';
import type { Person } from '../person-calendar-map.js';
import { domainsForPerson, resolveCalendarIds } from '../person-calendar-map.js';

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

// Per contract: max 31-day span. Wider windows return `bad_query`.
const MAX_QUERY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export function handleCalendarQuery(
  envelope: ContractEnvelope,
  deps: CalendarQueryDeps,
): CalendarQueryResponse | HandlerError {
  const window = envelope.window as { start: string; end: string; tz: string };
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, code: 'bad_query', message: 'window.end must be > window.start' };
  }
  if (endMs - startMs > MAX_QUERY_WINDOW_MS) {
    return { ok: false, code: 'bad_query', message: 'window span exceeds 31 days' };
  }

  const person = envelope.person as Person;
  const explicitCalendars = envelope.calendars as readonly string[] | undefined;
  const limit = (envelope.limit as number | undefined) ?? 100;

  // Resolve calendar ids: explicit override > per-person default.
  let queryIds: readonly string[];
  if (explicitCalendars && explicitCalendars.length > 0) {
    // The explicit override carries domain slot ids (per the enum); resolve
    // them through the same calendarIds map. `staff.schedules` collapses to
    // empty until the composed view ships.
    const mapped: string[] = [];
    for (const slot of explicitCalendars) {
      if (slot === 'staff.schedules') continue;
      if (slot === 'calendar.primary') mapped.push(deps.calendarIds.primary);
      else if (slot === 'calendar.mkkk') mapped.push(deps.calendarIds.mkkk);
      else if (slot === 'calendar.others') mapped.push(deps.calendarIds.others);
      else if (slot === 'calendar.mkkk-others') mapped.push(deps.calendarIds['mkkk-others']);
    }
    queryIds = mapped;
  } else {
    queryIds = resolveCalendarIds(domainsForPerson(person), deps.calendarIds);
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
