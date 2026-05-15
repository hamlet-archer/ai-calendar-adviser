/**
 * Resolves a `person` argument (per `calendar.query.v1.enum`) to the typed
 * calendar slots whose Google ids should be queried.
 *
 * Mapping mirrors `registry/agents/calendar-adviser.yaml` ownership + the
 * `calendar.query.v1` contract description:
 *   mkkk     → mkkk + mkkk-others
 *   sally    → staff
 *   chloe    → staff
 *   ai-doer  → empty (24/7 working; no calendar)
 *
 * `kelvin` is intentionally absent from `Person`: per G6.5c
 * (`feedback_no_kelvin_account_impersonation`) the agent no longer reads
 * Kelvin's calendars. `calendar.query.v1({person:'kelvin'})` returns a
 * documented `unavailable` envelope rather than fanning out to calendar
 * slots that no longer exist.
 *
 * Note: the contract enum uses `staff.schedules` as the domain string; the
 * agent maps that to slot `staff` (a real Google calendar
 * `c_552a7b…@group.calendar.google.com`).
 */

import type { CalendarSlot } from './calendar-config.js';

export type Person = 'sally' | 'chloe' | 'mkkk' | 'ai-doer';

const PERSON_SLOTS: Record<Person, readonly CalendarSlot[]> = {
  mkkk: ['mkkk', 'mkkk-others'],
  sally: ['staff'],
  chloe: ['staff'],
  'ai-doer': [],
};

/**
 * Returns the calendar slots a `person` query should fan out across.
 * Pure routing — callers can override with an explicit `calendars` array
 * on the contract envelope.
 */
export function slotsForPerson(person: Person): readonly CalendarSlot[] {
  return PERSON_SLOTS[person];
}

/**
 * Resolves a list of calendar slots to the calendar ids the cache layer
 * understands. ai-doer's empty slot list returns the empty array.
 */
export function resolveCalendarIds(
  slots: readonly CalendarSlot[],
  calendarIds: Record<CalendarSlot, string>,
): readonly string[] {
  return slots.map((s) => calendarIds[s]);
}
