import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { calendar_v3 } from 'googleapis';
import { CalendarCache } from '../cache.js';
import { GoogleCalendarUserOauthAdapter } from '../google-calendar-user-oauth-adapter.js';
import { CALENDAR_SYNC_RATE_PER_S, runSyncCycle } from '../sync-runner.js';
import type { CalendarSlot } from '../calendar-config.js';

// G6.5c: kelvin-only slots (primary, others) deprecated; calendar set
// trimmed to the three non-kelvin shared calendars.
const CAL_IDS: Record<CalendarSlot, string> = {
  mkkk: 'cal-mkkk',
  'mkkk-others': 'cal-mkkk-others',
  staff: 'cal-staff',
};

const FROZEN_NOW = new Date('2026-05-12T09:00:00Z');
const noopSleep = (): Promise<void> => Promise.resolve();

let tmpDir: string;
let cache: CalendarCache;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-runner-'));
  cache = new CalendarCache(join(tmpDir, 'calendar.db'));
});

afterEach(() => {
  cache.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface MockListEventsCall {
  readonly calendarId: string;
  readonly syncToken?: string;
  readonly timeMin?: string;
}

function makeAdapter(opts: {
  responseFor?: (
    calendarId: string,
  ) => Promise<{
    events: ReadonlyArray<calendar_v3.Schema$Event>;
    nextSyncToken: string | null;
  }>;
  capturedCalls?: MockListEventsCall[];
}): GoogleCalendarUserOauthAdapter {
  const adapter = Object.create(
    GoogleCalendarUserOauthAdapter.prototype,
  ) as GoogleCalendarUserOauthAdapter & {
    listEvents: (o: {
      calendarId: string;
      syncToken?: string;
      timeMin?: string;
    }) => Promise<unknown>;
  };
  adapter.listEvents = (async (o) => {
    opts.capturedCalls?.push(o);
    return (
      (await opts.responseFor?.(o.calendarId)) ?? { events: [], nextSyncToken: null }
    );
  }) as unknown as (o: { calendarId: string }) => Promise<unknown>;
  return adapter;
}

function evt(
  id: string,
  startIso = '2026-05-12T09:00:00+01:00',
  endIso = '2026-05-12T09:30:00+01:00',
): calendar_v3.Schema$Event {
  return {
    id,
    summary: 'Standup',
    start: { dateTime: startIso, timeZone: 'Europe/London' },
    end: { dateTime: endIso, timeZone: 'Europe/London' },
    etag: `"etag-${id}"`,
    updated: '2026-05-12T08:55:00Z',
  };
}

describe('runSyncCycle — happy path', () => {
  it('writes one event row per upserted event into the cache', async () => {
    const adapter = makeAdapter({
      responseFor: async (calId) => {
        if (calId === 'cal-mkkk')
          return { events: [evt('a'), evt('b')], nextSyncToken: 'tok-mkkk' };
        return { events: [evt(`${calId}-x`)], nextSyncToken: `tok-${calId}` };
      },
    });
    const report = await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    expect(report.results.every((r) => r.status === 'ok')).toBe(true);
    // 3 calendars × 1 event each + 1 extra on mkkk = 4
    expect(report.results.reduce((a, r) => a + r.upserted, 0)).toBe(4);
    const got = cache.eventsForRange({
      calendars: ['cal-mkkk'],
      start: '2026-05-12T00:00:00+01:00',
      end: '2026-05-13T00:00:00+01:00',
    });
    expect(got.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('persists nextSyncToken per calendar in sync_state', async () => {
    const adapter = makeAdapter({
      responseFor: async (calId) => ({ events: [], nextSyncToken: `tok-${calId}` }),
    });
    await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    expect(cache.getSyncState('cal-mkkk')?.syncToken).toBe('tok-cal-mkkk');
    expect(cache.getSyncState('cal-mkkk-others')?.syncToken).toBe('tok-cal-mkkk-others');
  });

  it('drops events with no id, no start, or no end', async () => {
    const adapter = makeAdapter({
      responseFor: async () => ({
        events: [
          evt('keeper'),
          { id: undefined, summary: 'no-id' } as calendar_v3.Schema$Event,
          { id: 'no-bounds' } as calendar_v3.Schema$Event,
        ],
        nextSyncToken: null,
      }),
    });
    const report = await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    const mkkk = report.results.find((r) => r.slot === 'mkkk')!;
    expect(mkkk.upserted).toBe(1);
  });
});

describe('runSyncCycle — incremental sync', () => {
  it('passes syncToken when prior state exists; passes timeMin when it does not', async () => {
    cache.setSyncState('cal-mkkk', 'existing-tok', '2026-05-11T09:00:00Z');
    const captured: MockListEventsCall[] = [];
    const adapter = makeAdapter({
      capturedCalls: captured,
      responseFor: async () => ({ events: [], nextSyncToken: 'new-tok' }),
    });
    await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    const mkkkCall = captured.find((c) => c.calendarId === 'cal-mkkk')!;
    expect(mkkkCall.syncToken).toBe('existing-tok');
    expect(mkkkCall.timeMin).toBeUndefined();
    const staffCall = captured.find((c) => c.calendarId === 'cal-staff')!;
    expect(staffCall.syncToken).toBeUndefined();
    expect(staffCall.timeMin).toBe(
      new Date(FROZEN_NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });
});

describe('runSyncCycle — AP-2 per-calendar isolation', () => {
  it('a single-calendar throw does not abort the other calendars', async () => {
    const adapter = makeAdapter({
      responseFor: async (calId) => {
        if (calId === 'cal-mkkk-others') throw new Error('quota exceeded');
        return { events: [evt(`${calId}-x`)], nextSyncToken: `tok-${calId}` };
      },
    });
    const report = await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    const mkkkOthers = report.results.find((r) => r.slot === 'mkkk-others')!;
    expect(mkkkOthers.status).toBe('error');
    expect(mkkkOthers.errorMessage).toBe('quota exceeded');
    const ok = report.results.filter((r) => r.status === 'ok');
    expect(ok.map((r) => r.slot).sort()).toEqual(['mkkk', 'staff']);
  });

  it('a failing calendar does not corrupt its prior sync_state', async () => {
    cache.setSyncState('cal-mkkk-others', 'prior-tok', '2026-05-11T09:00:00Z');
    const adapter = makeAdapter({
      responseFor: async (calId) => {
        if (calId === 'cal-mkkk-others') throw new Error('boom');
        return { events: [], nextSyncToken: null };
      },
    });
    await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    expect(cache.getSyncState('cal-mkkk-others')?.syncToken).toBe('prior-tok');
  });
});

describe('runSyncCycle — pacing', () => {
  it('sleeps between calendars at the CALENDAR_SYNC_RATE_PER_S cap', async () => {
    const sleepCalls: number[] = [];
    const adapter = makeAdapter({
      responseFor: async () => ({ events: [], nextSyncToken: null }),
    });
    await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    // 3 calendars → 2 spacings between them.
    expect(sleepCalls).toHaveLength(2);
    const expectedMs = Math.ceil(1000 / CALENDAR_SYNC_RATE_PER_S);
    expect(sleepCalls.every((ms) => ms === expectedMs)).toBe(true);
  });
});

describe('runSyncCycle — round-trip across re-runs', () => {
  it('second run resumes from the persisted syncToken', async () => {
    const captured: MockListEventsCall[] = [];
    const adapter = makeAdapter({
      capturedCalls: captured,
      responseFor: async () => ({ events: [evt('x')], nextSyncToken: 'tok-after' }),
    });
    await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    captured.length = 0;
    await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    for (const slot of ['mkkk', 'mkkk-others', 'staff'] as const) {
      const call = captured.find((c) => c.calendarId === CAL_IDS[slot])!;
      expect(call.syncToken).toBe('tok-after');
    }
  });
});

describe('runSyncCycle — report shape', () => {
  it('renders started/ended timestamps + per-calendar status', async () => {
    const calls = vi.fn();
    const adapter = makeAdapter({
      responseFor: async () => {
        calls();
        return { events: [], nextSyncToken: null };
      },
    });
    const report = await runSyncCycle({
      adapter,
      cache,
      calendarIds: CAL_IDS,
      now: () => FROZEN_NOW,
      sleep: noopSleep,
    });
    expect(report.startedAtIso).toBe(FROZEN_NOW.toISOString());
    expect(report.endedAtIso).toBe(FROZEN_NOW.toISOString());
    expect(report.results.map((r) => r.slot)).toEqual(['mkkk', 'mkkk-others', 'staff']);
    expect(calls).toHaveBeenCalledTimes(3);
  });
});
