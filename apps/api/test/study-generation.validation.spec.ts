import { describe, expect, it } from 'vitest';
import { validateGeneratedContent } from '../src/modules/study/study.service';

const word = {
  id: 'book-word-1',
  word: 'steady',
  part: 'adjective',
  meaning: '平稳的',
};

function generatedQuestion(type: string, options: string[]) {
  return {
    groups: [
      {
        index: 0,
        title: 'A steady route',
        sentences: [
          {
            english: 'The steady route reached the village.',
            chinese: '这条平稳的路线通向村庄。',
            simplified: '平稳的路线通向村庄。',
            grammar: 'steady 在句中修饰 route。',
          },
        ],
        questions: [
          {
            bookWordId: word.id,
            type,
            prompt: 'What does steady describe in the sentence?',
            options,
            correctAnswers: [options[0]],
            explanation: '结合句中路线通向村庄的语境判断。',
          },
        ],
      },
    ],
  };
}

function generatedMatchingQuestion(overrides: Record<string, unknown> = {}) {
  return {
    groups: [
      {
        index: 0,
        title: 'A steady route',
        sentences: [
          {
            english: 'The steady route reached the village.',
            chinese: '这条平稳的路线通向村庄。',
            simplified: '平稳的路线通向村庄。',
            grammar: 'steady 在句中修饰 route。',
          },
        ],
        questions: [
          {
            bookWordId: word.id,
            type: 'WORD_MATCHING',
            prompt: 'Match each phrase with its meaning.',
            options: [],
            correctAnswers: [],
            explanation: '结合不同语境判断 steady 的搭配。',
            pairs: [
              { left: 'steady route', right: '路线保持稳定', tip: '侧重移动方向。' },
              { left: 'steady pace', right: '行动速度平缓', tip: '侧重行动速度。' },
              { left: 'steady income', right: '收入持续可靠', tip: '侧重收入情况。' },
              { left: 'steady hand', right: '动作稳定可靠', tip: '侧重动作控制。' },
            ],
            ...overrides,
          },
        ],
      },
    ],
  };
}

describe('study generation option validation', () => {
  it.each([
    ['MEANING_RECOGNITION', ['稳定的', '平稳的', '安静的', '可靠的'], ' 稳定的　'],
    ['SYNONYM_REPLACEMENT', ['stable', 'calm', 'firm', 'quiet'], ' STABLE '],
    ['READING_COMPREHENSION', ['A village', 'A station', 'A school', 'A market'], 'a VILLAGE'],
    ['WORD_MNEMONIC', ['steadiness', 'steadying', 'study', 'ready'], 'steadying'],
  ])('rejects duplicate %s options after normalization', (type, options, duplicate) => {
    const content = generatedQuestion(type, [...options.slice(0, 3), duplicate]);

    expect(() => validateGeneratedContent(content as never, [{ index: 0, words: [word] }])).toThrow(
      '选项语言、数量或唯一性',
    );
  });

  it('accepts four distinct answers and catches canonically equivalent Unicode', () => {
    const valid = generatedQuestion('SYNONYM_REPLACEMENT', ['café', 'stable', 'firm', 'calm']);
    expect(() =>
      validateGeneratedContent(valid as never, [{ index: 0, words: [word] }]),
    ).not.toThrow();

    const unicodeDuplicate = generatedQuestion('SYNONYM_REPLACEMENT', [
      'café',
      'cafe\u0301',
      'firm',
      'calm',
    ]);
    expect(() =>
      validateGeneratedContent(unicodeDuplicate as never, [{ index: 0, words: [word] }]),
    ).toThrow('选项语言、数量或唯一性');
  });

  it('rejects duplicated correct choices in a multiple-answer mnemonic question', () => {
    const content = generatedQuestion('WORD_MNEMONIC', [
      'steadiness',
      'steadying',
      'study',
      'ready',
    ]);
    content.groups[0].questions[0].correctAnswers = ['steadiness', 'steadiness'];

    expect(() => validateGeneratedContent(content as never, [{ index: 0, words: [word] }])).toThrow(
      '正确答案不符合题型要求',
    );
  });

  it('rejects Chinese hints in English question prompts and answer choices', () => {
    const promptHint = generatedQuestion('SYNONYM_REPLACEMENT', [
      'stable',
      'calm',
      'firm',
      'quiet',
    ]);
    promptHint.groups[0].questions[0].prompt = 'Which word means stable（平稳的） here?';

    expect(() =>
      validateGeneratedContent(promptHint as never, [{ index: 0, words: [word] }]),
    ).toThrow('纯英文题干');

    const optionHint = generatedQuestion('READING_COMPREHENSION', [
      'a stable road（平稳的道路）',
      'a quiet road',
      'a narrow road',
      'a busy road',
    ]);

    expect(() =>
      validateGeneratedContent(optionHint as never, [{ index: 0, words: [word] }]),
    ).toThrow('选项语言、数量或唯一性');
  });

  it('rejects unsupported generated question types before a plan can expose them', () => {
    const content = generatedQuestion('UNSUPPORTED_QUESTION', ['stable', 'calm', 'firm', 'quiet']);

    expect(() => validateGeneratedContent(content as never, [{ index: 0, words: [word] }])).toThrow(
      '题型不受支持',
    );
  });

  it.each([
    [{ options: ['未使用的选项'] }, '额外选项或答案列表'],
    [{ options: undefined }, '额外选项或答案列表'],
    [{ correctAnswers: ['steady pace'] }, '额外选项或答案列表'],
  ])('rejects redundant answer channels on matching questions', (overrides, message) => {
    const content = generatedMatchingQuestion(overrides as Record<string, unknown>);

    expect(() => validateGeneratedContent(content as never, [{ index: 0, words: [word] }])).toThrow(
      message as string,
    );
  });

  it('keeps validation bounded for a representative forty-question plan', () => {
    const groups = Array.from({ length: 10 }, (_, index) => {
      const words = ['steady', 'gentle', 'bright', 'quiet'].map((text, wordIndex) => ({
        id: `book-word-${index}-${wordIndex}`,
        word: text,
        part: 'adjective',
        meaning: '平稳的',
      }));
      return {
        expected: { index, words },
        content: {
          index,
          title: 'A steady walk',
          sentences: [
            {
              english: 'The steady, gentle, bright, and quiet team walked home.',
              chinese: '平稳、温和、明亮而安静的队伍走回了家。',
              simplified: '平稳、温和、明亮而安静的队伍走回了家。',
              grammar: '形容词共同修饰 team。',
            },
          ],
          questions: words.map((target, wordIndex) => {
            const options = ['calm', 'firm', 'stable', 'soft'];
            return {
              bookWordId: target.id,
              type: 'SYNONYM_REPLACEMENT',
              prompt: `Which word can replace ${target.word}?`,
              options,
              correctAnswers: [options[wordIndex % options.length]],
              explanation: '结合句中语境选择意思接近的词语。',
            };
          }),
        },
      };
    });
    const content = { groups: groups.map(({ content: group }) => group) };
    const expected = groups.map(({ expected: group }) => group);
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      validateGeneratedContent(content as never, expected);
    }
    const elapsedMs = performance.now() - startedAt;

    console.log(`study option validation: 40 questions × 1,000 runs in ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
