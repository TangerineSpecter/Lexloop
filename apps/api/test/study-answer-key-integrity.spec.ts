import { describe, expect, it } from 'vitest';
import { gradeQuestion } from '../src/modules/study/study.service';
const question = {
  type: 'MEANING_RECOGNITION',
  options: ['修理', '购买', '出售', '丢弃'],
  correctAnswers: ['修理'],
};
describe('stored answer key integrity', () => {
  it.each([
    { correctAnswers: ['修理', '购买'] },
    { correctAnswers: ['隐藏选项'] },
    { correctAnswers: [' '] },
    { options: undefined },
    { options: ['修理', ' 修理 ', '出售', '丢弃'] },
    { type: 'WORD_MNEMONIC', correctAnswers: ['修理', '修理'] },
  ])('refuses an ungradable stored key instead of recording wrong answers: %j', (patch) => {
    expect(() => gradeQuestion({ ...question, ...patch }, ['修理'], true)).toThrow(
      '参考答案结构无效',
    );
  });
  it('refuses ambiguous matching keys', () => {
    expect(() =>
      gradeQuestion(
        {
          type: 'WORD_MATCHING',
          pairs: [
            { left: 'one', right: '甲' },
            { left: 'two', right: '甲' },
          ],
        },
        ['one=>甲', 'two=>甲'],
        true,
      ),
    ).toThrow('参考答案结构无效');
  });
  it('retains legacy smaller option sets, valid multi-selection and unknown responses', () => {
    expect(gradeQuestion({ ...question, options: ['修理', '购买'] }, ['修理']).isCorrect).toBe(
      true,
    );
    expect(
      gradeQuestion({ ...question, type: 'WORD_MNEMONIC', correctAnswers: ['修理', '购买'] }, [
        '购买',
        '修理',
      ]).isCorrect,
    ).toBe(true);
    expect(gradeQuestion(question, []).isCorrect).toBe(false);
  });
});
