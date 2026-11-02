import { describe, expect, it } from 'vitest';
import { studyQuestionFingerprint } from '../src/modules/study/study-content-bank';

describe('public study question identity', () => {
  it('uses stable object-key order while preserving array order', () => {
    const first = studyQuestionFingerprint({ prompt: 'Choose', options: ['a', 'b'] });
    const reorderedKeys = studyQuestionFingerprint({ options: ['a', 'b'], prompt: 'Choose' });
    const reorderedOptions = studyQuestionFingerprint({ prompt: 'Choose', options: ['b', 'a'] });

    expect(reorderedKeys).toBe(first);
    expect(reorderedOptions).not.toBe(first);
  });

  it('changes identity when any saved question field changes', () => {
    const first = studyQuestionFingerprint({
      prompt: 'Choose the meaning',
      correctAnswers: ['明亮的'],
      explanation: '解释一',
    });
    const changedAnswer = studyQuestionFingerprint({
      prompt: 'Choose the meaning',
      correctAnswers: ['黑暗的'],
      explanation: '解释一',
    });
    const changedExplanation = studyQuestionFingerprint({
      prompt: 'Choose the meaning',
      correctAnswers: ['明亮的'],
      explanation: '解释二',
    });

    expect(changedAnswer).not.toBe(first);
    expect(changedExplanation).not.toBe(first);
  });

  it('rejects non-JSON values rather than producing a misleading identity', () => {
    expect(() => studyQuestionFingerprint({ prompt: undefined })).toThrow('题目快照必须是 JSON 值');
  });
});
