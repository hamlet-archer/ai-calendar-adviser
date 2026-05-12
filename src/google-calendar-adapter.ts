/**
 * Thin wrapper over `googleapis` for the read-only calendar surface this
 * agent needs: OAuth credential loading + `calendarList.list` enumerator +
 * paginated `events.list` (with incremental-sync `syncToken` support).
 *
 * No business logic — the sync runner (sub-item 3) and the boot self-check
 * (this sub-item's `boot-check.ts`) call into these methods. Keeping the
 * googleapis surface area corralled here is the AP-3 mitigation: every
 * Google identifier (scope strings, mimeType-equivalents, calendarId
 * shapes) crosses exactly one typed boundary.
 *
 * Credentials are loaded from systemd `LoadCredential` on golden-ai-ops
 * (`/run/credentials/<unit>/google-oauth.json`) or from the
 * `GOOGLE_OAUTH_CREDS_PATH` env var for local dev. On either path the file
 * is an OAuth2 user credential (the `ai@liao.info` shared agent identity
 * per `feedback_shared_ai_credentials`); scope strictly
 * `https://www.googleapis.com/auth/calendar.readonly`.
 */

import { readFileSync } from 'node:fs';
import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** Shape of the OAuth2 credentials file loaded at boot. */
export interface OAuthCredentialsFile {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
}

export interface GoogleCalendarAdapterDeps {
  /** Path to the OAuth2 credentials JSON. Defaults to `$GOOGLE_OAUTH_CREDS_PATH`. */
  readonly credentialsPath?: string;
  /** Pre-built calendar client (test seam — production callers omit this). */
  readonly client?: calendar_v3.Calendar;
}

export interface ListEventsOptions {
  readonly calendarId: string;
  /** ISO timestamp. Mutually exclusive with `syncToken`. */
  readonly timeMin?: string;
  /** ISO timestamp. Mutually exclusive with `syncToken`. */
  readonly timeMax?: string;
  /** Incremental-sync token from a prior response. */
  readonly syncToken?: string;
  readonly maxResults?: number;
}

export interface ListEventsResult {
  readonly events: readonly calendar_v3.Schema$Event[];
  /** Carries to the next call to resume an incremental sync. */
  readonly nextSyncToken: string | null;
}

export class GoogleCalendarAdapter {
  readonly #client: calendar_v3.Calendar;

  constructor(client: calendar_v3.Calendar) {
    this.#client = client;
  }

  /**
   * Build an adapter from credentials on disk. Throws if the file is
   * missing / malformed; the boot self-check catches and renders the
   * AP-4 ranked-cause diagnostic.
   */
  static fromCredentialsFile(deps: GoogleCalendarAdapterDeps = {}): GoogleCalendarAdapter {
    if (deps.client) {
      return new GoogleCalendarAdapter(deps.client);
    }
    const path = deps.credentialsPath ?? process.env.GOOGLE_OAUTH_CREDS_PATH;
    if (!path) {
      throw new Error(
        'GOOGLE_OAUTH_CREDS_PATH unset and no client provided; cannot load OAuth credentials',
      );
    }
    const raw = readFileSync(path, 'utf-8');
    const creds = JSON.parse(raw) as OAuthCredentialsFile;
    for (const key of ['client_id', 'client_secret', 'refresh_token'] as const) {
      if (!creds[key]) {
        throw new Error(`OAuth credentials file at ${path} missing required key: ${key}`);
      }
    }
    const oAuth2: OAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
    oAuth2.setCredentials({ refresh_token: creds.refresh_token, scope: CALENDAR_READONLY_SCOPE });
    const client = google.calendar({ version: 'v3', auth: oAuth2 });
    return new GoogleCalendarAdapter(client);
  }

  /** Enumerate every calendar visible to the impersonated identity. */
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
      // syncToken and timeMin/timeMax are mutually exclusive per Google's
      // API contract: an incremental sync resumes from the token, a fresh
      // window query uses time bounds. The caller picks which path; we
      // forward exactly what they asked for.
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
    } while (pageToken);
    return { events, nextSyncToken };
  }
}
