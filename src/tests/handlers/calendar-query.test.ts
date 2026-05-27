import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CalendarCache } from '../../cache.js';
import type { ContractEnvelope } from '../../contracts.js';
import { handleCalendarQuery } from '../../handlers/calendar-query.js';

// G6.5c: kelvin-only `primary` + `others` slots dropped — the agent no
// longer reads kelvin@liao.info calendars.
const CAL_IDS = {
  mkkk: 'mkkk-primary@google',
  'mkkk-others': 'mkkk-others@google',
  staff: 'staff@group.calendar.google.com',
} as const;

function seedEvent(
  cache: CalendarCache,
  id: string,
  calendarId: string,
  start: string,
  end: string,
) {
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
    person: 'mkkk',
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

  it('returns the unavailable envelope for person=kelvin (G6.5c — no impersonation)', () => {
    const res = handleCalendarQuery(queryEnvelope({ person: 'kelvin' }), {
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

  it('returns the unavailable envelope when explicit calendars include calendar.primary', () => {
    const res = handleCalendarQuery(
      queryEnvelope({ person: 'mkkk', calendars: ['calendar.primary'] }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('status' in res ? res.status : null).toBe('unavailable');
  });

  it('returns the unavailable envelope when explicit calendars include calendar.others', () => {
    const res = handleCalendarQuery(
      queryEnvelope({ person: 'mkkk', calendars: ['calendar.others'] }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('status' in res ? res.status : null).toBe('unavailable');
  });

  it('routes mkkk to mkkk + mkkk-others', () => {
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T12:00:00Z', '2026-05-12T13:00:00Z');
    seedEvent(cache, 'mo1', CAL_IDS['mkkk-others'], '2026-05-12T15:00:00Z', '2026-05-12T16:00:00Z');

    const res = handleCalendarQuery(queryEnvelope({ person: 'mkkk' }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected events response, got unavailable');
    expect(res.events.map((e) => e.id).sort()).toEqual(['m1', 'mo1']);
  });

  it('returns empty events for ai-doer (always-free, no calendar)', () => {
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    const res = handleCalendarQuery(queryEnvelope({ person: 'ai-doer' }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected events response, got unavailable');
    expect(res.events).toEqual([]);
    expect(res.queried_calendars).toEqual([]);
  });

  it('respects an explicit non-kelvin calendars override (staff.schedules)', () => {
    seedEvent(cache, 's1', CAL_IDS.staff, '2026-05-12T10:00:00Z', '2026-05-12T11:00:00Z');
    seedEvent(cache, 'm1', CAL_IDS.mkkk, '2026-05-12T14:00:00Z', '2026-05-12T15:00:00Z');

    const res = handleCalendarQuery(
      queryEnvelope({ person: 'sally', calendars: ['staff.schedules'] }),
      { cache, calendarIds: CAL_IDS },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected events response, got unavailable');
    expect(res.events.map((e) => e.id)).toEqual(['s1']);
  });

  it('reports truncated when results exceed limit', () => {
    for (let i = 0; i < 5; i += 1) {
      seedEvent(cache, `e${i}`, CAL_IDS.mkkk, `2026-05-12T1${i}:00:00Z`, `2026-05-12T1${i}:30:00Z`);
    }
    const res = handleCalendarQuery(queryEnvelope({ person: 'mkkk', limit: 2 }), {
      cache,
      calendarIds: CAL_IDS,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    if ('status' in res) throw new Error('expected events response, got unavailable');
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
