import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarCache } from '../../cache.js';
import type { ContractEnvelope } from '../../contracts.js';
import { handleCalendarQuery } from '../../handlers/calendar-query.js';

const CAL_IDS = {
  primary: 'kelvin-primary@google',
  mkkk: 'mkkk-primary@google',
  others: 'kelvin-others@google',
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

function queryEnvelope(overrides: Record<string, unknown> = {}): ContractEnvelope {
  return {
    contract_id: 'calendar.query.v1',
    trace_id: '01890000-0000-7000-8000-000000000000',
    dedupe_key: 'sha256:test',
    source_ref: 'test',
    caller_agent_id: 'test',
    person: 'kelvin',
    window: {
      start: '2026-05-12T09:00:00Z',
      end: '2026-05-12T17:00:00Z',
      tz: 'UTC',
    },
    ...overrides,
  };
}

describe('handleCalendarQuery', () => {
  let dir: string;
  let cache: CalendarCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cal-q-'));
    cache = new CalendarCache(join(dir, 'cal.db'));
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns events for kelvin from primary + others', () => {
    seedEvent(cache, 'p1', CAL_IDS.primary, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    seedEvent(cache, 'o1', CAL_IDS.others, '2026-05-12T14:00:00Z', '2026-05-12T15:00:00Z');
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T12:00:00Z', '2026-05-12T13:00:00Z');

    const res = handleCalendarQuery(queryEnvelope(), { cache, calendarIds: CAL_IDS });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.events.map((e) => e.id).sort();
    expect(ids).toEqual(['o1', 'p1']);
    expect(res.queried_calendars.sort()).toEqual([CAL_IDS.others, CAL_IDS.primary].sort());
  });

  it('routes mkkk to mkkk + mkkk-others', () => {
    seedEvent(cache, 'p1', CAL_IDS.primary, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T12:00:00Z', '2026-05-12T13:00:00Z');
    seedEvent(cache, 'mo1', CAL_IDS['mkkk-others'], '2026-05-12T15:00:00Z', '2026-05-12T16:00:00Z');

    const res = handleCalendarQuery(queryEnvelope({ person: 'mkkk' }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.map((e) => e.id).sort()).toEqual(['m1', 'mo1']);
  });

  it('returns empty events for ai-doer (always-free, no calendar)', () => {
    seedEvent(cache, 'p1', CAL_IDS.primary, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    const res = handleCalendarQuery(queryEnvelope({ person: 'ai-doer' }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toEqual([]);
    expect(res.queried_calendars).toEqual([]);
  });

  it('respects an explicit calendars override', () => {
    seedEvent(cache, 'p1', CAL_IDS.primary, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    seedEvent(cache, 'o1', CAL_IDS.others, '2026-05-12T14:00:00Z', '2026-05-12T15:00:00Z');

    const res = handleCalendarQuery(
      queryEnvelope({ calendars: ['calendar.primary'] }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.map((e) => e.id)).toEqual(['p1']);
  });

  it('reports truncated when results exceed limit', () => {
    for (let i = 0; i < 5; i += 1) {
      seedEvent(
        cache,
        `e${i}`,
        CAL_IDS.primary,
        `2026-05-12T1${i}:00:00Z`,
        `2026-05-12T1${i}:30:00Z`,
      );
    }
    const res = handleCalendarQuery(queryEnvelope({ limit: 2 }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('rejects an inverted window with bad_query', () => {
    const res = handleCalendarQuery(
      queryEnvelope({
        window: { start: '2026-05-12T17:00:00Z', end: '2026-05-12T09:00:00Z', tz: 'UTC' },
      }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('bad_query');
  });

  it('rejects a window > 31 days', () => {
    const res = handleCalendarQuery(
      queryEnvelope({
        window: { start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z', tz: 'UTC' },
      }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('bad_query');
  });
});
