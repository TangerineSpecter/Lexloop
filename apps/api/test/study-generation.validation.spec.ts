import { describe, expect, it } from 'vitest';
import {
  MAX_STUDY_QUESTION_REPAIR_ATTEMPTS,
  STUDY_GENERATION_REQUEST_TIMEOUT_MS,
  StudyQuestionValidationError,
  questionRepairPrompt,
  studyGenerationRequestTimeoutMs,
  validateAndRepairGeneratedContent,
  validateGeneratedContent,
} from '../src/modules/study/study.service';

const phraseWord = {
  id: 'book-word-pencil-box',
  word: 'pencil box',
  part: 'n.',
  meaning: '铅笔盒',
};

function makeQuestion(
  bookWordId: string,
  options = ['铅笔盒', '文具盒', '收纳袋', '书包'],
  overrides: Record<string, unknown> = {},
) {
  return {
    bookWordId,
    type: 'MEANING_RECOGNITION' as const,
    prompt: 'What did Lina put beside her book?',
    options,
    correctAnswers: [options[0]],
    explanation: '句子说明她把文具放在书本旁边。',
    ...overrides,
  };
}

function makeContent(
  words: Array<{ id: string; word: string }>,
  questions = words.map(({ id }) => makeQuestion(id)),
) {
  const english =
    'Lina placed her ' + words.map(({ word }) => word).join(' and ') + ' beside a book.';
  return {
    groups: [
      {
        index: 0,
        title: 'School Items',
        wordOccurrences: Object.fromEntries(words.map(({ word }) => [word, 1])),
        sentences: [
          {
            english,
            chinese: '莉娜把文具放在一本书旁边。',
            simplified: '莉娜把文具放在一本书旁边。',
            grammar: '过去式 placed 表示已经完成的动作。',
          },
        ],
        questions,
      },
    ],
  };
}

describe('study generation question validation and bounded repair', () => {
  it('caps each provider wait at 90 seconds and never starts a request after the plan deadline', () => {
    expect(studyGenerationRequestTimeoutMs(100_000, 0)).toBe(STUDY_GENERATION_REQUEST_TIMEOUT_MS);
    expect(studyGenerationRequestTimeoutMs(25_000, 0)).toBe(25_000);
    expect(studyGenerationRequestTimeoutMs(0, 0)).toBe(0);
    expect(studyGenerationRequestTimeoutMs(-1, 0)).toBe(0);
  });

  it('accepts the multiword target pencil box with four distinct Chinese meanings', () => {
    expect(() =>
      validateGeneratedContent(makeContent([phraseWord]), [{ index: 0, words: [phraseWord] }]),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'option count',
      type: 'MEANING_RECOGNITION',
      options: ['铅笔盒', '文具盒', '收纳袋'],
      code: 'STUDY_QUESTION_OPTIONS_COUNT_INVALID',
      message: '单词 pencil box 的选项必须恰有 4 个',
    },
    {
      name: 'option language',
      type: 'MEANING_RECOGNITION',
      options: ['pencil case', 'book bag', 'pen holder', 'desk drawer'],
      code: 'STUDY_QUESTION_OPTIONS_LANGUAGE_INVALID',
      message: '单词 pencil box 的选项语言与题型不符',
    },
    {
      name: 'meaning choice duplicate options',
      type: 'MEANING_RECOGNITION',
      options: ['铅笔盒', '文具盒', '铅笔盒　', '收纳袋'],
      code: 'STUDY_QUESTION_OPTIONS_DUPLICATE',
      message: '单词 pencil box 的选项不能重复',
    },
    {
      name: 'synonym duplicate options',
      type: 'SYNONYM_REPLACEMENT',
      options: ['café', 'stable', 'firm', ' CAFé '],
      code: 'STUDY_QUESTION_OPTIONS_DUPLICATE',
      message: '单词 pencil box 的选项不能重复',
    },
    {
      name: 'reading duplicate options',
      type: 'READING_COMPREHENSION',
      options: ['A classroom', 'A garden', ' a classroom ', 'A market'],
      code: 'STUDY_QUESTION_OPTIONS_DUPLICATE',
      message: '单词 pencil box 的选项不能重复',
    },
    {
      name: 'mnemonic duplicate options',
      type: 'WORD_MNEMONIC',
      options: ['café', 'stable', 'firm', ' CAFÉ '],
      code: 'STUDY_QUESTION_OPTIONS_DUPLICATE',
      message: '单词 pencil box 的选项不能重复',
    },
  ])('reports $name as a specific validation failure', ({ options, type, code, message }) => {
    let error: unknown;
    try {
      validateGeneratedContent(
        makeContent([phraseWord], [makeQuestion(phraseWord.id, options, { type })]),
        [{ index: 0, words: [phraseWord] }],
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StudyQuestionValidationError);
    expect(error).toMatchObject({ code, message, bookWordId: phraseWord.id });
  });

  it('preserves answer, prompt, question type, Unicode and matching boundaries', () => {
    const duplicateCorrectAnswers = makeQuestion(
      phraseWord.id,
      ['steadiness', 'steadying', 'study', 'ready'],
      { type: 'WORD_MNEMONIC', correctAnswers: ['steadiness', 'steadiness'] },
    );
    expect(() =>
      validateGeneratedContent(makeContent([phraseWord], [duplicateCorrectAnswers]), [
        { index: 0, words: [phraseWord] },
      ]),
    ).toThrow('正确答案不符合题型要求');

    const ChinesePrompt = makeQuestion(phraseWord.id, ['stable', 'calm', 'firm', 'quiet'], {
      type: 'SYNONYM_REPLACEMENT',
      prompt: 'Which word means stable（平稳的） here?',
    });
    expect(() =>
      validateGeneratedContent(makeContent([phraseWord], [ChinesePrompt]), [
        { index: 0, words: [phraseWord] },
      ]),
    ).toThrow('纯英文题干');

    const ChineseOption = makeQuestion(
      phraseWord.id,
      ['a stable road（平稳的道路）', 'a quiet road', 'a narrow road', 'a busy road'],
      { type: 'READING_COMPREHENSION' },
    );
    expect(() =>
      validateGeneratedContent(makeContent([phraseWord], [ChineseOption]), [
        { index: 0, words: [phraseWord] },
      ]),
    ).toThrow('选项语言与题型不符');

    const unsupported = makeQuestion(phraseWord.id, ['stable', 'calm', 'firm', 'quiet'], {
      type: 'UNSUPPORTED_QUESTION',
    });
    expect(() =>
      validateGeneratedContent(makeContent([phraseWord], [unsupported]), [
        { index: 0, words: [phraseWord] },
      ]),
    ).toThrow('题型不受支持');

    const validPairs = [
      { left: 'pencil box case', right: '铅笔盒外壳', tip: '说明容器外观。' },
      { left: 'pencil box lid', right: '铅笔盒盖子', tip: '说明可开合部分。' },
      { left: 'pencil box pocket', right: '铅笔盒夹层', tip: '说明内部空间。' },
      { left: 'pencil box label', right: '铅笔盒标签', tip: '说明标记信息。' },
    ];
    for (const invalidField of [
      { options: ['extra option'] },
      { options: undefined },
      { correctAnswers: ['pencil box lid'] },
    ]) {
      const matching = makeQuestion(phraseWord.id, [], {
        type: 'WORD_MATCHING',
        correctAnswers: [],
        pairs: validPairs,
        ...invalidField,
      });
      expect(() =>
        validateGeneratedContent(makeContent([phraseWord], [matching]), [
          { index: 0, words: [phraseWord] },
        ]),
      ).toThrow('匹配题只能使用配对内容');
    }
  });

  it('keeps validation bounded for a representative forty-question plan', () => {
    const groups = Array.from({ length: 10 }, (_, index) => {
      const words = ['steady', 'gentle', 'bright', 'quiet'].map((word, wordIndex) => ({
        id: `book-word-${index}-${wordIndex}`,
        word,
        part: 'adjective',
        meaning: '平稳的',
      }));
      const questions = words.map((word, wordIndex) => ({
        bookWordId: word.id,
        type: 'SYNONYM_REPLACEMENT' as const,
        prompt: `Which word can replace ${word.word}?`,
        options: ['calm', 'firm', 'stable', 'soft'],
        correctAnswers: [['calm', 'firm', 'stable', 'soft'][wordIndex]],
        explanation: '结合句中语境选择意思接近的词语。',
      }));
      return {
        expected: { index, words },
        content: {
          index,
          title: 'A steady walk',
          wordOccurrences: Object.fromEntries(words.map((word) => [word.word, 1])),
          sentences: [
            {
              english: 'The steady, gentle, bright, and quiet team walked home.',
              chinese: '平稳、温和、明亮而安静的队伍走回了家。',
              simplified: '平稳、温和、明亮而安静的队伍走回了家。',
              grammar: '形容词共同修饰 team。',
            },
          ],
          questions,
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

  it('normalizes only harmless option whitespace and does not spend a repair request', async () => {
    const content = makeContent(
      [phraseWord],
      [
        makeQuestion(phraseWord.id, [' 铅笔盒 ', ' 文具盒', '收纳袋  ', ' 书包'], {
          correctAnswers: [' 铅笔盒  '],
        }),
      ],
    );
    let repairCalls = 0;
    const result = await validateAndRepairGeneratedContent(
      content,
      [{ index: 0, words: [phraseWord] }],
      {
        onRepairAttempt: async () => {
          repairCalls += 1;
        },
        repairQuestion: async () => {
          throw new Error('Unexpected repair call');
        },
      },
    );
    expect(result.attempts).toBe(0);
    expect(repairCalls).toBe(0);
    expect(result.content.groups[0].questions[0]).toMatchObject({
      options: ['铅笔盒', '文具盒', '收纳袋', '书包'],
      correctAnswers: ['铅笔盒'],
    });
  });

  it('repairs only the invalid question and preserves the already-valid question and group text', async () => {
    const secondWord = {
      id: 'book-word-pencil-case',
      word: 'pencil case',
      part: 'n.',
      meaning: '笔袋',
    };
    const validQuestion = makeQuestion(phraseWord.id);
    const invalidQuestion = makeQuestion(secondWord.id, [
      'pencil box',
      'school bag',
      'pen holder',
      'desk drawer',
    ]);
    const source = makeContent([phraseWord, secondWord], [validQuestion, invalidQuestion]);
    const originalSentence = source.groups[0].sentences[0];
    const repairedQuestion = makeQuestion(secondWord.id, ['笔袋', '铅笔盒', '书包', '收纳盒']);
    const repairTargets: string[] = [];
    const result = await validateAndRepairGeneratedContent(
      source,
      [{ index: 0, words: [phraseWord, secondWord] }],
      {
        onRepairAttempt: async () => undefined,
        repairQuestion: async ({ word, group }) => {
          repairTargets.push(word.id);
          expect(group.sentences[0]).toEqual(originalSentence);
          return repairedQuestion;
        },
      },
    );
    expect(result.attempts).toBe(1);
    expect(repairTargets).toEqual([secondWord.id]);
    expect(result.content.groups[0].questions[0]).toEqual(validQuestion);
    expect(result.content.groups[0].questions[1]).toMatchObject(repairedQuestion);
    expect(result.content.groups[0].sentences[0]).toEqual(originalSentence);
  });

  it('caps repair requests at three for the whole generation attempt', async () => {
    const source = makeContent(
      [phraseWord],
      [makeQuestion(phraseWord.id, ['pencil case', 'book bag', 'pen holder', 'desk drawer'])],
    );
    let repairCalls = 0;
    const error = await validateAndRepairGeneratedContent(
      source,
      [{ index: 0, words: [phraseWord] }],
      {
        onRepairAttempt: async () => undefined,
        repairQuestion: async ({ question }) => {
          repairCalls += 1;
          return question;
        },
      },
    ).catch((caught: unknown) => caught);
    expect(repairCalls).toBe(MAX_STUDY_QUESTION_REPAIR_ATTEMPTS);
    expect(error).toBeInstanceOf(StudyQuestionValidationError);
  });

  it('keeps question type constraints in the local repair prompt', () => {
    const prompt = questionRepairPrompt({
      word: phraseWord,
      targetQuestionType: 'MEANING_RECOGNITION',
      sentenceContext: ['Lina placed a pencil box beside her book.'],
      question: makeQuestion(phraseWord.id),
      issue: '选项语言不符合指定题型',
      attempt: 1,
    });
    expect(prompt).toContain('只返回 JSON 对象');
    expect(prompt).toContain('所有 options 都是中文释义');
    expect(prompt).toContain('不得改变题型');
    expect(prompt).toContain('只修复一题');
  });
});
