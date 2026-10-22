import { describe, expect, it } from 'vitest';
import {
  foundationGrammar,
  gradeLab,
  normalizeLabContent,
  publicLabContent,
  type LabInput,
} from '../src/modules/learning-lab/lab.rules';

const input: LabInput = {
  targets: [{ id: 'word1', text: 'look forward to', meaning: '期待' }],
  evidence: [],
  level: 'B1',
};
function reading() {
  return {
    title: 'A small trip',
    introduction: '注意短语的语境。',
    sentences: Array.from({ length: 4 }, (_, index) => ({
      english:
        index === 0
          ? 'We look forward to a short trip together because we have worked hard all week and need some time outside.'
          : 'We plan to take a walk by the river and enjoy a quiet afternoon with our friends before returning home.',
      chinese: '我们计划周末去旅行。',
      note: '注意先找主语和谓语。',
    })),
    questions: Array.from({ length: 3 }, () => ({
      prompt: 'What are the friends planning?',
      options: ['A trip', 'A test', 'A meeting'],
      correctIndex: 0,
      explanation: '原文提到去旅行。',
    })),
  };
}
describe('learning lab validation and assessment', () => {
  it('requires whole phrases in the passage, while accepting case differences', () => {
    const raw = reading();
    const result = normalizeLabContent(raw, 'READING', input);
    expect(result.targets).toEqual(input.targets);
    raw.sentences[0].english = raw.sentences[0].english.replace(
      'look forward to',
      'look forward toward',
    );
    expect(() => normalizeLabContent(raw, 'READING', input)).toThrow();
  });
  it('rejects invalid model answers, duplicate options, and short passages', () => {
    const invalid = reading();
    invalid.questions[0].correctIndex = 3;
    expect(() => normalizeLabContent(invalid, 'READING', input)).toThrow();
    const duplicates = reading();
    duplicates.questions[0].options[2] = 'A trip';
    expect(() => normalizeLabContent(duplicates, 'READING', input)).toThrow();
    const short = reading();
    short.sentences.forEach((sentence) => {
      sentence.english = 'We look forward to it.';
    });
    expect(() => normalizeLabContent(short, 'READING', input)).toThrow();
  });
  it('withholds answer keys and explanations until submission', () => {
    const content = foundationGrammar();
    const publicContent = publicLabContent(content, false);
    expect(publicContent.questions[0]).not.toHaveProperty('correctIndex');
    expect(publicContent.questions[0]).not.toHaveProperty('explanation');
    expect(publicLabContent(content, true).questions[0].correctIndex).toBe(1);
    expect(content.questions[0].correctIndex).toBe(1);
  });
  it('rejects invented evidence IDs and unrecognized grammar categories', () => {
    const raw = {
      ...foundationGrammar(),
      topics: [{ key: 'tense', explanation: '过去时。', evidenceIds: ['someone-else'] }],
    };
    expect(() => normalizeLabContent(raw, 'GRAMMAR', { ...input, targets: [] })).toThrow();
    expect(() =>
      normalizeLabContent(
        { ...raw, topics: [{ key: 'fluency', explanation: '口语', evidenceIds: [] }] },
        'GRAMMAR',
        input,
      ),
    ).toThrow();
  });
  it('grades all questions on the server and rejects incomplete or invalid choices', () => {
    const content = foundationGrammar();
    const answers = content.questions.map((question) => question.correctIndex!);
    expect(gradeLab(content, answers)).toBe(100);
    expect(() => gradeLab(content, answers.slice(1))).toThrow();
    expect(() => gradeLab(content, [-1, ...answers.slice(1)])).toThrow();
    expect(() => gradeLab(content, [3, ...answers.slice(1)])).toThrow();
  });
});
