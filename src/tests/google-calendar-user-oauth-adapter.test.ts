/**
 * GoogleCalendarUserOauthAdapter — per-user OAuth refresh-token adapter
 * for ai@liao.info. The only auth path for calendar reads (G6.5a + G6.5c).
 *
 * Covers:
 *   - factory: subject defaults + env override + forbidden-subject rejection
 *   - factory: token file missing / unparseable / invalid / scope missing
 *   - factory: happy path produces a working adapter (via test-seam client)
 *   - listCalendars / listEvents pagination + syncToken + singlePage
 *   - exchangeRefreshToken (the manual OAuth2 refresh path): happy path
 *     against a mocked token endpoint, scope-denied rejection,
 *     non-2xx error surface
 */

// Stub `calendar_v3.Calendar` methods mirror the SDK's async interface
// without awaiting anything internally.
/* eslint-disable @typescript-eslint/require-await */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { calendar_v3 } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_READONLY_SCOPE,
  exchangeRefreshToken,
  FORBIDDEN_SUBJECTS,
  GoogleCalendarUserOauthAdapter,
  OAUTH_SUBJECT_DEFAULT,
  type UserOauthTokenFile,
} from '../google-calendar-user-oauth-adapter.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'calendar-user-oauth-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeTokenFile(overrides: Partial<UserOauthTokenFile> = {}): string {
  const path = join(tmpDir, 'oauth-token.json');
  writeFileSync(
    path,
    JSON.stringify({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      refresh_token: 'test-refresh-token',
      token_uri: 'https://oauth2.googleapis.com/token',
      allowed_scopes: [CALENDAR_READONLY_SCOPE],
      ...overrides,
    }),
  );
  return path;
}

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

describe('GoogleCalendarUserOauthAdapter.fromTokenFile — subject discipline', () => {
  it('rejects subject=kelvin@liao.info at load time (no-impersonation policy)', () => {
    const path = writeTokenFile();
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'kelvin@liao.info',
      }),
    ).toThrow(/calendar_user_oauth_subject_forbidden subject=kelvin@liao\.info/);
  });

  it('rejects every entry in FORBIDDEN_SUBJECTS', () => {
    const path = writeTokenFile();
    for (const forbidden of FORBIDDEN_SUBJECTS) {
      expect(() =>
        GoogleCalendarUserOauthAdapter.fromTokenFile({
          tokenFilePath: path,
          subject: forbidden,
        }),
      ).toThrow(/calendar_user_oauth_subject_forbidden/);
    }
  });

  it('rejects subject sourced from OAUTH_SUBJECT env when forbidden', () => {
    const path = writeTokenFile();
    const prev = process.env.OAUTH_SUBJECT;
    process.env.OAUTH_SUBJECT = 'kelvin@liao.info';
    try {
      expect(() => GoogleCalendarUserOauthAdapter.fromTokenFile({ tokenFilePath: path })).toThrow(
        /calendar_user_oauth_subject_forbidden/,
      );
    } finally {
      if (prev === undefined) delete process.env.OAUTH_SUBJECT;
      else process.env.OAUTH_SUBJECT = prev;
    }
  });

  it('defaults subject to ai@liao.info when neither arg nor env is set', () => {
    const path = writeTokenFile();
    const prev = process.env.OAUTH_SUBJECT;
    delete process.env.OAUTH_SUBJECT;
    try {
      const adapter = GoogleCalendarUserOauthAdapter.fromTokenFile({ tokenFilePath: path });
      expect(adapter).toBeInstanceOf(GoogleCalendarUserOauthAdapter);
      // OAUTH_SUBJECT_DEFAULT is the canonical default (asserted indirectly
      // by no-throw above; the constant is also re-exported for callers).
      expect(OAUTH_SUBJECT_DEFAULT).toBe('ai@liao.info');
    } finally {
      if (prev !== undefined) process.env.OAUTH_SUBJECT = prev;
    }
  });

  it('rejects an empty subject', () => {
    const path = writeTokenFile();
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({ tokenFilePath: path, subject: '   ' }),
    ).toThrow(/calendar_user_oauth_subject_unset/);
  });
});

describe('GoogleCalendarUserOauthAdapter.fromTokenFile — token file validation', () => {
  it('throws a missing-file error when the token file is absent', () => {
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({
        tokenFilePath: join(tmpDir, 'does-not-exist.json'),
        subject: 'ai@liao.info',
      }),
    ).toThrow(/calendar_user_oauth_token_missing/);
  });

  it('throws when the token file is unparseable JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{not json');
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/calendar_user_oauth_token_unparseable/);
  });

  it('throws when required fields are missing', () => {
    const path = join(tmpDir, 'partial.json');
    writeFileSync(path, JSON.stringify({ client_id: 'x' }));
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/calendar_user_oauth_token_invalid/);
  });

  it('throws when allowed_scopes is empty', () => {
    const path = writeTokenFile({ allowed_scopes: [] });
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/calendar_user_oauth_token_invalid/);
  });

  it('throws when allowed_scopes lacks calendar.readonly', () => {
    const path = writeTokenFile({
      allowed_scopes: ['https://www.googleapis.com/auth/userinfo.email'],
    });
    expect(() =>
      GoogleCalendarUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/calendar_user_oauth_scope_missing/);
  });

  it('builds an adapter from a complete token file', () => {
    const path = writeTokenFile();
    const adapter = GoogleCalendarUserOauthAdapter.fromTokenFile({
      tokenFilePath: path,
      subject: 'ai@liao.info',
    });
    expect(adapter).toBeInstanceOf(GoogleCalendarUserOauthAdapter);
  });
});

describe('GoogleCalendarUserOauthAdapter.listCalendars', () => {
  it('paginates through every nextPageToken', async () => {
    const client = mockClient({
      calendarPages: [
        { items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
        { items: [{ id: 'c' }], nextPageToken: 'p3' },
        { items: [{ id: 'd' }] },
      ],
    });
    const adapter = new GoogleCalendarUserOauthAdapter(client);
    const got = await adapter.listCalendars();
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns [] when the workspace has no calendars', async () => {
    const client = mockClient({ calendarPages: [{ items: [] }] });
    const adapter = new GoogleCalendarUserOauthAdapter(client);
    expect(await adapter.listCalendars()).toEqual([]);
  });
});

describe('GoogleCalendarUserOauthAdapter.listEvents', () => {
  it('paginates and surfaces the final nextSyncToken', async () => {
    const captured: calendar_v3.Params$Resource$Events$List[] = [];
    const client = mockClient({
      eventPages: [
        { items: [{ id: 'e1' }], nextPageToken: 'p2' },
        { items: [{ id: 'e2' }], nextSyncToken: 'tok-2' },
      ],
      capturedEventParams: captured,
    });
    const adapter = new GoogleCalendarUserOauthAdapter(client);
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
    const adapter = new GoogleCalendarUserOauthAdapter(client);
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
    const adapter = new GoogleCalendarUserOauthAdapter(client);
    await adapter.listEvents({ calendarId: 'cal-A' });
    expect(captured[0]?.maxResults).toBe(250);
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
    const adapter = new GoogleCalendarUserOauthAdapter(client);
    const got = await adapter.listEvents({
      calendarId: 'cal-A',
      maxResults: 1,
      singlePage: true,
    });
    expect(captured.length).toBe(1);
    expect(got.events.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('exchangeRefreshToken — OAuth2 refresh path against a mocked token endpoint', () => {
  const TOKEN: UserOauthTokenFile = Object.freeze({
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    refresh_token: 'test-refresh-token',
    token_uri: 'https://oauth2.googleapis.com/token',
    allowed_scopes: Object.freeze([CALENDAR_READONLY_SCOPE]),
  });

  it('exchanges refresh token for access token at the token endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await exchangeRefreshToken(TOKEN);
    expect(result.access_token).toBe('access-1');
    expect(result.expires_in).toBe(3600);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect((init as RequestInit).method).toBe('POST');
    const body = (init as RequestInit).body as URLSearchParams;
    const params = new URLSearchParams(body.toString());
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('test-refresh-token');
    expect(params.get('client_id')).toBe('test-client-id');
    expect(params.get('client_secret')).toBe('test-client-secret');
    expect(params.get('scope')).toBe(CALENDAR_READONLY_SCOPE);
  });

  it('rejects synchronously when the requested scope is not in allowed_scopes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      exchangeRefreshToken(TOKEN, 'https://www.googleapis.com/auth/calendar'),
    ).rejects.toThrow(
      /calendar_user_oauth_scope_denied requested=https:\/\/www\.googleapis\.com\/auth\/calendar/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a typed error with status when the token endpoint returns non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    await expect(exchangeRefreshToken(TOKEN)).rejects.toThrow(
      /calendar_user_oauth_refresh_failed status=400 body=\{"error":"invalid_grant"\}/,
    );
  });
});

describe('CALENDAR_READONLY_SCOPE', () => {
  it('is exactly calendar.readonly', () => {
    expect(CALENDAR_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });
});
