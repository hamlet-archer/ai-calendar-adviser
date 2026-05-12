import { describe, expect, it } from 'vitest';
import {
  CALENDAR_SLOTS,
  CalendarConfigError,
  envVarForSlot,
  loadCalendarIds,
} from '../calendar-config.js';

const fullEnv: NodeJS.ProcessEnv = {
  CALENDAR_ID_PRIMARY: 'kelvin@liao.info',
  CALENDAR_ID_MKKK: 'mkkk@group.calendar.google.com',
  CALENDAR_ID_OTHERS: 'others@group.calendar.google.com',
  CALENDAR_ID_MKKK_OTHERS: 'mkkk-others@group.calendar.google.com',
  CALENDAR_ID_STAFF: 'staff@group.calendar.google.com',
};

describe('CALENDAR_SLOTS', () => {
  it('lists the 5 Google-backed slots in canonical order', () => {
    expect([...CALENDAR_SLOTS]).toEqual(['primary', 'mkkk', 'others', 'mkkk-others', 'staff']);
  });
});

describe('envVarForSlot', () => {
  it('maps slot → CALENDAR_ID_<UPPER>', () => {
    expect(envVarForSlot('primary')).toBe('CALENDAR_ID_PRIMARY');
    expect(envVarForSlot('mkkk')).toBe('CALENDAR_ID_MKKK');
    expect(envVarForSlot('others')).toBe('CALENDAR_ID_OTHERS');
  });

  it('replaces hyphens with underscores in mkkk-others', () => {
    expect(envVarForSlot('mkkk-others')).toBe('CALENDAR_ID_MKKK_OTHERS');
  });
});

describe('loadCalendarIds', () => {
  it('returns a full map when every env var is set', () => {
    const map = loadCalendarIds(fullEnv);
    expect(map.primary).toBe('kelvin@liao.info');
    expect(map.mkkk).toBe('mkkk@group.calendar.google.com');
    expect(map.others).toBe('others@group.calendar.google.com');
    expect(map['mkkk-others']).toBe('mkkk-others@group.calendar.google.com');
    expect(map.staff).toBe('staff@group.calendar.google.com');
  });

  it('trims surrounding whitespace', () => {
    const map = loadCalendarIds({ ...fullEnv, CALENDAR_ID_PRIMARY: '  kelvin@liao.info  ' });
    expect(map.primary).toBe('kelvin@liao.info');
  });

  it('throws CalendarConfigError listing every missing slot at once', () => {
    let caught: CalendarConfigError | null = null;
    try {
      loadCalendarIds({ CALENDAR_ID_MKKK: 'x', CALENDAR_ID_OTHERS: 'y' });
    } catch (err) {
      caught = err as CalendarConfigError;
    }
    expect(caught).toBeInstanceOf(CalendarConfigError);
    expect(caught?.missingSlots.sort()).toEqual(['mkkk-others', 'primary', 'staff']);
    expect(caught?.message).toMatch(/CALENDAR_ID_PRIMARY/);
    expect(caught?.message).toMatch(/CALENDAR_ID_MKKK_OTHERS/);
    expect(caught?.message).toMatch(/CALENDAR_ID_STAFF/);
  });

  it('treats whitespace-only env var as missing', () => {
    expect(() => loadCalendarIds({ ...fullEnv, CALENDAR_ID_PRIMARY: '   ' })).toThrow(
      CalendarConfigError,
    );
  });
});
