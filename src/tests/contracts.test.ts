import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildContractValidator } from '../contracts.js';

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts');

function validQueryEnvelope() {
  return {
    contract_id: 'calendar.query.v1',
    trace_id: '01890000-0000-7000-8000-000000000000',
    dedupe_key: 'sha256:deadbeef',
    source_ref: 'ops.db.runs/123',
    caller_agent_id: 'chief-of-staff',
    person: 'kelvin',
    window: {
      start: '2026-05-12T09:00:00Z',
      end: '2026-05-12T17:00:00Z',
      tz: 'Europe/London',
    },
  };
}

function validFindFreeSlotEnvelope() {
  return {
    contract_id: 'calendar.find_free_slot.v1',
    trace_id: '01890000-0000-7000-8000-000000000001',
    dedupe_key: 'sha256:cafebabe',
    source_ref: 'ops.db.runs/124',
    caller_agent_id: 'chief-of-staff',
    participants: ['kelvin', 'sally'],
    duration_min: 30,
    window: {
      start: '2026-05-12T09:00:00Z',
      end: '2026-05-12T17:00:00Z',
      tz: 'Europe/London',
    },
  };
}

describe('buildContractValidator', () => {
  it('accepts a well-formed calendar.query.v1 envelope', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate(validQueryEnvelope());
    expect(r.ok).toBe(true);
  });

  it('accepts a well-formed calendar.find_free_slot.v1 envelope', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate(validFindFreeSlotEnvelope());
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown contract_id', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate({ ...validQueryEnvelope(), contract_id: 'calendar.unknown.v1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toMatch(/unknown contract_id/);
  });

  it('rejects a missing required field (person)', () => {
    const env = validQueryEnvelope();
    delete (env as Partial<typeof env>).person;
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate(env);
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed trace_id (not UUIDv7)', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate({ ...validQueryEnvelope(), trace_id: 'not-a-uuid' });
    expect(r.ok).toBe(false);
  });

  it('rejects a window with non-date-time strings', () => {
    const env = validQueryEnvelope();
    env.window = { start: 'tomorrow', end: 'next-week', tz: 'UTC' };
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate(env);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-enum person value', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate({ ...validQueryEnvelope(), person: 'someone-else' });
    expect(r.ok).toBe(false);
  });

  it('rejects a duration_min outside the allowed range', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const r = v.validate({ ...validFindFreeSlotEnvelope(), duration_min: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    expect(v.validate(null).ok).toBe(false);
    expect(v.validate('hello').ok).toBe(false);
    expect(v.validate(42).ok).toBe(false);
  });
});
