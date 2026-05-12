/**
 * Resolves a `person` argument (per `calendar.query.v1.enum`) to the typed
 * calendar slots whose Google ids should be queried.
 *
 * Mapping mirrors `registry/agents/calendar-adviser.yaml` ownership + the
 * `calendar.query.v1` contract description:
 *   kelvin   → primary + others
 *   mkkk     → mkkk + mkkk-others
 *   sally    → staff.schedules (composed)
 *   chloe    → staff.schedules (composed)
 *   ai-doer  → empty (24/7 working; no calendar)
 *
 * `staff.schedules` is a composed view over the 4 Google-backed calendars —
 * `staff` people resolve to it here, but the cache layer doesn't know about
 * the composed slot. v1 short-cut: staff resolves to `staff.schedules`, and
 * downstream cache reads fall back to the empty set until the projector that
 * fills `staff.schedules` ships. The contract response carries this via the
 * `staleness_seconds` / empty-events shape rather than failing.
 */

import type { CalendarSlot } from './calendar-config.js';

export type Person = 'kelvin' | 'sally' | 'chloe' | 'mkkk' | 'ai-doer';

export type DomainSlot = CalendarSlot | 'staff.schedules';

const PERSON_DOMAINS: Record<Person, readonly DomainSlot[]> = {
  kelvin: ['primary', 'others'],
  mkkk: ['mkkk', 'mkkk-others'],
  sally: ['staff.schedules'],
  chloe: ['staff.schedules'],
  'ai-doer': [],
};

/**
 * Returns the domain slots a `person` query should fan out across.
 * Pure routing — callers can override with an explicit `calendars` array
 * on the contract envelope.
 */
export function domainsForPerson(person: Person): readonly DomainSlot[] {
  return PERSON_DOMAINS[person];
}

/**
 * Resolves a list of domain slots to the calendar ids the cache layer
 * understands. The 4 Google-backed slots map 1:1 via `calendarIds`;
 * `staff.schedules` resolves to the empty set at v1 — see file header.
 */
export function resolveCalendarIds(
  domains: readonly DomainSlot[],
  calendarIds: Record<CalendarSlot, string>,
): readonly string[] {
  const out: string[] = [];
  for (const d of domains) {
    if (d === 'staff.schedules') continue;
    out.push(calendarIds[d]);
  }
  return out;
}
