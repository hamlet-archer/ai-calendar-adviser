/**
 * SQLite cache for calendar events + per-calendar sync state.
 *
 * Sub-item 1 of calendar-adviser v1 (ai-ops-meta architect-backlog.md). Pure
 * local code — no Google round-trip yet. The adapter that fills this cache
 * lands in sub-item 2 (boot self-check + Google Calendar adapter); the
 * 15-min sync runner that drives upserts lands in sub-item 3.
 *
 * Schema is idempotent (`CREATE TABLE IF NOT EXISTS`) so reopening an
 * existing DB file is a no-op.
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database, { type Database as DatabaseType } from 'better-sqlite3';

export interface EventRow {
  readonly id: string;
  readonly calendarId: string;
  readonly summary: string | null;
  readonly startIso: string;
  readonly endIso: string;
  readonly tz: string;
  readonly etag: string | null;
  readonly updatedAt: string;
  readonly payloadJson: string;
}

export interface SyncState {
  readonly calendarId: string;
  readonly syncToken: string | null;
  readonly lastSyncIso: string;
}

export interface EventsRangeQuery {
  readonly calendars: readonly string[];
  /** ISO timestamp, inclusive. */
  readonly start: string;
  /** ISO timestamp, exclusive. */
  readonly end: string;
}

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  summary TEXT,
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  tz TEXT NOT NULL,
  etag TEXT,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_calendar_start ON events (calendar_id, start_iso);

CREATE TABLE IF NOT EXISTS sync_state (
  calendar_id TEXT PRIMARY KEY,
  sync_token TEXT,
  last_sync_iso TEXT NOT NULL
);
`;

export class CalendarCache {
  readonly #db: DatabaseType;
  readonly #insertEvent: Database.Statement;
  readonly #upsertSyncState: Database.Statement;
  readonly #selectSyncState: Database.Statement;

  constructor(dbPath: string) {
    const isNew = !existsSync(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    if (isNew) {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best-effort. A readable cache file is preferable to refusing to
        // boot; the deploy story locks down /var/lib/ai-calendar-adviser/
        // itself.
      }
    }
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(SCHEMA_DDL);

    this.#insertEvent = this.#db.prepare(`
      INSERT INTO events (id, calendar_id, summary, start_iso, end_iso, tz, etag, updated_at, payload_json)
      VALUES (@id, @calendarId, @summary, @startIso, @endIso, @tz, @etag, @updatedAt, @payloadJson)
      ON CONFLICT(id) DO UPDATE SET
        calendar_id = excluded.calendar_id,
        summary = excluded.summary,
        start_iso = excluded.start_iso,
        end_iso = excluded.end_iso,
        tz = excluded.tz,
        etag = excluded.etag,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);

    this.#upsertSyncState = this.#db.prepare(`
      INSERT INTO sync_state (calendar_id, sync_token, last_sync_iso)
      VALUES (@calendarId, @syncToken, @lastSyncIso)
      ON CONFLICT(calendar_id) DO UPDATE SET
        sync_token = excluded.sync_token,
        last_sync_iso = excluded.last_sync_iso
    `);

    this.#selectSyncState = this.#db.prepare(`
      SELECT calendar_id AS calendarId, sync_token AS syncToken, last_sync_iso AS lastSyncIso
      FROM sync_state
      WHERE calendar_id = ?
    `);
  }

  upsertEvent(row: EventRow): void {
    this.#insertEvent.run(row);
  }

  eventsForRange(query: EventsRangeQuery): EventRow[] {
    if (query.calendars.length === 0) {
      return [];
    }
    const placeholders = query.calendars.map(() => '?').join(', ');
    const stmt = this.#db.prepare(`
      SELECT id, calendar_id AS calendarId, summary, start_iso AS startIso, end_iso AS endIso,
             tz, etag, updated_at AS updatedAt, payload_json AS payloadJson
      FROM events
      WHERE calendar_id IN (${placeholders})
        AND start_iso >= ?
        AND start_iso < ?
      ORDER BY start_iso ASC
    `);
    return stmt.all(...query.calendars, query.start, query.end) as EventRow[];
  }

  setSyncState(calendarId: string, syncToken: string | null, lastSyncIso: string): void {
    this.#upsertSyncState.run({ calendarId, syncToken, lastSyncIso });
  }

  getSyncState(calendarId: string): SyncState | null {
    const row = this.#selectSyncState.get(calendarId) as SyncState | undefined;
    return row ?? null;
  }

  close(): void {
    this.#db.close();
  }
}
