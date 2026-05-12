import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { calendar_v3 } from 'googleapis';
import {
  CALENDAR_READONLY_SCOPE,
  GoogleCalendarAdapter,
} from '../google-calendar-adapter.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'calendar-adapter-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface MockEventsPage {
  readonly items: ReadonlyArray<{ id: string }>;
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
}

function mockClient(opts: {
  calendarPages?: ReadonlyArray<{ items: ReadonlyArray<{ id: string }>; nextPageToken?: string }>;
  eventPages?: ReadonlyArray<MockEventsPage>;
  capturedEventParams?: calendar_v3.Params$Resource$Events$List[];
}): calendar_v3.Calendar {
  let calIdx = 0;
  const calendarList = {
    list: async (_params: unknown) => {
      const page = opts.calendarPages?.[calIdx];
      calIdx += 1;
      if (!page) return { data: {} };
      return { data: { items: page.items, nextPageToken: page.nextPageToken } };
    },
  };
  let evIdx = 0;
  const events = {
    list: async (params: calendar_v3.Params$Resource$Events$List) => {
      opts.capturedEventParams?.push(params);
      const page = opts.eventPages?.[evIdx];
      evIdx += 1;
      if (!page) return { data: {} };
      return {
        data: {
          items: page.items,
          nextPageToken: page.nextPageToken,
          nextSyncToken: page.nextSyncToken,
        },
      };
    },
  };
  return { calendarList, events } as unknown as calendar_v3.Calendar;
}

describe('GoogleCalendarAdapter.fromCredentialsFile', () => {
  it('throws when neither client nor credentials path is set', () => {
    const env = process.env.GOOGLE_OAUTH_CREDS_PATH;
    delete process.env.GOOGLE_OAUTH_CREDS_PATH;
    expect(() => GoogleCalendarAdapter.fromCredentialsFile()).toThrow(/GOOGLE_OAUTH_CREDS_PATH/);
    if (env !== undefined) process.env.GOOGLE_OAUTH_CREDS_PATH = env;
  });

  it('throws when the credentials file is missing required keys', () => {
    const path = join(tmpDir, 'creds.json');
    writeFileSync(path, JSON.stringify({ client_id: 'a' }));
    expect(() => GoogleCalendarAdapter.fromCredentialsFile({ credentialsPath: path })).toThrow(
      /missing required key/,
    );
  });

  it('builds an adapter from a complete credentials file', () => {
    const path = join(tmpDir, 'creds.json');
    writeFileSync(
      path,
      JSON.stringify({ client_id: 'a', client_secret: 'b', refresh_token: 'c' }),
    );
    const adapter = GoogleCalendarAdapter.fromCredentialsFile({ credentialsPath: path });
    expect(adapter).toBeInstanceOf(GoogleCalendarAdapter);
  });
});

describe('GoogleCalendarAdapter.listCalendars', () => {
  it('paginates through every nextPageToken', async () => {
    const client = mockClient({
      calendarPages: [
        { items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
        { items: [{ id: 'c' }], nextPageToken: 'p3' },
        { items: [{ id: 'd' }] },
      ],
    });
    const adapter = new GoogleCalendarAdapter(client);
    const got = await adapter.listCalendars();
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns [] when the workspace has no calendars', async () => {
    const client = mockClient({ calendarPages: [{ items: [] }] });
    const adapter = new GoogleCalendarAdapter(client);
    expect(await adapter.listCalendars()).toEqual([]);
  });
});

describe('GoogleCalendarAdapter.listEvents', () => {
  it('paginates and surfaces the final nextSyncToken', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [
        { items: [{ id: 'e1' }], nextPageToken: 'p2' },
        { items: [{ id: 'e2' }], nextSyncToken: 'tok-2' },
      ],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarAdapter(client);
    const got = await adapter.listEvents({ calendarId: 'cal-A', timeMin: '2026-05-12T00:00:00Z' });
    expect(got.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(got.nextSyncToken).toBe('tok-2');
    expect(captured[0]?.calendarId).toBe('cal-A');
    expect(captured[0]?.timeMin).toBe('2026-05-12T00:00:00Z');
  });

  it('passes syncToken instead of timeMin/timeMax when provided', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [{ items: [], nextSyncToken: 'tok-next' }],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarAdapter(client);
    await adapter.listEvents({
      calendarId: 'cal-A',
      syncToken: 'tok-prev',
      timeMin: '2026-05-12T00:00:00Z', // should be ignored
    });
    expect(captured[0]?.syncToken).toBe('tok-prev');
    expect(captured[0]?.timeMin).toBeUndefined();
  });

  it('defaults maxResults to 250 when caller omits it', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [{ items: [] }],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarAdapter(client);
    await adapter.listEvents({ calendarId: 'cal-A' });
    expect(captured[0]?.maxResults).toBe(250);
  });

  it('honors caller maxResults', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [{ items: [] }],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarAdapter(client);
    await adapter.listEvents({ calendarId: 'cal-A', maxResults: 1 });
    expect(captured[0]?.maxResults).toBe(1);
  });
});

describe('scope constant', () => {
  it('is exactly calendar.readonly', () => {
    expect(CALENDAR_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });
});
