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
  it('throws when neither client nor key path is set', () => {
    const env = process.env.DWD_KEY_PATH;
    delete process.env.DWD_KEY_PATH;
    expect(() => GoogleCalendarAdapter.fromCredentialsFile()).toThrow(/DWD_KEY_PATH/);
    if (env !== undefined) process.env.DWD_KEY_PATH = env;
  });

  it('throws when subject is unset', () => {
    const path = join(tmpDir, 'dwd.json');
    writeFileSync(
      path,
      JSON.stringify({
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    const envSubj = process.env.DWD_IMPERSONATE_SUBJECT;
    delete process.env.DWD_IMPERSONATE_SUBJECT;
    expect(() => GoogleCalendarAdapter.fromCredentialsFile({ keyFilePath: path })).toThrow(
      /DWD_IMPERSONATE_SUBJECT/,
    );
    if (envSubj !== undefined) process.env.DWD_IMPERSONATE_SUBJECT = envSubj;
  });

  it('throws when the key file is missing required fields', () => {
    const path = join(tmpDir, 'dwd.json');
    writeFileSync(path, JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com' }));
    expect(() =>
      GoogleCalendarAdapter.fromCredentialsFile({
        keyFilePath: path,
        subject: 'kelvin@liao.info',
      }),
    ).toThrow(/missing required field/);
  });

  it('builds an adapter from a complete DwD key file', () => {
    const path = join(tmpDir, 'dwd.json');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'service_account',
        client_email: 'a@b.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    const adapter = GoogleCalendarAdapter.fromCredentialsFile({
      keyFilePath: path,
      subject: 'kelvin@liao.info',
    });
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

  it('singlePage=true stops after the first page even when nextPageToken is set', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [
        { items: [{ id: 'e1' }], nextPageToken: 'p2' },
        { items: [{ id: 'e2' }], nextPageToken: 'p3' },
        { items: [{ id: 'e3' }], nextSyncToken: 'tok-3' },
      ],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarAdapter(client);
    const got = await adapter.listEvents({
      calendarId: 'cal-A',
      maxResults: 1,
      singlePage: true,
    });
    expect(captured.length).toBe(1);
    expect(got.events.map((e) => e.id)).toEqual(['e1']);
  });

  it('singlePage=false (default) paginates as before', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [
        { items: [{ id: 'e1' }], nextPageToken: 'p2' },
        { items: [{ id: 'e2' }], nextSyncToken: 'tok-2' },
      ],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarAdapter(client);
    const got = await adapter.listEvents({ calendarId: 'cal-A' });
    expect(captured.length).toBe(2);
    expect(got.events.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('scope constant', () => {
  it('is exactly calendar.readonly', () => {
    expect(CALENDAR_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });
});
