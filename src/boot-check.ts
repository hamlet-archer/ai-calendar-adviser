/**
 * Boot self-check (AP-3 + AP-4) for calendar-adviser.
 *
 * Runs before any RPC binding or sync work; fails loud with a ranked-cause
 * diagnostic when a dependency is wrong. Three steps:
 *   1. OAuth round-trip via `calendarList.list` — proves credentials work.
 *   2. The 4 Google-backed slot ids resolve to calendars the impersonated
 *      identity can see — proves the typed slot enum matches reality.
 *   3. One `events.list({ maxResults: 1 })` per calendar — proves each
 *      calendar is actually queryable (catches subtle ACL gaps the
 *      `calendarList` row alone misses).
 *
 * Why ranked causes (AP-4): a single best-guess diagnostic ("token
 * expired") encourages whoever is paged to act on that guess instead of
 * verifying. The 2026-05-09 patchwork audit's AP-4 anchor was an ai-chief
 * incident where the wrong cause was encoded as the official one; the
 * actual cause sat further down the list. The mitigation is to print the
 * top 3 candidates ordered by prior probability — every reader sees
 * what to check and in what order.
 */

import type { CalendarSlot } from './calendar-config.js';
import { CALENDAR_SLOTS, CalendarConfigError, loadCalendarIds } from './calendar-config.js';
import type { GoogleCalendarAdapter } from './google-calendar-adapter.js';
import { GoogleCalendarAdapter as DefaultAdapter } from './google-calendar-adapter.js';

export type DependencyName =
  | 'calendar-config'
  | 'google-oauth'
  | 'google-calendar-list'
  | 'google-calendar-slot-resolve'
  | 'google-events-list';

export interface BootDiagnostic {
  readonly level: 'fatal';
  readonly service: 'ai-calendar-adviser';
  readonly phase: 'boot-check';
  readonly step: DependencyName;
  readonly upstream_error: string;
  readonly detail?: Record<string, unknown>;
  /** Ranked top-3 likely root causes per AP-4. */
  readonly ranked_causes: readonly string[];
}

export class BootCheckError extends Error {
  constructor(public readonly diagnostic: BootDiagnostic) {
    super(`${diagnostic.step}: ${diagnostic.upstream_error}`);
    this.name = 'BootCheckError';
  }
}

export interface BootCheckDeps {
  /** Test seam — production callers omit. */
  readonly adapter?: GoogleCalendarAdapter;
  /** Test seam — production callers omit (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv;
}

const RANKED_CAUSES_OAUTH: readonly string[] = [
  'OAuth refresh token revoked (ai@liao.info credentials rotated or revoked in Workspace Admin Console)',
  'Scope downgrade (the credential no longer carries https://www.googleapis.com/auth/calendar.readonly)',
  'Google API outage / transient 5xx (check https://status.cloud.google.com/ and retry)',
];

const RANKED_CAUSES_SLOT_RESOLVE: readonly string[] = [
  'Calendar id stale (the renamed/deleted/shared-away calendar means the CALENDAR_ID_<SLOT> env var no longer matches a calendarList row)',
  'Impersonated identity lost access (the calendar was unshared from ai@liao.info)',
  'Slot enum drift (the typed enum in calendar-config.ts no longer matches the workspace shape — the operator added/removed a domain without updating both files)',
];

const RANKED_CAUSES_EVENTS_LIST: readonly string[] = [
  'Calendar-level ACL gap (calendarList row visible but read access revoked — Google sometimes leaves the stub)',
  'Per-calendar rate limit (sustained burst across many calendars triggered Google quota; back off and retry)',
  'Single-calendar transient 5xx (other calendars succeeded; this one will likely succeed on the next sync)',
];

/**
 * Run the 3-step boot check. Returns the validated config on success;
 * throws `BootCheckError` with a renderable AP-4 diagnostic on any step
 * failing. `main.ts` catches and `process.exit(1)`s.
 */
export async function runBootCheck(deps: BootCheckDeps = {}): Promise<{
  readonly calendarIds: Record<CalendarSlot, string>;
  readonly adapter: GoogleCalendarAdapter;
}> {
  const env = deps.env ?? process.env;

  // Step 0 — typed slot map. Pre-Google check so a config typo doesn't
  // burn a Google quota call.
  let calendarIds: Record<CalendarSlot, string>;
  try {
    calendarIds = loadCalendarIds(env) as Record<CalendarSlot, string>;
  } catch (err) {
    if (err instanceof CalendarConfigError) {
      throw new BootCheckError({
        level: 'fatal',
        service: 'ai-calendar-adviser',
        phase: 'boot-check',
        step: 'calendar-config',
        upstream_error: err.message,
        detail: { missing_slots: err.missingSlots },
        ranked_causes: [
          `Required env vars unset: ${err.missingSlots
            .map((s) => `CALENDAR_ID_${s.replace(/-/g, '_').toUpperCase()}`)
            .join(', ')}`,
          'systemd unit missing EnvironmentFile or LoadCredential pointing at calendar-ids',
          'Local dev: .env file missing or process started without dotenv',
        ],
      });
    }
    throw err;
  }

  // Step 1 — OAuth + calendarList enumeration in one call.
  let adapter: GoogleCalendarAdapter;
  let allCalendars;
  try {
    adapter =
      deps.adapter ??
      DefaultAdapter.fromCredentialsFile({
        credentialsPath: env.GOOGLE_OAUTH_CREDS_PATH,
      });
  } catch (err) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-calendar-adviser',
      phase: 'boot-check',
      step: 'google-oauth',
      upstream_error: err instanceof Error ? err.message : String(err),
      ranked_causes: RANKED_CAUSES_OAUTH,
    });
  }

  try {
    allCalendars = await adapter.listCalendars();
  } catch (err) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-calendar-adviser',
      phase: 'boot-check',
      step: 'google-calendar-list',
      upstream_error: err instanceof Error ? err.message : String(err),
      ranked_causes: RANKED_CAUSES_OAUTH,
    });
  }

  // Step 2 — slot ids resolve to calendarList rows.
  const visibleIds = new Set(allCalendars.map((c) => c.id).filter((x): x is string => !!x));
  const missing: Array<{ slot: CalendarSlot; id: string }> = [];
  for (const slot of CALENDAR_SLOTS) {
    const id = calendarIds[slot];
    if (!visibleIds.has(id)) {
      missing.push({ slot, id });
    }
  }
  if (missing.length > 0) {
    throw new BootCheckError({
      level: 'fatal',
      service: 'ai-calendar-adviser',
      phase: 'boot-check',
      step: 'google-calendar-slot-resolve',
      upstream_error: `${missing.length} of ${CALENDAR_SLOTS.length} calendar slot(s) did not resolve in calendarList: ${missing
        .map((m) => `${m.slot}=${m.id}`)
        .join(', ')}`,
      detail: { missing, visible_ids_count: visibleIds.size },
      ranked_causes: RANKED_CAUSES_SLOT_RESOLVE,
    });
  }

  // Step 3 — one events.list({maxResults:1}) per calendar. Catches subtle
  // ACL gaps the listCalendars stub doesn't surface. Single-calendar
  // failure aborts boot — at boot time we want the loudest signal; the
  // sync runner (sub-item 3) can keep running on a partial set, this
  // can't.
  for (const slot of CALENDAR_SLOTS) {
    const id = calendarIds[slot];
    try {
      await adapter.listEvents({ calendarId: id, maxResults: 1 });
    } catch (err) {
      throw new BootCheckError({
        level: 'fatal',
        service: 'ai-calendar-adviser',
        phase: 'boot-check',
        step: 'google-events-list',
        upstream_error: err instanceof Error ? err.message : String(err),
        detail: { slot, calendar_id: id },
        ranked_causes: RANKED_CAUSES_EVENTS_LIST,
      });
    }
  }

  return { calendarIds, adapter };
}

/** Render a diagnostic as a single-line JSON object for journald. */
export function renderDiagnostic(d: BootDiagnostic): string {
  return JSON.stringify(d);
}
