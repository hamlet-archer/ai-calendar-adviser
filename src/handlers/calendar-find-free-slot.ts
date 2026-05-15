/**
 * Handler for `calendar.find_free_slot.v1` — finds slots of >= duration_min
 * minutes where every named participant is free, within the window,
 * obeying working-hours + min-break constraints.
 *
 * Algorithm:
 *   1. Resolve each participant to their calendar set (per `person-calendar-map.ts`).
 *      ai-doer contributes no busy time (always-free, no calendar).
 *   2. Pull every event in the window from each contributing calendar.
 *   3. Build a flat busy-interval list, merge overlapping intervals.
 *   4. Expand `min_break_minutes` around each busy interval — busy + break
 *      is treated as one interval.
 *   5. Walk the working-hours mask (per `working_hours.days` weekdays + the
 *      `working_hours.start`/`end` band): for each working-hours window,
 *      subtract the busy intervals → the gaps are free slots.
 *   6. Filter to gaps >= duration_min, slice the first `slots_n`
 *      earliest-first.
 *
 * Times are interpreted in `window.tz` (IANA zone). Working-hours band
 * comparisons use the wall-clock time in that zone via `Intl.DateTimeFormat`.
 *
 * Read-only. Does NOT book or hold the returned slots.
 */

import type { CalendarSlot } from '../calendar-config.js';
import type { CalendarCache, EventRow } from '../cache.js';
import type { ContractEnvelope } from '../contracts.js';
import type { Person } from '../person-calendar-map.js';
import { resolveCalendarIds, slotsForPerson } from '../person-calendar-map.js';
import type { HandlerError } from './calendar-query.js';

export interface CalendarFindFreeSlotDeps {
  readonly cache: CalendarCache;
  readonly calendarIds: Record<CalendarSlot, string>;
}

export interface FindFreeSlotResponse {
  readonly ok: true;
  readonly contract_id: 'calendar.find_free_slot.v1';
  readonly trace_id: string;
  readonly slots: ReadonlyArray<{
    readonly start: string;
    readonly end: string;
    readonly tz: string;
  }>;
}

/**
 * G6.5c: kelvin@-bound participants resolve to a documented unavailable
 * envelope — same shape as the calendar-query handler. Per
 * `feedback_no_kelvin_account_impersonation`, the agent no longer reads
 * Kelvin's calendars at all.
 */
export interface FindFreeSlotUnavailable {
  readonly ok: true;
  readonly contract_id: 'calendar.find_free_slot.v1';
  readonly trace_id: string;
  readonly status: 'unavailable';
  readonly reason: 'kelvin_calendar_not_accessible_per_no_impersonation_policy';
}

// Per contract: max 14-day search window.
const MAX_SEARCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

interface Interval {
  startMs: number;
  endMs: number;
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cur.endMs);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * Wall-clock parts of a UTC instant rendered in `tz`. Returns numeric
 * weekday (0=Sunday..6=Saturday), hour, minute. Implementation uses
 * `Intl.DateTimeFormat` parts which always renders in the target zone.
 */
function wallClockInTz(
  instantMs: number,
  tz: string,
): { weekday: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  let weekdayStr = '';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekdayStr = p.value;
    else if (p.type === 'hour') hour = parseInt(p.value, 10) % 24;
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { weekday: weekdayMap[weekdayStr] ?? 0, hour, minute };
}

interface WorkingHours {
  readonly startHour: number;
  readonly startMinute: number;
  readonly endHour: number;
  readonly endMinute: number;
  readonly days: readonly number[];
}

function parseWorkingHours(
  envelope: ContractEnvelope,
): WorkingHours {
  const wh = envelope.working_hours as
    | { start: string; end: string; days?: readonly number[] }
    | undefined;
  if (!wh) {
    // No constraint → 00:00 → 24:00, all days.
    return {
      startHour: 0,
      startMinute: 0,
      endHour: 24,
      endMinute: 0,
      days: [0, 1, 2, 3, 4, 5, 6],
    };
  }
  const [sh, sm] = wh.start.split(':').map((x) => parseInt(x, 10));
  const [eh, em] = wh.end.split(':').map((x) => parseInt(x, 10));
  return {
    startHour: sh,
    startMinute: sm,
    endHour: eh,
    endMinute: em,
    days: wh.days ?? [1, 2, 3, 4, 5],
  };
}

/**
 * Iterates through every day in the half-open `[windowStart, windowEnd)`
 * range, and for each working day yields the `[workingStart, workingEnd]`
 * UTC instants. Tz-aware: hour/day comparisons use the wall-clock in `tz`.
 *
 * Implementation note: rather than constructing zoned instants directly
 * (which Node doesn't expose), we step in 15-minute UTC increments and
 * check the wall-clock in `tz`. Coarse, but simple + correct, and the
 * search window is bounded to 14 days = 1344 steps.
 */
function workingHourBands(
  windowStartMs: number,
  windowEndMs: number,
  wh: WorkingHours,
  tz: string,
): Interval[] {
  const bands: Interval[] = [];
  // Scan in 5-min UTC steps (12 / hour). Track when we enter and leave a
  // working-hours band. The cost is bounded: 14 days × 24 × 12 = 4032 ticks.
  const TICK = 5 * 60 * 1000;
  let cursor = windowStartMs;
  let inBand = false;
  let bandStart = 0;
  while (cursor < windowEndMs) {
    const wc = wallClockInTz(cursor, tz);
    const dayOk = wh.days.includes(wc.weekday);
    const minute = wc.hour * 60 + wc.minute;
    const startMin = wh.startHour * 60 + wh.startMinute;
    const endMin = wh.endHour * 60 + wh.endMinute;
    const inHours = minute >= startMin && minute < endMin;
    const want = dayOk && inHours;
    if (want && !inBand) {
      inBand = true;
      bandStart = cursor;
    } else if (!want && inBand) {
      inBand = false;
      bands.push({ startMs: bandStart, endMs: cursor });
    }
    cursor += TICK;
  }
  if (inBand) {
    bands.push({ startMs: bandStart, endMs: windowEndMs });
  }
  return bands;
}

function subtractBusyFromBand(
  band: Interval,
  busy: readonly Interval[],
): Interval[] {
  // Iterate busy intervals overlapping the band; the gaps are free.
  const free: Interval[] = [];
  let cursor = band.startMs;
  for (const b of busy) {
    if (b.endMs <= band.startMs) continue;
    if (b.startMs >= band.endMs) break;
    if (b.startMs > cursor) {
      free.push({ startMs: cursor, endMs: Math.min(b.startMs, band.endMs) });
    }
    cursor = Math.max(cursor, b.endMs);
    if (cursor >= band.endMs) break;
  }
  if (cursor < band.endMs) {
    free.push({ startMs: cursor, endMs: band.endMs });
  }
  return free;
}

function eventToInterval(ev: EventRow): Interval | null {
  const startMs = Date.parse(ev.startIso);
  const endMs = Date.parse(ev.endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;
  return { startMs, endMs };
}

export function handleFindFreeSlot(
  envelope: ContractEnvelope,
  deps: CalendarFindFreeSlotDeps,
): FindFreeSlotResponse | FindFreeSlotUnavailable | HandlerError {
  const window = envelope.window as { start: string; end: string; tz: string };
  const windowStartMs = Date.parse(window.start);
  const windowEndMs = Date.parse(window.end);
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs) ||
    windowEndMs <= windowStartMs
  ) {
    return { ok: false, code: 'bad_query', message: 'window.end must be > window.start' };
  }
  if (windowEndMs - windowStartMs > MAX_SEARCH_WINDOW_MS) {
    return { ok: false, code: 'bad_query', message: 'window span exceeds 14 days' };
  }

  const participantsRaw = envelope.participants as readonly string[];
  // G6.5c: any kelvin participant resolves to a documented unavailable
  // envelope (per `feedback_no_kelvin_account_impersonation`). We refuse
  // to compute a partial-availability slot list with Kelvin silently
  // omitted — that would let a caller schedule over Kelvin without ever
  // seeing his calendar.
  if (participantsRaw.includes('kelvin')) {
    return {
      ok: true,
      contract_id: 'calendar.find_free_slot.v1',
      trace_id: envelope.trace_id,
      status: 'unavailable',
      reason: 'kelvin_calendar_not_accessible_per_no_impersonation_policy',
    };
  }
  const participants = participantsRaw as readonly Person[];
  const durationMin = envelope.duration_min as number;
  const durationMs = durationMin * 60 * 1000;
  const minBreakMin = (envelope.min_break_minutes as number | undefined) ?? 0;
  const minBreakMs = minBreakMin * 60 * 1000;
  const slotsN = (envelope.slots_n as number | undefined) ?? 5;
  const wh = parseWorkingHours(envelope);

  // 1. Collect busy intervals from every participant's calendars.
  const calendarIdSet = new Set<string>();
  for (const p of participants) {
    const ids = resolveCalendarIds(slotsForPerson(p), deps.calendarIds);
    for (const id of ids) calendarIdSet.add(id);
  }
  const calendarIds = [...calendarIdSet];

  let rows: EventRow[] = [];
  if (calendarIds.length > 0) {
    rows = deps.cache.eventsForRange({
      calendars: calendarIds,
      start: window.start,
      end: window.end,
    });
  }
  const rawIntervals: Interval[] = [];
  for (const r of rows) {
    const iv = eventToInterval(r);
    if (iv) rawIntervals.push(iv);
  }
  // Expand by min_break_minutes both sides; merging then collapses overlaps.
  const padded: Interval[] = rawIntervals.map((iv) => ({
    startMs: iv.startMs - minBreakMs,
    endMs: iv.endMs + minBreakMs,
  }));
  const busy = mergeIntervals(padded);

  // 2. Compute working-hours bands.
  const bands = workingHourBands(windowStartMs, windowEndMs, wh, window.tz);

  // 3. For each band, subtract busy → free intervals → tile each gap with
  // back-to-back `durationMin` slots. Each emitted slot is canonical-length
  // (caller anchors here; a longer gap is reported as multiple slots so
  // `slots_n` is meaningful even on an empty calendar).
  const freeSlots: Interval[] = [];
  outer: for (const band of bands) {
    const gaps = subtractBusyFromBand(band, busy);
    for (const gap of gaps) {
      let anchor = gap.startMs;
      while (anchor + durationMs <= gap.endMs) {
        freeSlots.push({ startMs: anchor, endMs: anchor + durationMs });
        if (freeSlots.length >= slotsN) break outer;
        anchor += durationMs;
      }
    }
  }

  return {
    ok: true,
    contract_id: 'calendar.find_free_slot.v1',
    trace_id: envelope.trace_id,
    slots: freeSlots.slice(0, slotsN).map((iv) => ({
      start: new Date(iv.startMs).toISOString(),
      end: new Date(iv.endMs).toISOString(),
      tz: window.tz,
    })),
  };
}
