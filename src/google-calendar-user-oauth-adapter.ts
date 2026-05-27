/**
 * Calendar per-user OAuth adapter.
 *
 * Holds a SINGLE OAuth refresh token bound to `ai@liao.info` (the system's
 * own identity, the only authorized subject for the calendar surface) —
 * never a human staff member's mailbox, and never Kelvin's. Per
 * `feedback_no_kelvin_account_impersonation` the module rejects
 * `subject=kelvin@liao.info` at load time.
 *
 * Token-file shape, written by `scripts/bootstrap-oauth.ts` (G6.5b) to
 * `/etc/ai-calendar-adviser/oauth-token.json` (mode 0600). Same shape as
 * ai-comms-adviser's per-staff Gmail token files (`gmail-user-oauth.ts`):
 *
 *   {
 *     "client_id": "<google-oauth-client-id>",
 *     "client_secret": "<google-oauth-client-secret>",
 *     "refresh_token": "<long-lived refresh token>",
 *     "token_uri": "https://oauth2.googleapis.com/token",
 *     "allowed_scopes": [
 *       "https://www.googleapis.com/auth/calendar.readonly"
 *     ]
 *   }
 *
 * Internally the googleapis Calendar client is wired with an
 * `OAuth2Client` that auto-refreshes via the refresh token;
 * `getAccessToken()` is also exposed for tests + auditing the refresh
 * path with a mocked token endpoint.
 *
 * Missing-token-file behavior: throws synchronously. The adapter is the
 * only auth path; absent the token, the calendar surface is offline.
 *
 * Historical context (2026-05-13 security cut, G6.5a/b/c): this adapter
 * replaced a service-account-impersonation shape that authenticated as
 * `kelvin@liao.info` workspace-wide. See `feedback_no_dwd_anywhere` +
 * `feedback_no_kelvin_account_impersonation` for the rationale.
 */

import { readFileSync } from 'node:fs';

import { OAuth2Client } from 'google-auth-library';
import { type calendar_v3, google } from 'googleapis';

export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export interface ListEventsOptions {
  readonly calendarId: string;
  /** ISO timestamp. Mutually exclusive with `syncToken`. */
  readonly timeMin?: string;
  /** ISO timestamp. Mutually exclusive with `syncToken`. */
  readonly timeMax?: string;
  /** Incremental-sync token from a prior response. */
  readonly syncToken?: string;
  readonly maxResults?: number;
  /**
   * When true, returns only the first page of results — no pagination loop.
   * Use for cheap smoke probes (e.g. the boot-check `events.list({maxResults:1})`
   * step) where fetching every event in a busy calendar would burn the
   * per-user-per-minute API quota.
   */
  readonly singlePage?: boolean;
}

export interface ListEventsResult {
  readonly events: readonly calendar_v3.Schema$Event[];
  /** Carries to the next call to resume an incremental sync. */
  readonly nextSyncToken: string | null;
}
export const OAUTH_TOKEN_PATH_DEFAULT = '/etc/ai-calendar-adviser/oauth-token.json';
export const OAUTH_SUBJECT_DEFAULT = 'ai@liao.info';

/**
 * Subjects this adapter refuses to authenticate as. The single member today
 * is `kelvin@liao.info` — per `feedback_no_kelvin_account_impersonation`,
 * no service-side code path may impersonate Kelvin's account. The check is
 * defensive: a misconfigured env or hand-edited token file should fail
 * loud at adapter construction, not silently mint a Kelvin-scoped token.
 */
export const FORBIDDEN_SUBJECTS = Object.freeze(['kelvin@liao.info'] as const);

/** Shape of the per-user OAuth token file on disk. */
export interface UserOauthTokenFile {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  readonly token_uri: string;
  readonly allowed_scopes: readonly string[];
}

export interface FromTokenFileDeps {
  /** Path to the per-user OAuth token JSON. Defaults to `$OAUTH_TOKEN_PATH`. */
  readonly tokenFilePath?: string;
  /**
   * Subject (Google account email) this adapter authenticates as.
   * Defaults to `$OAUTH_SUBJECT` then `ai@liao.info`. Rejected if it
   * matches `FORBIDDEN_SUBJECTS` (i.e. `kelvin@liao.info`).
   *
   * The subject is metadata: the refresh token is the actual auth, and
   * it is bound to a Google account by the OAuth consent flow. The
   * subject argument exists so the adapter can fail loud if the
   * caller's *intent* (env / config) names a forbidden user, even
   * before a network call happens.
   */
  readonly subject?: string;
  /** Pre-built calendar client (test seam — production callers omit this). */
  readonly client?: calendar_v3.Calendar;
}

export class GoogleCalendarUserOauthAdapter {
  readonly #client: calendar_v3.Calendar;

  constructor(client: calendar_v3.Calendar) {
    this.#client = client;
  }

  /**
   * Build an adapter from a per-user OAuth token file on disk. Throws if:
   *   - the resolved subject is forbidden (e.g. `kelvin@liao.info`)
   *   - the resolved subject is empty
   *   - the token file is missing / unparseable / missing required fields
   *   - `allowed_scopes` does not include `calendar.readonly`
   *
   * The boot self-check catches and renders the AP-4 ranked-cause
   * diagnostic.
   */
  static fromTokenFile(deps: FromTokenFileDeps = {}): GoogleCalendarUserOauthAdapter {
    if (deps.client) {
      return new GoogleCalendarUserOauthAdapter(deps.client);
    }

    const subject = (deps.subject ?? process.env.OAUTH_SUBJECT ?? OAUTH_SUBJECT_DEFAULT).trim();
    if (!subject) {
      throw new Error('calendar_user_oauth_subject_unset: pass subject or set OAUTH_SUBJECT');
    }
    if ((FORBIDDEN_SUBJECTS as readonly string[]).includes(subject)) {
      throw new Error(
        `calendar_user_oauth_subject_forbidden subject=${subject}: ` +
          `per feedback_no_kelvin_account_impersonation, ` +
          `no service may impersonate Kelvin's account`,
      );
    }

    const path = deps.tokenFilePath ?? process.env.OAUTH_TOKEN_PATH ?? OAUTH_TOKEN_PATH_DEFAULT;
    const token = loadAndValidateTokenFile(path);
    if (!token.allowed_scopes.includes(CALENDAR_READONLY_SCOPE)) {
      throw new Error(
        `calendar_user_oauth_scope_missing path=${path}: ` +
          `allowed_scopes must include ${CALENDAR_READONLY_SCOPE}`,
      );
    }

    const oauth2 = new OAuth2Client({
      clientId: token.client_id,
      clientSecret: token.client_secret,
    });
    oauth2.setCredentials({ refresh_token: token.refresh_token });
    const client = google.calendar({ version: 'v3', auth: oauth2 });
    return new GoogleCalendarUserOauthAdapter(client);
  }

  /** Enumerate every calendar visible to the authenticated identity. */
  async listCalendars(): Promise<readonly calendar_v3.Schema$CalendarListEntry[]> {
    const out: calendar_v3.Schema$CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.#client.calendarList.list({ pageToken, maxResults: 250 });
      const items = res.data.items ?? [];
      out.push(...items);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  /**
   * Paginated `events.list`. Returns every event + the next sync token,
   * if the API offered one (the API only returns `nextSyncToken` on the
   * last page of a sync — earlier pages carry only `nextPageToken`).
   */
  async listEvents(options: ListEventsOptions): Promise<ListEventsResult> {
    const events: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId: options.calendarId,
        pageToken,
        maxResults: options.maxResults ?? 250,
        showDeleted: true,
        singleEvents: true,
      };
      if (options.syncToken) {
        params.syncToken = options.syncToken;
      } else {
        if (options.timeMin) params.timeMin = options.timeMin;
        if (options.timeMax) params.timeMax = options.timeMax;
      }
      const res = await this.#client.events.list(params);
      const items = res.data.items ?? [];
      events.push(...items);
      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.nextSyncToken) {
        nextSyncToken = res.data.nextSyncToken;
      }
      if (options.singlePage) break;
    } while (pageToken);
    return { events, nextSyncToken };
  }
}

/**
 * Manual OAuth2 refresh-token exchange — no googleapis dependency.
 *
 * Production calls go through the `OAuth2Client` wired into `fromTokenFile`,
 * which auto-refreshes opaquely. This standalone helper exists so the refresh
 * path is exercisable from a unit test with a mocked `fetch`, mirroring
 * `ai-comms-adviser`'s `GmailUserOauthAdapter.getAccessToken()` shape.
 *
 * Throws if the token endpoint returns non-2xx.
 */
export async function exchangeRefreshToken(
  token: UserOauthTokenFile,
  scope: string = CALENDAR_READONLY_SCOPE,
): Promise<{ access_token: string; expires_in: number }> {
  if (!token.allowed_scopes.includes(scope)) {
    throw new Error(
      `calendar_user_oauth_scope_denied requested=${scope} ` +
        `allowed=${token.allowed_scopes.join(',')}`,
    );
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: token.client_id,
    client_secret: token.client_secret,
    scope,
  });
  const resp = await fetch(token.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `calendar_user_oauth_refresh_failed status=${resp.status} body=${text.slice(0, 300)}`,
    );
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number };
  return json;
}

function loadAndValidateTokenFile(path: string): UserOauthTokenFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `calendar_user_oauth_token_missing path=${path}: ` +
          `run scripts/bootstrap-oauth.ts to mint a refresh token`,
      );
    }
    throw err;
  }
  let parsed: Partial<UserOauthTokenFile>;
  try {
    parsed = JSON.parse(raw) as Partial<UserOauthTokenFile>;
  } catch (err) {
    throw new Error(
      `calendar_user_oauth_token_unparseable path=${path} err=${(err as Error).message}`,
    );
  }
  if (
    !parsed.client_id ||
    !parsed.client_secret ||
    !parsed.refresh_token ||
    !parsed.token_uri ||
    !Array.isArray(parsed.allowed_scopes) ||
    parsed.allowed_scopes.length === 0
  ) {
    throw new Error(
      `calendar_user_oauth_token_invalid path=${path}: ` +
        `expected client_id/client_secret/refresh_token/token_uri/allowed_scopes`,
    );
  }
  return {
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
    refresh_token: parsed.refresh_token,
    token_uri: parsed.token_uri,
    allowed_scopes: Object.freeze([...parsed.allowed_scopes]),
  };
}
