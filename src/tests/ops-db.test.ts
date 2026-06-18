/**
 * Hermetic test for the control-plane run-trace wrapper (architect-backlog AI1).
 * Points OPS_DB_PATH at a throwaway sqlite file — the lib creates the schema on
 * open — and asserts that one sync cycle writes the agents row + a `runs` row,
 * that a partial-failure cycle ends the run `failed`, and that an ops.db outage
 * degrades to an untraced sync rather than throwing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeOpsDb, runSyncWithTrace } from '../ops-db.js';
import type { SyncCycleReport } from '../sync-runner.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'calendar-opsdb-'));
  dbPath = join(tmpDir, 'ops.db');
  process.env.OPS_DB_PATH = dbPath;
});

afterEach(async () => {
  await closeOpsDb();
  delete process.env.OPS_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function report(overrides: Partial<SyncCycleReport> = {}): SyncCycleReport {
  return {
    startedAtIso: '2026-06-13T10:00:00.000Z',
    endedAtIso: '2026-06-13T10:00:01.000Z',
    results: [
      { slot: 'mkkk', calendarId: 'cal-a', status: 'ok', upserted: 3, nextSyncToken: 't1' },
      { slot: 'staff', calendarId: 'cal-b', status: 'ok', upserted: 2, nextSyncToken: 't2' },
    ],
    ...overrides,
  };
}

describe('runSyncWithTrace', () => {
  it('registers the agents row and writes a done run for a clean cycle', async () => {
    const result = await runSyncWithTrace(() => Promise.resolve(report()));
    expect(result.results).toHaveLength(2);
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const agent = db
        .prepare("SELECT id, status, blast_radius FROM agents WHERE id = 'calendar-adviser'")
        .get() as { id: string; status: string; blast_radius: string } | undefined;
      expect(agent).toBeDefined();
      expect(agent?.status).toBe('active');
      expect(agent?.blast_radius).toBe('domain-write');

      const runs = db
        .prepare("SELECT status FROM runs WHERE agent_id = 'calendar-adviser'")
        .all() as Array<{ status: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('done');
    } finally {
      db.close();
    }
  });

  it('emits a sync.cycle_complete event on the success path (AJ2a)', async () => {
    await runSyncWithTrace(() => Promise.resolve(report()));
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const ev = db
        .prepare(
          "SELECT kind, severity, payload_json FROM events WHERE agent_id = 'calendar-adviser' AND kind = 'sync.cycle_complete'",
        )
        .get() as { kind: string; severity: string; payload_json: string } | undefined;
      expect(ev).toBeDefined();
      expect(ev?.severity).toBe('info');
      const payload = JSON.parse(ev?.payload_json ?? '{}');
      expect(payload.contract_id).toBe('sync.cycle_complete.v1');
      expect(payload.sources_ok).toBe(2);
      expect(payload.sources_failed).toBe(0);
      expect(payload.rows_upserted).toBe(5);
    } finally {
      db.close();
    }
  });

  it('emits sync.cycle_complete with sources_failed > 0 on a partial-success cycle (AJ2a)', async () => {
    const partial = report({
      results: [
        { slot: 'mkkk', calendarId: 'cal-a', status: 'ok', upserted: 3, nextSyncToken: 't1' },
        {
          slot: 'staff',
          calendarId: 'cal-b',
          status: 'error',
          upserted: 0,
          nextSyncToken: null,
          errorMessage: 'boom',
        },
      ],
    });
    await runSyncWithTrace(() => Promise.resolve(partial));
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const ev = db
        .prepare(
          "SELECT payload_json FROM events WHERE agent_id = 'calendar-adviser' AND kind = 'sync.cycle_complete'",
        )
        .get() as { payload_json: string } | undefined;
      expect(ev).toBeDefined();
      const payload = JSON.parse(ev?.payload_json ?? '{}');
      expect(payload.sources_ok).toBe(1);
      expect(payload.sources_failed).toBe(1);
      expect(payload.rows_upserted).toBe(3);
    } finally {
      db.close();
    }
  });

  it('ends the run failed when a calendar errored', async () => {
    const failingReport = report({
      results: [
        { slot: 'mkkk', calendarId: 'cal-a', status: 'ok', upserted: 1, nextSyncToken: 't1' },
        {
          slot: 'staff',
          calendarId: 'cal-b',
          status: 'error',
          upserted: 0,
          nextSyncToken: null,
          errorMessage: 'boom',
        },
      ],
    });
    await runSyncWithTrace(() => Promise.resolve(failingReport));
    await closeOpsDb();

    const db = new Database(dbPath, { readonly: true });
    try {
      const run = db
        .prepare("SELECT status FROM runs WHERE agent_id = 'calendar-adviser'")
        .get() as { status: string } | undefined;
      expect(run?.status).toBe('failed');
    } finally {
      db.close();
    }
  });

  it('runs the sync untraced when ops.db cannot be opened', async () => {
    // Point at a path whose parent is a file → open() cannot create the db.
    const badParent = join(tmpDir, 'not-a-dir');
    writeFileSync(badParent, 'x');
    process.env.OPS_DB_PATH = join(badParent, 'ops.db');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runSyncWithTrace(() => Promise.resolve(report()));

    expect(result.results).toHaveLength(2); // sync still completed
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
