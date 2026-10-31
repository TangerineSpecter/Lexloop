import { describe, expect, it } from 'vitest';
import { buildWeekGlance } from '../src/modules/reports/week-glance';

describe('week glance', () => {
  it('counts active days and distinct plan words without mixing sources', () => {
    const week = buildWeekGlance({
      today: '2026-10-31',
      activeDates: new Set(['2026-10-25', '2026-10-30', '2026-10-31']),
      attempts: [
        { date: '2026-10-24', bookWordId: 'old', source: 'NEW' },
        { date: '2026-10-30', bookWordId: 'adapt', source: 'NEW' },
        { date: '2026-10-30', bookWordId: 'adapt', source: 'NEW' },
        { date: '2026-10-31', bookWordId: 'bright', source: 'REVIEW' },
        { date: '2026-10-31', bookWordId: 'calm', source: null },
      ],
    });
    expect(week.activeDays).toBe(3);
    expect(week.answeredWords).toBe(3);
    expect(week.newWords).toBe(1);
    expect(week.reviewWords).toBe(1);
    expect(week.days).toHaveLength(7);
    expect(week.days.at(-1)).toEqual({ label: '今', active: true });
    expect(week.days.filter((day) => day.active)).toHaveLength(3);
  });
});
