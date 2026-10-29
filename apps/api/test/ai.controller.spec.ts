import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiController } from '../src/modules/ai/ai.controller';

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
    expect(completion.messages[0].content).toContain('不要打分');
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
});
