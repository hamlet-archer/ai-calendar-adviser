/**
 * Typed slot definitions for the calendar domains owned by this agent.
 *
 * As of G6.5c (2026-05-15) the agent no longer reads Kelvin's calendars
 * (per `feedback_no_kelvin_account_impersonation` — no service-side code
 * path may impersonate Kelvin's account, and the migration deprecates the
 * `primary` + `others` slots in favour of returning a documented
 * `unavailable` envelope for `person='kelvin'` queries). The remaining
 * three slots are all non-Kelvin shared calendars reachable from
 * `ai@liao.info` via per-user OAuth.
 *
 * Env-var convention:
 *   CALENDAR_ID_MKKK         → mkkk          (household shared)
 *   CALENDAR_ID_MKKK_OTHERS  → mkkk-others   (household + others)
 *   CALENDAR_ID_STAFF        → staff         (real shared calendar
 *                                             `c_552a7b…@group.calendar.google.com`)
 *
 * Per AP-3 (typed foreign-system identifiers): the slot enum is the typed
 * surface; the runtime mapping to Google ids is validated at boot, not at
 * call time.
 */

export const CALENDAR_SLOTS = [
  'mkkk',
  'mkkk-others',
  'staff',
] as const;

export type CalendarSlot = (typeof CALENDAR_SLOTS)[number];

/** Env-var name for the calendar id behind slot `s`. */
export function envVarForSlot(s: CalendarSlot): string {
  // 'mkkk-others' → CALENDAR_ID_MKKK_OTHERS
  return `CALENDAR_ID_${s.replace(/-/g, '_').toUpperCase()}`;
}

export interface CalendarIdMap {
  readonly mkkk: string;
  readonly 'mkkk-others': string;
  readonly staff: string;
}

export class CalendarConfigError extends Error {
  constructor(
    message: string,
    public readonly missingSlots: readonly CalendarSlot[],
  ) {
    super(message);
    this.name = 'CalendarConfigError';
  }
}

/**
 * Load and validate calendar ids from the provided env. Throws
 * CalendarConfigError naming every unset / empty slot — single error vs.
 * separate exit-1s, so the operator sees the full gap at once.
 */
export function loadCalendarIds(env: NodeJS.ProcessEnv = process.env): CalendarIdMap {
  const missing: CalendarSlot[] = [];
  const partial: Record<string, string> = {};
  for (const s of CALENDAR_SLOTS) {
    const v = env[envVarForSlot(s)];
    if (!v || v.trim() === '') {
      missing.push(s);
    } else {
      partial[s] = v.trim();
    }
  }
  if (missing.length > 0) {
    const vars = missing.map(envVarForSlot).join(', ');
    throw new CalendarConfigError(
      `calendar-adviser: missing required calendar id env vars: ${vars}`,
      missing,
    );
  }
  return partial as unknown as CalendarIdMap;
}
