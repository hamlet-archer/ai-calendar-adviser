import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarCache } from '../../cache.js';
import type { ContractEnvelope } from '../../contracts.js';
import { handleFindFreeSlot } from '../../handlers/calendar-find-free-slot.js';

// G6.5c: kelvin-only `primary` + `others` slots dropped — the agent no
// longer reads kelvin@liao.info calendars. Tests now use mkkk + staff
// for non-kelvin scheduling scenarios.
const CAL_IDS = {
  mkkk: 'mkkk-primary@google',
  'mkkk-others': 'mkkk-others@google',
  staff: 'staff@group.calendar.google.com',
} as const;

function seedEvent(cache: CalendarCache, id: string, calendarId: string, start: string, end: string) {
  cache.upsertEvent({
    id,
    calendarId,
    summary: `event ${id}`,
    startIso: start,
    endIso: end,
    tz: 'UTC',
    etag: 'etag-1',
    updatedAt: '2026-05-12T00:00:00Z',
    payloadJson: '{}',
  });
}

function ffsEnvelope(overrides: Record<string, unknown> = {}): ContractEnvelope {
  return {
    contract_id: 'calendar.find_free_slot.v1',
    trace_id: '01890000-0000-7000-8000-000000000001',
    dedupe_key: 'sha256:test',
    source_ref: 'test',
    caller_agent_id: 'test',
    participants: ['mkkk'],
    duration_min: 30,
    window: {
      start: '2026-05-12T08:00:00Z',
      end: '2026-05-12T18:00:00Z',
      tz: 'UTC',
    },
    working_hours: { start: '09:00', end: '17:00', days: [2] }, // Tuesday only (2026-05-12 is Tue)
    slots_n: 5,
    ...overrides,
  };
}

describe('handleFindFreeSlot', () => {
  let dir: string;
  let cache: CalendarCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cal-ffs-'));
    cache = new CalendarCache(join(dir, 'cal.db'));
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the unavailable envelope when participants includes kelvin (G6.5c)', () => {
    const res = handleFindFreeSlot(ffsEnvelope({ participants: ['kelvin'] }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('status' in res ? res.status : null).toBe('unavailable');
    expect('reason' in res ? res.reason : null).toBe(
      'kelvin_calendar_not_accessible_per_no_impersonation_policy',
    );
  });

  it('also returns unavailable when kelvin is one of multiple participants', () => {
    const res = handleFindFreeSlot(ffsEnvelope({ participants: ['kelvin', 'mkkk'] }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('status' in res ? res.status : null).toBe('unavailable');
  });

  it('returns the entire working-hours band as one slot when calendar is empty', () => {
    const res = handleFindFreeSlot(ffsEnvelope(), { cache, calendarIds: CAL_IDS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots[0].start).toBe('2026-05-12T09:00:00.000Z');
    // Truncated to durationMin = 30.
    expect(res.slots[0].end).toBe('2026-05-12T09:30:00.000Z');
  });

  it('skips busy intervals — slot is found in the gap after a meeting', () => {
    // Block 09:00 → 10:30 → free slot should start at 10:30
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T09:00:00Z', '2026-05-12T10:30:00Z');
    const res = handleFindFreeSlot(ffsEnvelope(), { cache, calendarIds: CAL_IDS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    expect(res.slots[0].start).toBe('2026-05-12T10:30:00.000Z');
  });

  it('honours min_break_minutes — slot does not abut the prior busy event', () => {
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T09:00:00Z', '2026-05-12T10:00:00Z');
    const res = handleFindFreeSlot(ffsEnvelope({ min_break_minutes: 15 }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    // The 10:00 event end + 15-min break pushes the earliest slot to 10:15.
    expect(res.slots[0].start).toBe('2026-05-12T10:15:00.000Z');
  });

  it('intersects multiple participants — busy on either side blocks the slot', () => {
    seedEvent(cache, 'm', CAL_IDS.mkkk, '2026-05-12T09:00:00Z', '2026-05-12T10:00:00Z');
    seedEvent(cache, 's', CAL_IDS.staff, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    const res = handleFindFreeSlot(
      ffsEnvelope({ participants: ['mkkk', 'sally'] }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    // Both calendars combined have 09:00-11:00 busy → earliest 30-min slot
    // starts at 11:00.
    expect(res.slots[0].start).toBe('2026-05-12T11:00:00.000Z');
  });

  it('returns no slots if entire working day is blocked', () => {
    // Single all-day block 09:00 → 17:00.
    seedEvent(cache, 'all', CAL_IDS.mkkk, '2026-05-12T09:00:00Z', '2026-05-12T17:00:00Z');
    const res = handleFindFreeSlot(ffsEnvelope(), { cache, calendarIds: CAL_IDS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    expect(res.slots).toEqual([]);
  });

  it('returns slots_n earliest-first, capped', () => {
    // No busy events; we should get exactly slots_n results.
    const res = handleFindFreeSlot(ffsEnvelope({ slots_n: 3 }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    expect(res.slots).toHaveLength(3);
    // Earliest-first.
    for (let i = 1; i < res.slots.length; i += 1) {
      expect(Date.parse(res.slots[i].start)).toBeGreaterThan(
        Date.parse(res.slots[i - 1].start),
      );
    }
  });

  it('rejects a window > 14 days with bad_query', () => {
    const res = handleFindFreeSlot(
      ffsEnvelope({
        window: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', tz: 'UTC' },
      }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('bad_query');
  });

  it('skips days outside working_hours.days', () => {
    // 2026-05-12 is Tuesday (weekday 2). working_hours.days = [3] → Wednesday only.
    // So no slots in this window.
    const res = handleFindFreeSlot(
      ffsEnvelope({ working_hours: { start: '09:00', end: '17:00', days: [3] } }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    expect(res.slots).toEqual([]);
  });

  it('treats ai-doer as always-free (contributes no busy time)', () => {
    seedEvent(cache, 'm', CAL_IDS.mkkk, '2026-05-12T09:00:00Z', '2026-05-12T17:00:00Z');
    const res = handleFindFreeSlot(
      ffsEnvelope({ participants: ['ai-doer'] }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected slots, got unavailable');
    // ai-doer contributes no calendars → no busy time → full working day available.
    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots[0].start).toBe('2026-05-12T09:00:00.000Z');
  });
});
