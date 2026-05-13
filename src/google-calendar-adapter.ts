/**
 * Thin wrapper over `googleapis` for the read-only calendar surface this
 * agent needs: DwD credential loading + `calendarList.list` enumerator +
 * paginated `events.list` (with incremental-sync `syncToken` support).
 *
 * No business logic — the sync runner (sub-item 3) and the boot self-check
 * (sub-item 2's `boot-check.ts`) call into these methods. Keeping the
 * googleapis surface area corralled here is the AP-3 mitigation: every
 * Google identifier (scope strings, calendarId shapes, impersonation
 * subjects) crosses exactly one typed boundary.
 *
 * Auth model: Workspace Domain-Wide Delegation per
 * `feedback_workspace_dwd_over_per_user_oauth`. A single service-account
 * key (`/etc/ai-calendar-adviser/dwd-key.json`, mode 0600) impersonates
 * a Workspace user via the `subject` claim; the user must have all 5
 * calendars on their calendarList for the boot self-check to pass.
 * Default impersonation subject: `kelvin@liao.info` (his calendarList
 * has all 5 IDs because they're either his own or shared with him).
 *
 * Scope: strictly `https://www.googleapis.com/auth/calendar.readonly`.
 * Adding this scope to the shared comms-adviser DwD client_id
 * (`101397011922329106102`) is a one-time Admin Console edit.
 */

import { readFileSync } from 'node:fs';
import { google, type calendar_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';

export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** Shape of the Workspace DwD service-account JSON key file. */
export interface DwdKeyFile {
  readonly type: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: string;
}

export interface GoogleCalendarAdapterDeps {
  /** Path to the DwD service-account key JSON. Defaults to `$DWD_KEY_PATH`. */
  readonly keyFilePath?: string;
  /** Workspace user to impersonate. Defaults to `$DWD_IMPERSONATE_SUBJECT`. */
  readonly subject?: string;
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
  /**
   * When true, returns only the first page of results — no pagination loop.
   * Use for cheap smoke probes (e.g. the boot-check `events.list({maxResults:1})`
   * step) where fetching every event in a busy calendar would burn the
   * per-user-per-minute API quota.
   *
   * Defaults to false; sync-runner callers must omit it to preserve full-history
   * fetches.
   */
  readonly singlePage?: boolean;
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
   * Build an adapter from a DwD service-account key on disk + a subject
   * to impersonate. Throws if the file is missing/malformed or the subject
   * is empty; the boot self-check catches and renders the AP-4
   * ranked-cause diagnostic.
   */
  static fromCredentialsFile(deps: GoogleCalendarAdapterDeps = {}): GoogleCalendarAdapter {
    if (deps.client) {
      return new GoogleCalendarAdapter(deps.client);
    }
    const path = deps.keyFilePath ?? process.env.DWD_KEY_PATH;
    if (!path) {
      throw new Error(
        'DWD_KEY_PATH unset and no client provided; cannot load service-account key',
      );
    }
    const subject = deps.subject ?? process.env.DWD_IMPERSONATE_SUBJECT;
    if (!subject) {
      throw new Error(
        'DWD_IMPERSONATE_SUBJECT unset and no subject provided; cannot select impersonation target',
      );
    }
    const raw = readFileSync(path, 'utf-8');
    const key = JSON.parse(raw) as DwdKeyFile;
    for (const k of ['client_email', 'private_key', 'token_uri'] as const) {
      if (!key[k]) {
        throw new Error(`DwD key file at ${path} missing required field: ${k}`);
      }
    }
    const auth = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [CALENDAR_READONLY_SCOPE],
      subject,
    });
    const client = google.calendar({ version: 'v3', auth });
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
      if (options.singlePage) break;
    } while (pageToken);
    return { events, nextSyncToken };
  }
}
