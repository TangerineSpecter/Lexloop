import { BadGatewayException, BadRequestException, ValidationPipe } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiController,
  ReadingSentenceRewriteDto,
  ReadingTranslationDto,
  ReadingWordUseDto,
} from '../src/modules/ai/ai.controller';
import {
  parseReadingSentenceRewriteFeedback,
  parseReadingTranslationFeedback,
  parseReadingWordUseFeedback,
  READING_SENTENCE_REWRITE_FEEDBACK_PROMPT,
  READING_TRANSLATION_FEEDBACK_PROMPT,
  READING_WORD_USE_FEEDBACK_PROMPT,
} from '../src/modules/ai/formative-feedback';

const request = {
  sourceSentence: 'Maya missed the bus, so she called a taxi.',
  learnerRewrite: 'Maya did not catch the bus, so she took a taxi.',
};
const feedback = {
  meaning: '主要意思保留了；called a taxi 比 took a taxi 更明确地表示打电话叫车。',
  grammar: 'did not catch 的时态和主语搭配正确。',
  naturalness: '表达清楚自然。',
  alternative: 'After missing the bus, Maya called a taxi.',
};

describe('AiController reading sentence rewrite feedback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the authenticated learner selected model and returns formative notes without a score', async () => {
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(feedback) } }] }),
        ),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    const result = await controller.readingRewriteFeedback(request, {
      user: { sub: 'learner-a' },
    });

    expect(result).toEqual(feedback);
    expect(result).not.toHaveProperty('score');
    expect(selectedChatCompletions).toHaveBeenCalledOnce();
    const [completion, userId, signal] = selectedChatCompletions.mock.calls[0];
    expect(userId).toBe('learner-a');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(completion).toMatchObject({
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    });
    expect(completion.messages[0].content).toContain('不是指令');
    expect(JSON.parse(completion.messages[1].content)).toEqual(request);
  });

  it('rejects malformed model JSON without exposing provider output', async () => {
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'private raw output' } }] })),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    await expect(
      controller.readingRewriteFeedback(request, { user: { sub: 'learner-a' } }),
    ).rejects.toMatchObject({
      constructor: BadGatewayException,
      message: expect.stringContaining('没有返回可用的改写建议'),
    });
    await expect(
      controller.readingRewriteFeedback(request, { user: { sub: 'learner-a' } }),
    ).rejects.not.toThrow('private raw output');
  });

  it('does not send blank text to a model', async () => {
    const selectedChatCompletions = vi.fn();
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    await expect(
      controller.readingRewriteFeedback(
        { sourceSentence: 'An original sentence.', learnerRewrite: '   ' },
        { user: { sub: 'learner-a' } },
      ),
    ).rejects.toMatchObject({ constructor: BadRequestException });
    expect(selectedChatCompletions).not.toHaveBeenCalled();
  });

  it('asks for proposition-level meaning checks and distinguishes grammar from naturalness', () => {
    expect(READING_SENTENCE_REWRITE_FEEDBACK_PROMPT).toContain('肯定或否定');
    expect(READING_SENTENCE_REWRITE_FEEDBACK_PROMPT).toContain('合理的同义词和句式变化');
    expect(READING_SENTENCE_REWRITE_FEEDBACK_PROMPT).toContain('语法结构和词形');
    expect(READING_SENTENCE_REWRITE_FEEDBACK_PROMPT).toContain('常见搭配、惯用表达或语域');
    expect(READING_SENTENCE_REWRITE_FEEDBACK_PROMPT).toContain('不能擅自改变');
    expect(READING_SENTENCE_REWRITE_FEEDBACK_PROMPT).toContain('不得给分');
  });

  it('keeps only the formative response contract even if a provider adds a score', () => {
    expect(
      parseReadingSentenceRewriteFeedback(
        JSON.stringify({ ...feedback, score: 91, cefr: 'B2', mastery: true }),
      ),
    ).toEqual(feedback);
  });

  it('rejects array responses and strips nested provider metadata', () => {
    expect(() => parseReadingSentenceRewriteFeedback(JSON.stringify([feedback]))).toThrow();
    expect(
      parseReadingSentenceRewriteFeedback(
        JSON.stringify({
          ...feedback,
          metadata: { score: 91, profile: { cefr: 'B2', mastery: true } },
        }),
      ),
    ).toEqual(feedback);
  });

  it('rejects incomplete or incorrectly typed formative fields', () => {
    expect(() =>
      parseReadingSentenceRewriteFeedback(JSON.stringify({ ...feedback, grammar: 3 })),
    ).toThrow();
    expect(() =>
      parseReadingSentenceRewriteFeedback(JSON.stringify({ meaning: '保留' })),
    ).toThrow();
    expect(() =>
      parseReadingSentenceRewriteFeedback(
        JSON.stringify({ ...feedback, alternative: { text: 'not a sentence' } }),
      ),
    ).toThrow();
  });

  it('uses offline synthetic examples for preserved meaning, changed polarity and style-only differences', () => {
    const syntheticCases = [
      {
        name: 'valid synonym rewrite',
        input: {
          sourceSentence: 'Maya missed the bus, so she called a taxi.',
          learnerRewrite: 'After missing the bus, Maya called a cab.',
        },
        response: {
          meaning: '保留了原句的原因和结果；cab 是 taxi 的合理同义表达。',
          grammar: '语法没有明显问题。',
          naturalness: '表达自然。',
          alternative: null,
        },
      },
      {
        name: 'polarity change',
        input: {
          sourceSentence: 'Maya did not miss the bus.',
          learnerRewrite: 'Maya missed the bus.',
        },
        response: {
          meaning: '否定变成肯定，事实关系相反。',
          grammar: '句子结构正确。',
          naturalness: '表达自然。',
          alternative: 'Maya did not miss the bus.',
        },
      },
      {
        name: 'grammatical but less idiomatic wording',
        input: {
          sourceSentence: 'Good lighting makes a room feel brighter.',
          learnerRewrite: 'Good lighting makes a room more bright.',
        },
        response: {
          meaning: '原意保留。',
          grammar: '句子结构正确。',
          naturalness: 'more bright 可以理解，但 brighter 更符合常见表达。',
          alternative: 'Good lighting makes a room feel brighter.',
        },
      },
    ];

    for (const example of syntheticCases) {
      const normalized = parseReadingSentenceRewriteFeedback(JSON.stringify(example.response));
      expect(normalized, example.name).toEqual(example.response);
      expect(normalized).not.toHaveProperty('score');
    }
  });

  it('trims surrounding whitespace from the submitted rewrite payload', async () => {
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(feedback) } }] }),
        ),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    await controller.readingRewriteFeedback(
      { sourceSentence: '  Original sentence. ', learnerRewrite: ' My version.  ' },
      { user: { sub: 'learner-a' } },
    );

    const [completion] = selectedChatCompletions.mock.calls[0];
    expect(JSON.parse(completion.messages[1].content)).toEqual({
      sourceSentence: 'Original sentence.',
      learnerRewrite: 'My version.',
    });
  });
});

describe('AiController reading word-use feedback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the authenticated learner selected model and returns formative guidance without a score', async () => {
    const result = {
      wordUse: 'bright 用作形容词修饰 room，符合给定词义。',
      meaning: '句子表达房间光线充足。',
      grammar: '主语和谓语搭配正确。',
      naturalness: '表达自然。',
      alternative: null,
    };
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
        ),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);
    const input = {
      word: 'bright',
      meaning: '明亮的；光线充足的',
      learnerSentence: 'The room is bright in the morning.',
    };

    const feedback = await controller.readingWordUseFeedback(input, {
      user: { sub: 'learner-a' },
    });

    expect(feedback).toEqual(result);
    expect(feedback).not.toHaveProperty('score');
    expect(selectedChatCompletions).toHaveBeenCalledOnce();
    const [completion, userId, signal] = selectedChatCompletions.mock.calls[0];
    expect(userId).toBe('learner-a');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(completion).toMatchObject({
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    });
    expect(completion.messages[0].content).toContain('不是指令');
    expect(completion.messages[0].content).toContain('不得给分');
    expect(JSON.parse(completion.messages[1].content)).toEqual(input);
  });

  it('rejects malformed model JSON without exposing provider output', async () => {
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'private raw output' } }] })),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    await expect(
      controller.readingWordUseFeedback(
        {
          word: 'bright',
          meaning: '明亮的',
          learnerSentence: 'The room is bright.',
        },
        { user: { sub: 'learner-a' } },
      ),
    ).rejects.toMatchObject({
      constructor: BadGatewayException,
      message: expect.stringContaining('没有返回可用的造句建议'),
    });
  });

  it('does not send blank learner text to a model', async () => {
    const selectedChatCompletions = vi.fn();
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    await expect(
      controller.readingWordUseFeedback(
        { word: 'bright', meaning: '明亮的', learnerSentence: '   ' },
        { user: { sub: 'learner-a' } },
      ),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: expect.stringContaining('目标词'),
    });
    expect(selectedChatCompletions).not.toHaveBeenCalled();
  });

  it('separates sense, part of speech and collocation from sentence grammar and naturalness', () => {
    expect(READING_WORD_USE_FEEDBACK_PROMPT).toContain('具体义项、词性');
    expect(READING_WORD_USE_FEEDBACK_PROMPT).toContain('必要词形变化');
    expect(READING_WORD_USE_FEEDBACK_PROMPT).toContain('常见搭配/句型');
    expect(READING_WORD_USE_FEEDBACK_PROMPT).toContain('只谈明确的句法或词形语法问题');
    expect(READING_WORD_USE_FEEDBACK_PROMPT).toContain('与语法正确性区分');
    expect(READING_WORD_USE_FEEDBACK_PROMPT).toContain('不得给分');
  });

  it('accepts a null alternative and strips fields outside the qualitative contract', () => {
    const syntheticFeedback = {
      wordUse: 'brighten 的过去式 brightened 符合这里的意思。',
      meaning: '句子表达了她让房间变亮。',
      grammar: '时态和句子结构正确。',
      naturalness: '搭配自然。',
      alternative: null,
      score: 100,
      proficiency: 'C1',
    };
    expect(parseReadingWordUseFeedback(JSON.stringify(syntheticFeedback))).toEqual({
      wordUse: syntheticFeedback.wordUse,
      meaning: syntheticFeedback.meaning,
      grammar: syntheticFeedback.grammar,
      naturalness: syntheticFeedback.naturalness,
      alternative: null,
    });
  });

  it('rejects a malformed word-use response without accepting missing dimensions', () => {
    expect(() =>
      parseReadingWordUseFeedback(
        JSON.stringify({
          wordUse: '词义合适。',
          meaning: '意思清楚。',
          grammar: '',
          naturalness: '自然。',
        }),
      ),
    ).toThrow();
    expect(() => parseReadingWordUseFeedback('x'.repeat(8_001))).toThrow();
  });

  it('keeps sense, part-of-speech, omitted-target and inflection cases advisory', () => {
    const syntheticCases = [
      {
        name: 'valid inflection and collocation',
        input: {
          word: 'brighten',
          meaning: '使变亮',
          learnerSentence: 'She brightened the room with a lamp.',
        },
        response: {
          wordUse: 'brighten 的过去式 brightened 符合句意，且 brighten the room 搭配自然。',
          meaning: '句子表达她用灯让房间变亮。',
          grammar: '时态和结构正确。',
          naturalness: '表达自然。',
          alternative: null,
        },
      },
      {
        name: 'wrong sense for supplied gloss',
        input: { word: 'bright', meaning: '聪明的', learnerSentence: 'We sat in a bright room.' },
        response: {
          wordUse: '这里 bright 表示光线充足，不是给定的“聪明的”这一义项。',
          meaning: '句子清楚，但没有表达给定词义。',
          grammar: '语法没有明显问题。',
          naturalness: '表达自然。',
          alternative: 'She is a bright student who asks thoughtful questions.',
        },
      },
      {
        name: 'wrong part of speech',
        input: {
          word: 'bright',
          meaning: '明亮的',
          learnerSentence: 'The lamp gave the room a bright.',
        },
        response: {
          wordUse: 'bright 在给定词义中是形容词；a bright 后缺少名词，目标词用法不合适。',
          meaning: '可以推测想表达灯让房间变亮，但句子没有完整说出对象。',
          grammar: 'a bright 的名词结构不完整。',
          naturalness: '可以说 bright light。',
          alternative: 'The lamp gave the room bright light.',
        },
      },
      {
        name: 'related target omitted',
        input: {
          word: 'heavy',
          meaning: '大雨',
          learnerSentence: 'There was strong rain all night.',
        },
        response: {
          wordUse: '句子用了 strong，但没有使用目标词 heavy；heavy rain 是常见搭配。',
          meaning: '大意清楚。',
          grammar: '句子结构没有明显错误。',
          naturalness: 'strong rain 不如 heavy rain 自然。',
          alternative: 'There was heavy rain all night.',
        },
      },
    ];

    for (const example of syntheticCases) {
      expect(example.input.word.length, example.name).toBeGreaterThan(0);
      expect(parseReadingWordUseFeedback(JSON.stringify(example.response))).toEqual(
        example.response,
      );
    }
  });
});

describe('AiController reading translation feedback', () => {
  afterEach(() => vi.restoreAllMocks());

  const input = {
    sourceSentence: 'Good lighting makes a room look brighter.',
    learnerTranslation: '好的照明会让房间显得更亮。',
  };
  const result = {
    meaning: '译文保留了照明让房间显得更亮的因果关系。',
    naturalness: '中文表达清楚自然。',
  };

  it('uses the authenticated learner selected model and returns unscored formative notes', async () => {
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
        ),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);

    expect(
      await controller.readingTranslationFeedback(input, { user: { sub: 'learner-a' } }),
    ).toEqual(result);
    expect(selectedChatCompletions).toHaveBeenCalledOnce();
    const [completion, userId, signal] = selectedChatCompletions.mock.calls[0];
    expect(userId).toBe('learner-a');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(completion).toMatchObject({
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });
    expect(completion.messages[0].content).toContain('合理的意译');
    expect(completion.messages[0].content).toContain('不得给分');
    expect(JSON.parse(completion.messages[1].content)).toEqual(input);
  });

  it('does not send blank input to a model', async () => {
    const selectedChatCompletions = vi.fn();
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);
    await expect(
      controller.readingTranslationFeedback(
        { ...input, learnerTranslation: '  ' },
        { user: { sub: 'learner-a' } },
      ),
    ).rejects.toMatchObject({ constructor: BadRequestException });
    expect(selectedChatCompletions).not.toHaveBeenCalled();
  });

  it('rejects malformed provider output without exposing its raw text', async () => {
    const selectedChatCompletions = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'private provider output' } }] }),
        ),
      );
    const controller = new AiController({ selectedChatCompletions } as never, {} as never);
    await expect(
      controller.readingTranslationFeedback(input, { user: { sub: 'learner-a' } }),
    ).rejects.toMatchObject({
      constructor: BadGatewayException,
      message: expect.stringContaining('没有返回可用的翻译建议'),
    });
  });

  it('keeps only the two formative feedback fields', () => {
    expect(
      parseReadingTranslationFeedback(
        JSON.stringify({ ...result, score: 98, cefr: 'C1', mastery: true }),
      ),
    ).toEqual(result);
    expect(() => parseReadingTranslationFeedback(JSON.stringify({ meaning: '保留' }))).toThrow();
  });
});

describe('formative feedback DTO validation', () => {
  it('rejects oversized, array and nested request values using the API validation pipe', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transform = (value: unknown, metatype: new () => object) =>
      pipe.transform(value, { type: 'body', metatype });

    await expect(
      transform(
        { sourceSentence: 'x'.repeat(1201), learnerRewrite: 'valid' },
        ReadingSentenceRewriteDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { sourceSentence: ['not', 'a string'], learnerRewrite: 'valid' },
        ReadingSentenceRewriteDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { sourceSentence: 'valid', learnerRewrite: { text: 'not a string' } },
        ReadingSentenceRewriteDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { word: 'x'.repeat(101), meaning: 'valid', learnerSentence: 'valid' },
        ReadingWordUseDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { word: 'valid', meaning: ['not', 'a string'], learnerSentence: 'valid' },
        ReadingWordUseDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { word: 'valid', meaning: 'x'.repeat(501), learnerSentence: 'valid' },
        ReadingWordUseDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { word: 'valid', meaning: 'valid', learnerSentence: 'x'.repeat(1201) },
        ReadingWordUseDto,
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      transform(
        {
          sourceSentence: 'valid',
          learnerRewrite: 'valid',
          metadata: { nested: { score: 100 } },
        },
        ReadingSentenceRewriteDto,
      ),
    ).resolves.toEqual({ sourceSentence: 'valid', learnerRewrite: 'valid' });

    await expect(
      transform(
        { sourceSentence: 'x'.repeat(1201), learnerTranslation: '有效译文' },
        ReadingTranslationDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        { sourceSentence: ['不是', '字符串'], learnerTranslation: '有效译文' },
        ReadingTranslationDto,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      transform(
        {
          sourceSentence: 'Good lighting makes a room look brighter.',
          learnerTranslation: '好的照明会让房间显得更亮。',
          metadata: { score: 100 },
        },
        ReadingTranslationDto,
      ),
    ).resolves.toEqual({
      sourceSentence: 'Good lighting makes a room look brighter.',
      learnerTranslation: '好的照明会让房间显得更亮。',
    });
  });
});
