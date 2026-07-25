import { describe, expect, it } from 'vitest';
import { StudyPlanMode } from '@prisma/client';
import { contentSignature, gradeQuestion, hasValidGeneratedMatchingPairs, unfamiliarityScore } from '../src/modules/study/study.service';

describe('dynamic review unfamiliarity', () => {
  const stable = {
    accuracy: .9,
    overdueDays: 0,
    actualGap: 4,
    lastIntervalDays: 4,
    reviewCount: 3,
    consecutiveCorrect: 3,
    postponedCount: 0,
  };

  it('keeps a stable, on-time word relatively familiar', () => {
    expect(unfamiliarityScore(stable)).toBeLessThan(20);
  });

  it('raises risk when the learner repeatedly postpones an overdue review', () => {
    const delayed = unfamiliarityScore({
      ...stable,
      overdueDays: 8,
      actualGap: 12,
      postponedCount: 4,
      consecutiveCorrect: 0,
    });
    expect(delayed).toBeGreaterThan(unfamiliarityScore(stable));
  });

  it('treats persistent low accuracy as more serious than an early mistake', () => {
    const early = unfamiliarityScore({ ...stable, accuracy: .45, reviewCount: 1, consecutiveCorrect: 0 });
    const persistent = unfamiliarityScore({ ...stable, accuracy: .45, reviewCount: 6, consecutiveCorrect: 0 });
    expect(persistent).toBeGreaterThan(early);
  });

  it('always clamps the score to the 0–100 range', () => {
    expect(unfamiliarityScore({ ...stable, accuracy: 1, consecutiveCorrect: 100 })).toBe(0);
    const highestRisk = unfamiliarityScore({ ...stable, accuracy: 0, overdueDays: 1000, postponedCount: 100 });
    expect(highestRisk).toBeGreaterThanOrEqual(0);
    expect(highestRisk).toBeLessThanOrEqual(100);
  });
});

describe('shared generated content signature', () => {
  const words = [
    { id: 'book-word-2', word: 'blue', part: 'adj.', meaning: '蓝色的' },
    { id: 'book-word-1', word: 'red', part: 'adj.', meaning: '红色的' },
  ];

  it('is account-independent and stable when the same words arrive in another order', () => {
    expect(contentSignature(StudyPlanMode.GROUP, words))
      .toBe(contentSignature(StudyPlanMode.GROUP, [...words].reverse()));
  });

  it('separates learning modes and invalidates content after a meaning change', () => {
    const original = contentSignature(StudyPlanMode.GROUP, words);
    expect(contentSignature(StudyPlanMode.INDIVIDUAL, words)).not.toBe(original);
    expect(contentSignature(StudyPlanMode.GROUP, [{ ...words[0], meaning: '忧郁的' }, words[1]])).not.toBe(original);
  });
});

describe('server-side study answer grading', () => {
  it('derives single-choice correctness from the stored answer', () => {
    const question = {
      type: 'MEANING_RECOGNITION',
      correctAnswers: ['蓝色的'],
    };
    expect(gradeQuestion(question, ['蓝色的']).isCorrect).toBe(true);
    expect(gradeQuestion(question, ['红色的']).isCorrect).toBe(false);
  });

  it('grades multiple selections without trusting their order', () => {
    const result = gradeQuestion({
      type: 'WORD_MNEMONIC',
      correctAnswers: ['选项 A', '选项 C'],
    }, ['选项 C', '选项 A']);
    expect(result.isCorrect).toBe(true);
    expect(result.selectedAnswer).toEqual(['选项 A', '选项 C']);
  });

  it('rejects incomplete or over-selected mnemonic answers', () => {
    const question = { type: 'WORD_MNEMONIC', correctAnswers: ['derive', 'derivation'] };
    expect(gradeQuestion(question, ['derive']).isCorrect).toBe(false);
    expect(gradeQuestion(question, ['derive', 'derivation', 'diverge']).isCorrect).toBe(false);
  });

  it.each([
    ['MEANING_RECOGNITION', ['预订'], ['预订']],
    ['SYNONYM_REPLACEMENT', ['volume'], ['volume']],
    ['READING_COMPREHENSION', ['on the desk'], ['on the desk']],
  ] as const)('grades %s from its stored correct option', (type, correctAnswers, selectedAnswer) => {
    expect(gradeQuestion({ type, correctAnswers }, selectedAnswer).isCorrect).toBe(true);
  });

  it('derives matching answers from the persisted pairs', () => {
    const result = gradeQuestion({
      type: 'WORD_MATCHING',
      correctAnswers: [],
      pairs: [
        { left: 'blue sky', right: '蓝天' },
        { left: 'feel blue', right: '感到沮丧' },
      ],
    }, ['feel blue=>感到沮丧', 'blue sky=>蓝天']);
    expect(result.isCorrect).toBe(true);
    expect(result.questionType).toBe('WORD_MATCHING');
  });
});

describe('generated matching-pair validation', () => {
  const pairs = [
    { left: 'school bag', right: '上学时装书和文具的包', tip: '侧重日常学习场景。' },
    { left: 'handbag', right: '随身携带物品的手提包', tip: '侧重携带方式。' },
    { left: 'plastic bag', right: '由塑料制成的袋子', tip: '侧重材质。' },
    { left: 'travel bag', right: '旅行时收纳物品的包', tip: '侧重旅行场景。' },
  ];

  it('requires four unique words and four unique Chinese definitions', () => {
    expect(hasValidGeneratedMatchingPairs(pairs)).toBe(true);
    expect(hasValidGeneratedMatchingPairs([
      pairs[0],
      { ...pairs[1], left: pairs[0].left },
      pairs[2],
      pairs[3],
    ])).toBe(false);
    expect(hasValidGeneratedMatchingPairs([
      pairs[0],
      { ...pairs[1], right: pairs[0].right },
      pairs[2],
      pairs[3],
    ])).toBe(false);
  });

  it('rejects a tip that leaks its matching phrase', () => {
    expect(hasValidGeneratedMatchingPairs([
      { ...pairs[0], tip: 'school bag 指上学时使用的包。' },
      pairs[1],
      pairs[2],
      pairs[3],
    ])).toBe(false);
  });
});
