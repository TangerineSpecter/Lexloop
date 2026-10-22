import { describe, expect, it } from 'vitest';
import { CONFUSION_CATALOG } from '../src/modules/practice/confusion.catalog';
import {
  englishWordPresent,
  normalizeOutputFeedback,
  practiceDate,
  practiceDayStart,
  practiceWeek,
  weeklyActions,
} from '../src/modules/practice/practice.rules';

const targets = [
  { bookWordId: 'a', word: 'affect', meaning: '影响' },
  { bookWordId: 'b', word: 'effect', meaning: '结果' },
];
const valid = () => ({
  grammarScore: 80,
  coherenceScore: 80,
  correctedText: 'The effect may affect my plans.',
  comments: ['注意词性。'],
  words: targets.map((word) => ({
    bookWordId: word.bookWordId,
    used: true,
    correct: true,
    feedback: '词义与搭配正确。',
  })),
});

describe('daily output evidence', () => {
  it('does not treat a substring or a missing target as successful use', () => {
    expect(englishWordPresent('effective', 'effect')).toBe(false);
    expect(englishWordPresent('The EFFECT is clear.', 'effect')).toBe(true);
    const feedback = normalizeOutputFeedback(valid(), targets, 'There is an effect.');
    expect(feedback.words[0]).toMatchObject({ used: false, correct: false });
    expect(feedback.score).toBe(62);
  });
  it('requires exact target coverage, valid dimensions and bounded feedback', () => {
    expect(() =>
      normalizeOutputFeedback(
        { ...valid(), words: [valid().words[0], valid().words[0]] },
        targets,
        'affect effect',
      ),
    ).toThrow();
    expect(() =>
      normalizeOutputFeedback({ ...valid(), grammarScore: 101 }, targets, 'affect effect'),
    ).toThrow();
    expect(() =>
      normalizeOutputFeedback(
        { ...valid(), words: [{ ...valid().words[0], used: false }, valid().words[1]] },
        targets,
        'affect effect',
      ),
    ).toThrow();
    expect(() =>
      normalizeOutputFeedback({ ...valid(), correctedText: '' }, targets, 'affect effect'),
    ).toThrow();
    expect(normalizeOutputFeedback(valid(), targets, 'The effect may affect my plans.').score).toBe(
      92,
    );
  });
});

describe('calendar and weekly prescription', () => {
  it('uses the configured local date across UTC midnight and Monday boundaries', () => {
    const now = new Date('2026-10-25T16:30:00Z');
    expect(practiceDate(now).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(practiceDayStart(now).toISOString()).toBe('2026-10-25T16:00:00.000Z');
    expect(practiceWeek(practiceDate(now))).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(
      practiceDayStart(new Date('2026-03-08T15:00:00Z'), 'America/New_York').toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
  });
  it('does not invent strengths or weaknesses when evidence is empty', () => {
    const actions = weeklyActions({
      attempts: 0,
      accuracy: null,
      dueReviews: 0,
      weaknesses: 0,
      outputs: 0,
      contrasts: 0,
      activeDays: 0,
    });
    expect(actions).toHaveLength(3);
    expect(actions[2].reason).toContain('证据还不足');
    expect(actions.every((action) => action.href.startsWith('/dashboard'))).toBe(true);
  });
  it('prioritizes overdue review and provides a focused comparison entry', () => {
    const actions = weeklyActions(
      {
        attempts: 10,
        accuracy: 60,
        dueReviews: 4,
        weaknesses: 3,
        outputs: 1,
        contrasts: 0,
        activeDays: 2,
      },
      'affect-effect',
    );
    expect(actions[2].id).toBe('review');
    expect(actions[2].reason).toContain('4 个词');
    expect(actions[1].href).toContain('group=affect-effect');
  });
});

describe('contrast catalog integrity', () => {
  it('contains complete, interleaved questions with exactly one valid option per question', () => {
    expect(CONFUSION_CATALOG.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CONFUSION_CATALOG.map((group) => group.id)).size).toBe(CONFUSION_CATALOG.length);
    for (const group of CONFUSION_CATALOG) {
      expect(group.questions).toHaveLength(4);
      expect(new Set(group.questions.map((q) => q.id)).size).toBe(4);
      for (const question of group.questions) {
        expect(question.sentence).toContain('___');
        expect(group.words.filter((word) => word.word === question.answer)).toHaveLength(1);
        expect(question.explanation.length).toBeGreaterThan(4);
      }
      expect(
        group.words.every(
          (word) => group.questions.filter((q) => q.answer === word.word).length === 2,
        ),
      ).toBe(true);
    }
  });
});
