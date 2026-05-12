import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalendarCache, type EventRow } from '../cache.js';

let tmpDir: string;
let dbPath: string;
let cache: CalendarCache;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'calendar-cache-'));
  dbPath = join(tmpDir, 'calendar.db');
  cache = new CalendarCache(dbPath);
});

afterEach(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function fixtureEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 'evt-1',
    calendarId: 'cal-A',
    summary: 'Standup',
    startIso: '2026-05-12T09:00:00+01:00',
    endIso: '2026-05-12T09:30:00+01:00',
    tz: 'Europe/London',
    etag: '"etag-1"',
    updatedAt: '2026-05-12T08:55:00+01:00',
    payloadJson: '{}',
    ...overrides,
  };
}

const DAY_START = '2026-05-12T00:00:00+01:00';
const DAY_END = '2026-05-13T00:00:00+01:00';

describe('CalendarCache.events', () => {
  it('round-trips a single event', () => {
    const evt = fixtureEvent();
    cache.upsertEvent(evt);
    const got = cache.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(evt);
  });

  it('filters by calendar id', () => {
    cache.upsertEvent(fixtureEvent({ id: 'a', calendarId: 'cal-A' }));
    cache.upsertEvent(fixtureEvent({ id: 'b', calendarId: 'cal-B' }));
    const got = cache.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END });
    expect(got.map((e) => e.id)).toEqual(['a']);
  });

  it('returns events from every requested calendar', () => {
    cache.upsertEvent(fixtureEvent({ id: 'a', calendarId: 'cal-A' }));
    cache.upsertEvent(fixtureEvent({ id: 'b', calendarId: 'cal-B' }));
    cache.upsertEvent(fixtureEvent({ id: 'c', calendarId: 'cal-C' }));
    const got = cache.eventsForRange({
      calendars: ['cal-A', 'cal-C'],
      start: DAY_START,
      end: DAY_END,
    });
    expect(got.map((e) => e.id).sort()).toEqual(['a', 'c']);
  });

  it('range is inclusive-start, exclusive-end', () => {
    cache.upsertEvent(fixtureEvent({ id: 'pre', startIso: '2026-05-11T23:59:00+01:00' }));
    cache.upsertEvent(fixtureEvent({ id: 'on-start', startIso: '2026-05-12T00:00:00+01:00' }));
    cache.upsertEvent(fixtureEvent({ id: 'on-end', startIso: '2026-05-13T00:00:00+01:00' }));
    const got = cache.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END });
    expect(got.map((e) => e.id)).toEqual(['on-start']);
  });

  it('orders by start_iso ascending', () => {
    cache.upsertEvent(fixtureEvent({ id: 'later', startIso: '2026-05-12T11:00:00+01:00' }));
    cache.upsertEvent(fixtureEvent({ id: 'earlier', startIso: '2026-05-12T08:00:00+01:00' }));
    const got = cache.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END });
    expect(got.map((e) => e.id)).toEqual(['earlier', 'later']);
  });

  it('returns [] when calendars is empty', () => {
    cache.upsertEvent(fixtureEvent());
    expect(cache.eventsForRange({ calendars: [], start: DAY_START, end: DAY_END })).toEqual([]);
  });

  it('upserts replace by primary key id', () => {
    cache.upsertEvent(fixtureEvent({ summary: 'Standup' }));
    cache.upsertEvent(fixtureEvent({ summary: 'Standup (updated)', etag: '"etag-2"' }));
    const got = cache.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END });
    expect(got).toHaveLength(1);
    expect(got[0]?.summary).toBe('Standup (updated)');
    expect(got[0]?.etag).toBe('"etag-2"');
  });

  it('preserves null summary + null etag', () => {
    cache.upsertEvent(fixtureEvent({ summary: null, etag: null }));
    const got = cache.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END });
    expect(got[0]?.summary).toBeNull();
    expect(got[0]?.etag).toBeNull();
  });
});

describe('CalendarCache.syncState', () => {
  it('returns null for an unknown calendar', () => {
    expect(cache.getSyncState('unknown-cal')).toBeNull();
  });

  it('upserts and round-trips sync state', () => {
    cache.setSyncState('cal-A', 'token-1', '2026-05-12T09:00:00+01:00');
    expect(cache.getSyncState('cal-A')).toEqual({
      calendarId: 'cal-A',
      syncToken: 'token-1',
      lastSyncIso: '2026-05-12T09:00:00+01:00',
    });
  });

  it('upserts replace an existing token + timestamp', () => {
    cache.setSyncState('cal-A', 'token-1', '2026-05-12T09:00:00+01:00');
    cache.setSyncState('cal-A', 'token-2', '2026-05-12T09:15:00+01:00');
    const state = cache.getSyncState('cal-A');
    expect(state?.syncToken).toBe('token-2');
    expect(state?.lastSyncIso).toBe('2026-05-12T09:15:00+01:00');
  });

  it('null sync_token is round-trippable (initial-fetch sentinel)', () => {
    cache.setSyncState('cal-A', null, '2026-05-12T09:00:00+01:00');
    expect(cache.getSyncState('cal-A')?.syncToken).toBeNull();
  });

  it('per-calendar state is isolated', () => {
    cache.setSyncState('cal-A', 'token-A', '2026-05-12T09:00:00+01:00');
    cache.setSyncState('cal-B', 'token-B', '2026-05-12T09:05:00+01:00');
    expect(cache.getSyncState('cal-A')?.syncToken).toBe('token-A');
    expect(cache.getSyncState('cal-B')?.syncToken).toBe('token-B');
  });
});

describe('CalendarCache.schema', () => {
  it('reopening an existing DB does not error and preserves rows', () => {
    cache.upsertEvent(fixtureEvent());
    cache.setSyncState('cal-A', 'token-1', '2026-05-12T09:00:00+01:00');
    cache.close();

    const cache2 = new CalendarCache(dbPath);
    expect(
      cache2.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END }),
    ).toHaveLength(1);
    expect(cache2.getSyncState('cal-A')?.syncToken).toBe('token-1');
    cache2.close();
    // Reassign so afterEach's close() is a no-op on the already-closed handle.
    cache = new CalendarCache(dbPath);
  });

  it('creates a fresh DB file at the configured path', () => {
    // The constructor in beforeEach already created dbPath; opening a second
    // path inside the same tmp dir exercises the mkdir / chmod branches.
    const second = new CalendarCache(join(tmpDir, 'nested/other.db'));
    second.upsertEvent(fixtureEvent({ id: 'evt-other' }));
    expect(
      second.eventsForRange({ calendars: ['cal-A'], start: DAY_START, end: DAY_END }),
    ).toHaveLength(1);
    second.close();
  });
});
