/**
 * Typed slot definitions for the 5 calendar domains owned by this agent.
 *
 * 4 slots map 1:1 to Google Calendars; the 5th (`staff.schedules`) is a
 * composed view rendered over the first 4. The boot self-check (AP-3 + AP-4)
 * verifies that the 4 Google-backed slot ids resolve via `calendarList.list`;
 * `staff.schedules` carries no Google id of its own.
 *
 * Values come from environment variables so the same code ships against
 * Kelvin's real workspace, a synthetic test workspace, or any future
 * impersonation target without a code change. The env-var convention is:
 *   CALENDAR_ID_PRIMARY      → primary
 *   CALENDAR_ID_MKKK         → mkkk
 *   CALENDAR_ID_OTHERS       → others
 *   CALENDAR_ID_MKKK_OTHERS  → mkkk-others
 *
 * Per AP-3 (typed foreign-system identifiers): the slot enum is the typed
 * surface; the runtime mapping to Google ids is validated at boot, not at
 * call time.
 *
 * // PATCH-EXPIRY: 2026-08-12 owner=calendar-adviser reason=https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md (calendar-adviser sub-item 2)
 */

export const CALENDAR_SLOTS = [
  'primary',
  'mkkk',
  'others',
  'mkkk-others',
] as const;

export type CalendarSlot = (typeof CALENDAR_SLOTS)[number];

/**
 * staff.schedules is a composed view across the 4 Google-backed calendars;
 * it has no `calendarList` row of its own and is excluded from the boot
 * Google-id check.
 */
export const COMPOSED_DOMAINS = ['staff.schedules'] as const;

/** Env-var name for the calendar id behind slot `s`. */
export function envVarForSlot(s: CalendarSlot): string {
  // 'mkkk-others' → CALENDAR_ID_MKKK_OTHERS
  return `CALENDAR_ID_${s.replace(/-/g, '_').toUpperCase()}`;
}

export interface CalendarIdMap {
  readonly primary: string;
  readonly mkkk: string;
  readonly others: string;
  readonly 'mkkk-others': string;
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
 * 4 separate exit-1s, so the operator sees the full gap at once.
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
