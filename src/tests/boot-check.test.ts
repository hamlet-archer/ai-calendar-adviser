import { describe, expect, it, vi } from 'vitest';

import { BootCheckError, runBootCheck } from '../boot-check.js';
import { GoogleCalendarUserOauthAdapter } from '../google-calendar-user-oauth-adapter.js';

// G6.5c: kelvin-only slots (primary, others) deprecated; the remaining
// three are non-kelvin shared calendars reachable from ai@liao.info.
const VALID_ENV = {
  CALENDAR_ID_MKKK: 'cal-mkkk',
  CALENDAR_ID_MKKK_OTHERS: 'cal-mkkk-others',
  CALENDAR_ID_STAFF: 'cal-staff',
};

function adapterFromMocks(opts: {
  listCalendars?: () => Promise<Array<{ id: string }>>;
  listEvents?: (id: string) => Promise<void>;
}): GoogleCalendarUserOauthAdapter {
  const listCalendars =
    opts.listCalendars ??
    (async () => [{ id: 'cal-mkkk' }, { id: 'cal-mkkk-others' }, { id: 'cal-staff' }]);
  const listEvents = opts.listEvents ?? (async () => undefined);
  // Cast — we don't construct a real calendar_v3.Calendar; we hand the
  // adapter exactly the surface the boot-check uses.
  const adapter = Object.create(
    GoogleCalendarUserOauthAdapter.prototype,
  ) as GoogleCalendarUserOauthAdapter & {
    listCalendars: () => Promise<unknown>;
    listEvents: (opts: { calendarId: string }) => Promise<unknown>;
  };
  adapter.listCalendars = listCalendars;
  adapter.listEvents = async (o: { calendarId: string }) => {
    await listEvents(o.calendarId);
    return { events: [], nextSyncToken: null };
  };
  return adapter;
}

describe('runBootCheck — happy path', () => {
  it('returns the validated id map + adapter when all slots resolve', async () => {
    const adapter = adapterFromMocks({});
    const { calendarIds } = await runBootCheck({ adapter, env: VALID_ENV });
    expect(calendarIds.mkkk).toBe('cal-mkkk');
    expect(calendarIds['mkkk-others']).toBe('cal-mkkk-others');
    expect(calendarIds.staff).toBe('cal-staff');
  });

  it('issues exactly one listEvents call per slot', async () => {
    const seen: string[] = [];
    const adapter = adapterFromMocks({
      listEvents: async (id) => {
        seen.push(id);
      },
    });
    await runBootCheck({ adapter, env: VALID_ENV });
    expect(seen.sort()).toEqual(['cal-mkkk', 'cal-mkkk-others', 'cal-staff']);
  });
});

describe('runBootCheck — failure branches produce ranked-cause diagnostics', () => {
  it('step calendar-config: missing env var lists every missing slot', async () => {
    let caught: BootCheckError | null = null;
    try {
      await runBootCheck({
        adapter: adapterFromMocks({}),
        env: { CALENDAR_ID_MKKK: 'x' },
      });
    } catch (err) {
      caught = err as BootCheckError;
    }
    expect(caught).toBeInstanceOf(BootCheckError);
    expect(caught?.diagnostic.step).toBe('calendar-config');
    expect(caught?.diagnostic.ranked_causes[0]).toMatch(/CALENDAR_ID_/);
    expect(caught?.diagnostic.ranked_causes.length).toBeGreaterThanOrEqual(3);
  });

  it('step google-calendar-list: listCalendars throws → ranked OAuth causes', async () => {
    const adapter = adapterFromMocks({
      listCalendars: async () => {
        throw new Error('invalid_grant');
      },
    });
    let caught: BootCheckError | null = null;
    try {
      await runBootCheck({ adapter, env: VALID_ENV });
    } catch (err) {
      caught = err as BootCheckError;
    }
    expect(caught?.diagnostic.step).toBe('google-calendar-list');
    expect(caught?.diagnostic.upstream_error).toBe('invalid_grant');
    expect(caught?.diagnostic.ranked_causes[0]).toMatch(/OAuth refresh token/);
  });

  it('step google-calendar-slot-resolve: omit one calendarId → names the missing slot', async () => {
    const adapter = adapterFromMocks({
      listCalendars: async () => [
        { id: 'cal-mkkk' },
        { id: 'cal-staff' },
        // mkkk-others deliberately absent
      ],
    });
    let caught: BootCheckError | null = null;
    try {
      await runBootCheck({ adapter, env: VALID_ENV });
    } catch (err) {
      caught = err as BootCheckError;
    }
    expect(caught?.diagnostic.step).toBe('google-calendar-slot-resolve');
    expect(caught?.diagnostic.upstream_error).toMatch(/mkkk-others=cal-mkkk-others/);
    expect(caught?.diagnostic.ranked_causes[0]).toMatch(/Calendar id stale/);
  });

  it('step google-calendar-slot-resolve: every slot missing aggregates into one error', async () => {
    const adapter = adapterFromMocks({
      listCalendars: async () => [{ id: 'cal-unrelated' }],
    });
    let caught: BootCheckError | null = null;
    try {
      await runBootCheck({ adapter, env: VALID_ENV });
    } catch (err) {
      caught = err as BootCheckError;
    }
    expect(caught?.diagnostic.step).toBe('google-calendar-slot-resolve');
    expect(caught?.diagnostic.upstream_error).toMatch(/^3 of 3/);
  });

  it('step google-events-list: per-calendar 403 surfaces with the offending slot in detail', async () => {
    const adapter = adapterFromMocks({
      listEvents: async (id) => {
        if (id === 'cal-staff') throw new Error('Forbidden 403');
      },
    });
    let caught: BootCheckError | null = null;
    try {
      await runBootCheck({ adapter, env: VALID_ENV });
    } catch (err) {
      caught = err as BootCheckError;
    }
    expect(caught?.diagnostic.step).toBe('google-events-list');
    expect(caught?.diagnostic.upstream_error).toBe('Forbidden 403');
    expect(caught?.diagnostic.detail?.slot).toBe('staff');
    expect(caught?.diagnostic.detail?.calendar_id).toBe('cal-staff');
    expect(caught?.diagnostic.ranked_causes[0]).toMatch(/ACL gap/);
  });

  it('every failure diagnostic carries exactly 3 ranked causes', async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => runBootCheck({ adapter: adapterFromMocks({}), env: {} }),
      () =>
        runBootCheck({
          adapter: adapterFromMocks({
            listCalendars: async () => {
              throw new Error('outage');
            },
          }),
          env: VALID_ENV,
        }),
      () =>
        runBootCheck({
          adapter: adapterFromMocks({ listCalendars: async () => [{ id: 'unrelated' }] }),
          env: VALID_ENV,
        }),
      () =>
        runBootCheck({
          adapter: adapterFromMocks({
            listEvents: async (id) => {
              if (id === 'cal-mkkk') throw new Error('403');
            },
          }),
          env: VALID_ENV,
        }),
    ];
    for (const c of cases) {
      let caught: BootCheckError | null = null;
      try {
        await c();
      } catch (err) {
        caught = err as BootCheckError;
      }
      expect(caught?.diagnostic.ranked_causes.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('runBootCheck — boot ordering', () => {
  it('does not call listEvents when listCalendars fails', async () => {
    const eventsCalls = vi.fn(async () => undefined);
    const adapter = adapterFromMocks({
      listCalendars: async () => {
        throw new Error('boom');
      },
      listEvents: eventsCalls,
    });
    await expect(runBootCheck({ adapter, env: VALID_ENV })).rejects.toBeInstanceOf(BootCheckError);
    expect(eventsCalls).not.toHaveBeenCalled();
  });

  it('does not call listEvents when slot resolution fails', async () => {
    const eventsCalls = vi.fn(async () => undefined);
    const adapter = adapterFromMocks({
      listCalendars: async () => [{ id: 'cal-mkkk' }],
      listEvents: eventsCalls,
    });
    await expect(runBootCheck({ adapter, env: VALID_ENV })).rejects.toBeInstanceOf(BootCheckError);
    expect(eventsCalls).not.toHaveBeenCalled();
  });
});
