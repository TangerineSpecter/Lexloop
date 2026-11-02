import { describe, expect, it } from 'vitest';
import {
  automaticStudyPlanClock,
  chinaDateRange,
  isValidAutomaticStudyPlanTime,
} from '../src/modules/automatic-study-plan/automatic-study-plan.rules';

describe('automatic study plan clock', () => {
  it('uses Asia/Shanghai date boundaries and the configured minute', () => {
    expect(automaticStudyPlanClock(new Date('2026-11-01T15:58:00.000Z'), '23:59')).toMatchObject({
      dateKey: '2026-11-01',
      due: false,
    });
    expect(automaticStudyPlanClock(new Date('2026-11-01T15:59:00.000Z'), '23:59').due).toBe(true);
    expect(automaticStudyPlanClock(new Date('2026-11-01T16:00:00.000Z'), '00:00')).toMatchObject({
      dateKey: '2026-11-02',
      due: true,
      dayStartsAt: new Date('2026-11-01T16:00:00.000Z'),
    });
    expect(automaticStudyPlanClock(new Date('2026-11-01T22:29:59.999Z'), '06:30').due).toBe(false);
    expect(automaticStudyPlanClock(new Date('2026-11-01T22:30:00.000Z'), '06:30')).toMatchObject({
      due: true,
      startsAt: new Date('2026-11-01T22:30:00.000Z'),
    });
  });

  it('validates 24-hour schedule input and returns a China calendar day range', () => {
    for (const value of ['00:00', '06:30', '23:59'])
      expect(isValidAutomaticStudyPlanTime(value)).toBe(true);
    for (const value of ['', '24:00', '6:30', '12:60', '１２:３０']) {
      expect(isValidAutomaticStudyPlanTime(value)).toBe(false);
    }
    expect(chinaDateRange('2026-11-02')).toEqual({
      start: new Date('2026-11-01T16:00:00.000Z'),
      end: new Date('2026-11-02T16:00:00.000Z'),
    });
    expect(() => chinaDateRange('2026-02-30')).toThrow();
  });
});
