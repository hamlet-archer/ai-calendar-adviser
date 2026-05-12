/**
 * ai-calendar-adviser entry point — SCAFFOLD ONLY.
 *
 * Implementation tracked in ai-ops-meta `architect-backlog.md` under the
 * Phase 3 grounding-source agents section. Design lives in
 * `docs/architecture.md` §6.8 in the same repo.
 *
 * When implemented, this file boots:
 *   1. Boot self-check (AP-3 + AP-4): Google OAuth token + 5 calendarIds + one
 *      `calendar.list` round-trip per calendar. Failure → process.exit(1).
 *   2. SQLite cache open at /var/lib/ai-calendar-adviser/calendar.db.
 *   3. 15-min systemd timer triggers `googleCalendar.sync()` to refresh cache.
 *   4. Unix-socket RPC server at /var/run/ai-calendar-adviser/query.sock,
 *      accepting `calendar.query.v1` + `calendar.find_free_slot.v1`.
 *
 * `calendar.write_event.v1` is explicitly deferred to v2.
 */

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'ai-calendar-adviser',
      msg: 'scaffold_only',
      hint: 'see ai-ops-meta architect-backlog.md Phase 3 grounding-source agents',
    }),
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'ai-calendar-adviser',
      msg: 'unhandled_rejection',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(2);
});
