import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CalendarCache } from '../cache.js';
import { buildContractValidator } from '../contracts.js';
import { type RunningRpcServer, startRpcServer } from '../rpc-server.js';

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts');

// G6.5c: kelvin-only `primary` + `others` slots dropped; tests use the
// remaining non-kelvin shared calendars.
const CAL_IDS = {
  mkkk: 'mkkk-primary@google',
  'mkkk-others': 'mkkk-others@google',
  staff: 'staff@group.calendar.google.com',
} as const;

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Connect to the socket, send `payload` as one newline-terminated JSON line,
 * collect the first newline-terminated response line, parse + return it.
 */
function roundTrip(socketPath: string, payload: object): Promise<unknown> {
  return new Promise((resolveRT, reject) => {
    const sock: Socket = connect(socketPath, () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        sock.end();
        try {
          resolveRT(JSON.parse(line));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    sock.on('error', reject);
  });
}

describe('rpc-server integration', () => {
  let dir: string;
  let cache: CalendarCache;
  let running: RunningRpcServer | null;
  let socketPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rpc-srv-'));
    cache = new CalendarCache(join(dir, 'cal.db'));
    socketPath = join(dir, 'query.sock');
    const validator = buildContractValidator(CONTRACTS_DIR);
    running = await startRpcServer({
      socketPath,
      cache,
      calendarIds: CAL_IDS,
      validator,
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    if (running) await running.close();
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a valid calendar.query.v1 envelope', async () => {
    cache.upsertEvent({
      id: 'm1',
      calendarId: CAL_IDS.mkkk,
      summary: 'standup',
      startIso: '2026-05-12T10:00:00Z',
      endIso: '2026-05-12T10:30:00Z',
      tz: 'UTC',
      etag: 'e1',
      updatedAt: '2026-05-12T00:00:00Z',
      payloadJson: '{}',
    });

    const resp = await roundTrip(socketPath, {
      contract_id: 'calendar.query.v1',
      trace_id: '01890000-0000-7000-8000-00000000aaaa',
      dedupe_key: 'sha256:x',
      source_ref: 'test',
      caller_agent_id: 'test',
      person: 'mkkk',
      window: { start: '2026-05-12T09:00:00Z', end: '2026-05-12T11:00:00Z', tz: 'UTC' },
    });
    expect(resp).toMatchObject({
      ok: true,
      contract_id: 'calendar.query.v1',
      events: [
        {
          id: 'm1',
          calendar_id: CAL_IDS.mkkk,
          summary: 'standup',
        },
      ],
    });
  });

  it('round-trips a valid calendar.find_free_slot.v1 envelope', async () => {
    cache.upsertEvent({
      id: 'b1',
      calendarId: CAL_IDS.mkkk,
      summary: 'block',
      startIso: '2026-05-12T09:00:00Z',
      endIso: '2026-05-12T10:00:00Z',
      tz: 'UTC',
      etag: 'e1',
      updatedAt: '2026-05-12T00:00:00Z',
      payloadJson: '{}',
    });

    const resp = (await roundTrip(socketPath, {
      contract_id: 'calendar.find_free_slot.v1',
      trace_id: '01890000-0000-7000-8000-00000000bbbb',
      dedupe_key: 'sha256:y',
      source_ref: 'test',
      caller_agent_id: 'test',
      participants: ['mkkk'],
      duration_min: 30,
      window: { start: '2026-05-12T08:00:00Z', end: '2026-05-12T18:00:00Z', tz: 'UTC' },
      working_hours: { start: '09:00', end: '17:00', days: [2] },
      slots_n: 1,
    })) as { ok: boolean; slots: ReadonlyArray<{ start: string }> };

    expect(resp.ok).toBe(true);
    expect(resp.slots).toHaveLength(1);
    expect(resp.slots[0].start).toBe('2026-05-12T10:00:00.000Z');
  });

  it('returns the unavailable envelope when person=kelvin reaches the RPC layer', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'calendar.query.v1',
      trace_id: '01890000-0000-7000-8000-00000000eeee',
      dedupe_key: 'sha256:z',
      source_ref: 'test',
      caller_agent_id: 'test',
      person: 'kelvin',
      window: { start: '2026-05-12T09:00:00Z', end: '2026-05-12T11:00:00Z', tz: 'UTC' },
    })) as { ok: boolean; status?: string; reason?: string };
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe('unavailable');
    expect(resp.reason).toBe('kelvin_calendar_not_accessible_per_no_impersonation_policy');
  });

  it('returns bad_query on a malformed envelope', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'calendar.query.v1',
      // Missing required fields.
      person: 'mkkk',
    })) as { ok: boolean; code: string };
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('bad_query');
  });

  it('returns bad_query on invalid JSON', async () => {
    const resp: unknown = await new Promise((resolveRT, reject) => {
      const sock: Socket = connect(socketPath, () => {
        sock.write('this is not json\n');
      });
      let buffer = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl !== -1) {
          sock.end();
          try {
            resolveRT(JSON.parse(buffer.slice(0, nl)));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
      sock.on('error', reject);
    });
    expect(resp).toMatchObject({ ok: false, code: 'bad_query' });
  });

  it('returns bad_query on unknown contract_id', async () => {
    const resp = (await roundTrip(socketPath, {
      contract_id: 'calendar.unknown.v1',
      trace_id: '01890000-0000-7000-8000-00000000cccc',
      dedupe_key: 'k',
      source_ref: 't',
      caller_agent_id: 't',
      person: 'mkkk',
      window: { start: '2026-05-12T09:00:00Z', end: '2026-05-12T17:00:00Z', tz: 'UTC' },
    })) as { ok: boolean; code: string };
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('bad_query');
  });
});
