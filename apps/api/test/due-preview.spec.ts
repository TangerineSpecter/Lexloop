import { describe, expect, it } from 'vitest';
import { buildDuePreview, resolveTimeZone } from '../src/modules/vocabulary/due-preview';
import { countDistinctUsableWeakWords } from '../src/modules/vocabulary/weak-focus-count';

describe('due preview buckets', () => {
  it('counts overdue and later-today words as today, and keeps the next three local days', () => {
    const preview = buildDuePreview({
      now: new Date('2026-10-31T12:00:00.000Z'),
      timeZone: 'UTC',
      dueAt: [
        new Date('2026-10-29T08:00:00.000Z'),
        new Date('2026-10-31T18:00:00.000Z'),
        new Date('2026-11-01T01:00:00.000Z'),
        new Date('2026-11-03T23:00:00.000Z'),
        new Date('2026-11-04T00:00:00.000Z'),
        null,
        'not-a-date',
      ],
    });
    expect(preview).toEqual({
      timeZone: 'UTC',
      days: [
        { date: '2026-10-31', label: '今天', count: 2 },
        { date: '2026-11-01', label: '明天', count: 1 },
        { date: '2026-11-02', label: '后天', count: 0 },
        { date: '2026-11-03', label: '大后天', count: 1 },
      ],
    });
  });

  it('uses the browser-style time zone instead of the server calendar day', () => {
    const preview = buildDuePreview({
      now: new Date('2026-10-31T16:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
      dueAt: [
        new Date('2026-10-31T15:00:00.000Z'),
        new Date('2026-10-31T17:00:00.000Z'),
        new Date('2026-11-01T16:00:00.000Z'),
      ],
    });
    expect(resolveTimeZone('Not/AZone')).toBe('UTC');
    expect(preview?.timeZone).toBe('Asia/Shanghai');
    expect(preview?.days.map((day) => [day.label, day.count])).toEqual([
      ['今天', 2],
      ['明天', 1],
      ['后天', 0],
      ['大后天', 0],
    ]);
    expect(preview?.days[0].date).toBe('2026-11-01');
  });
});

describe('weak focus eligibility', () => {
  it('counts each usable word once and skips empty meanings', () => {
    expect(
      countDistinctUsableWeakWords([
        { bookWordId: 'adapt', meaning: '适应', contextMeaning: null },
        { bookWordId: 'adapt', meaning: '适应', contextMeaning: null },
        { bookWordId: 'blank', meaning: '暂无释义', contextMeaning: null },
        { bookWordId: 'context', meaning: '无', contextMeaning: '语境义' },
        { bookWordId: 'empty-context', meaning: '有释义', contextMeaning: '' },
        { bookWordId: '', meaning: '忽略', contextMeaning: null },
      ]),
    ).toBe(2);
  });
});
