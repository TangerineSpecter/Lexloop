import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../src/modules/ai/ai.service';

describe('AiService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses DeepSeek defaults and forwards an OpenAI-compatible request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'chatcmpl_1', choices: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      get: vi.fn((key: string) => (key === 'AI_API_KEY' ? 'deepseek-key' : undefined)),
    };
    const service = new AiService(
      config as never,
      { activeProvider: vi.fn().mockResolvedValue(null) } as never,
    );

    const response = await service.chatCompletions({
      messages: [{ role: 'user', content: 'Explain lexical loops.' }],
      temperature: 0.2,
      tools: [{ type: 'function' }],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer deepseek-key' }),
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Explain lexical loops.' }],
          temperature: 0.2,
          tools: [{ type: 'function' }],
          model: 'deepseek-v4-flash',
        }),
      }),
    );
  });

  it('uses the configured compatible endpoint and model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      get: vi.fn(
        (key: string) =>
          ({
            AI_API_KEY: 'key',
            AI_BASE_URL: 'https://example.test/v1/',
            AI_MODEL: 'configured-model',
          })[key],
      ),
    };
    const service = new AiService(
      config as never,
      { activeProvider: vi.fn().mockResolvedValue(null) } as never,
    );

    await service.chatCompletions({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'configured-model',
        }),
      }),
    );
  });

  it('uses the selected system model instead of a caller-supplied model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const selected = {
      apiKey: 'system-key',
      baseUrl: 'https://models.example.test/v1',
      model: 'approved-model',
      provider: 'OPENAI_COMPATIBLE',
      temperature: null,
    };
    const service = new AiService(
      { get: vi.fn() } as never,
      { activeProvider: vi.fn().mockResolvedValue(selected) } as never,
    );

    await service.chatCompletions(
      {
        model: 'unapproved-model',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      },
      'user_1',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.example.test/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer system-key' }),
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe('approved-model');
    expect(body).not.toHaveProperty('temperature');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits the caller default for custom OpenAI models but retains structure and applies explicit model temperature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const selected = {
      apiKey: 'system-key',
      baseUrl: 'https://models.example.test/v1',
      model: 'approved-model',
      provider: 'OPENAI_COMPATIBLE',
      temperature: null,
    };
    const service = new AiService(
      { get: vi.fn() } as never,
      { selectedProvider: vi.fn().mockResolvedValue(selected) } as never,
    );

    await service.selectedChatCompletions(
      {
        messages: [{ role: 'user', content: 'Create a short practice.' }],
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      },
      'user_1',
    );

    const defaultRequest = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(defaultRequest).not.toHaveProperty('temperature');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.example.test/v1/chat/completions',
      expect.objectContaining({
        body: expect.any(String),
      }),
    );
    expect(defaultRequest.stream).toBe(true);
    expect(defaultRequest.max_tokens).toBe(2048);
    expect(defaultRequest.response_format).toEqual({ type: 'json_object' });

    fetchMock.mockClear();
    const configuredService = new AiService(
      { get: vi.fn() } as never,
      {
        selectedProvider: vi.fn().mockResolvedValue({ ...selected, temperature: 0.65 }),
      } as never,
    );
    await configuredService.selectedChatCompletions(
      {
        messages: [{ role: 'user', content: 'Explain this answer.' }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      },
      'user_1',
    );

    const explicitRequest = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(explicitRequest.temperature).toBe(0.65);
    expect(explicitRequest.response_format).toEqual({ type: 'json_object' });
  });

  it('uses the same supplier-default policy for study generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ questions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn() } as never,
      {
        selectedProvider: vi.fn().mockResolvedValue({
          apiKey: 'system-key',
          baseUrl: 'https://models.example.test/v1',
          model: 'approved-model',
          provider: 'OPENAI_COMPATIBLE',
          temperature: null,
        }),
      } as never,
    );

    await service.generateForUser(
      {
        purpose: 'study-plan',
        prompt: 'Create structured lesson content.',
        schema: { type: 'object' },
      },
      'user_1',
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('temperature');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('keeps the existing DeepSeek call-specific temperature when no model value is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn() } as never,
      {
        selectedProvider: vi.fn().mockResolvedValue({
          apiKey: 'deepseek-key',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          provider: 'DEEPSEEK',
          temperature: null,
        }),
      } as never,
    );

    await service.selectedChatCompletions(
      { messages: [{ role: 'user', content: 'Hi' }], temperature: 0.4 },
      'user_1',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).temperature).toBe(0.4);
  });

  it('rejects missing configuration without making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn() } as never,
      { activeProvider: vi.fn().mockResolvedValue(null) } as never,
    );

    await expect(
      service.chatCompletions({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns provider errors into a safe gateway error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { message: 'Your api key: sk-secret is invalid' } }),
            { status: 401 },
          ),
        ),
    );
    const service = new AiService(
      { get: vi.fn((key: string) => (key === 'AI_API_KEY' ? 'key' : undefined)) } as never,
      { activeProvider: vi.fn().mockResolvedValue(null) } as never,
    );

    const failure = service.chatCompletions({ messages: [{ role: 'user', content: 'Hi' }] });
    const caught: unknown = await failure.catch((value: unknown) => value);
    const error = caught as BadGatewayException;
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.message).toContain('模型认证未通过');
    expect(error.message).toContain('上游 HTTP 401');
    expect(error.message).not.toContain('sk-secret');
  });
});
