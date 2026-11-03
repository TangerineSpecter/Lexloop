import { describe, expect, it } from 'vitest';
import { publicStudyContent, publicStudyQuestion } from '../src/modules/study/study-content';
import { studyQuestionFingerprint } from '../src/modules/study/study-content-bank';
const question = {
  bookWordId: 'repair',
  type: 'MEANING_RECOGNITION',
  prompt: 'Choose the meaning.',
  options: ['修理', '购买', '出售', '丢弃'],
  correctAnswers: ['修理'],
  explanation: '修理使坏掉的东西恢复工作。',
  optionNotes: ['修理提示', '购买提示', '出售提示', '丢弃提示'],
};
describe('progressive option presentation', () => {
  it('distributes a fixed first answer across positions over deterministic plan fixtures', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 256; i++) {
      const shown = publicStudyQuestion(question, false, `plan-${i}`) as typeof question;
      counts[shown.options.indexOf('修理')]++;
      expect([...shown.options].sort()).toEqual([...question.options].sort());
      expect(shown).not.toHaveProperty('correctAnswers');
      expect(shown).not.toHaveProperty('optionNotes');
    }
    expect(counts.every((count) => count >= 40 && count <= 90)).toBe(true);
  });
  it('keeps order stable across refresh, both plan copies and reveal while preserving canonical identity', () => {
    const original = structuredClone(question);
    const fingerprint = studyQuestionFingerprint(question);
    for (const type of ['MEANING_RECOGNITION', 'SYNONYM_REPLACEMENT', 'READING_COMPREHENSION']) {
      const input = { ...question, type };
      const before = publicStudyQuestion(input, false, 'plan-1') as typeof question;
      const after = publicStudyQuestion(input, true, 'plan-1') as typeof question;
      expect(publicStudyQuestion(input, false, 'plan-1')).toEqual(before);
      expect(after.options).toEqual(before.options);
      expect(after.correctAnswers).toEqual(question.correctAnswers);
      expect(after.optionNotes).toEqual(after.options.map((option) => `${option}提示`));
      for (const submitted of [false, true]) {
        const content = publicStudyContent(
          { groups: [{ index: 0, questions: [input] }] },
          new Set(submitted ? [0] : []),
          'plan-1',
        ) as { groups: { questions: unknown[] }[] };
        expect(content.groups[0].questions[0]).toEqual(submitted ? after : before);
      }
    }
    expect(question).toEqual(original);
    expect(studyQuestionFingerprint(question)).toBe(fingerprint);
  });
  it('does not mistake an ordinary English article for an option label', () => {
    const input = { ...question, options: ['a repair', 'a purchase', 'a sale', 'a disposal'] };
    expect((publicStudyQuestion(input, false, 'plan-1') as typeof question).options).not.toEqual(
      input.options,
    );
  });

  it('retains labelled or position-referencing material rather than changing its meaning', () => {
    for (const extra of [
      { options: ['A. 修理', 'B. 购买', 'C. 出售', 'D. 丢弃'] },
      { options: ['修理', '购买', '出售', '以上全部'] },
      { options: ['修理', '购买', '出售', '以上皆是'] },
      { options: ['修理', '购买', '出售', '以上都不对'] },
      { options: ['repair', 'buy', 'sell', 'All of the above.'] },
      { options: ['修理', '购买', '出售', '以上三项'] },
      { explanation: '第一项符合语境。' },
      { prompt: 'Which of the above is correct?' },
      { optionNotes: ['前者正确', '购买提示', '出售提示', '丢弃提示'] },
    ]) {
      const input = { ...question, ...extra };
      expect((publicStudyQuestion(input, false, 'plan-1') as typeof question).options).toEqual(
        input.options,
      );
      expect(publicStudyQuestion(input, true, 'plan-1')).toEqual(input);
    }
  });
  it('preserves legacy order without opt-in and does not reorder other exercise types', () => {
    expect(publicStudyQuestion(question, true)).toBe(question);
    expect((publicStudyQuestion(question, false) as typeof question).options).toEqual(
      question.options,
    );
    const other = { ...question, type: 'WORD_MATCHING' };
    expect(publicStudyQuestion(other, true, 'plan-1')).toEqual(other);
  });
});
