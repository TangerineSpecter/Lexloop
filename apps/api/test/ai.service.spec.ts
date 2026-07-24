import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../src/modules/ai/ai.service';

describe('AiService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses DeepSeek defaults and forwards an OpenAI-compatible request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'chatcmpl_1', choices: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { get: vi.fn((key: string) => key === 'AI_API_KEY' ? 'deepseek-key' : undefined) };
    const service = new AiService(config as never, { activeProvider: vi.fn().mockResolvedValue(null) } as never);

    const response = await service.chatCompletions({
      messages: [{ role: 'user', content: 'Explain lexical loops.' }],
      temperature: 0.2,
      tools: [{ type: 'function' }],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer deepseek-key' }),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Explain lexical loops.' }],
        temperature: 0.2,
        tools: [{ type: 'function' }],
        model: 'deepseek-v4-flash',
      }),
    }));
  });

  it('uses the configured compatible endpoint and model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { get: vi.fn((key: string) => ({ AI_API_KEY: 'key', AI_BASE_URL: 'https://example.test/v1/', AI_MODEL: 'configured-model' })[key]) };
    const service = new AiService(config as never, { activeProvider: vi.fn().mockResolvedValue(null) } as never);

    await service.chatCompletions({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/chat/completions', expect.objectContaining({ body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], model: 'configured-model' }) }));
  });

  it('uses the selected system model instead of a caller-supplied model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const selected = { apiKey: 'system-key', baseUrl: 'https://models.example.test/v1', model: 'approved-model', provider: 'OPENAI_COMPATIBLE' };
    const service = new AiService({ get: vi.fn() } as never, { activeProvider: vi.fn().mockResolvedValue(selected) } as never);

    await service.chatCompletions({ model: 'unapproved-model', messages: [{ role: 'user', content: 'Hi' }] }, 'user_1');

    expect(fetchMock).toHaveBeenCalledWith('https://models.example.test/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer system-key' }),
      body: JSON.stringify({ model: 'approved-model', messages: [{ role: 'user', content: 'Hi' }] }),
    }));
  });

  it('rejects missing configuration without making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService({ get: vi.fn() } as never, { activeProvider: vi.fn().mockResolvedValue(null) } as never);

    await expect(service.chatCompletions({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns provider errors into a safe gateway error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 422 })));
    const service = new AiService({ get: vi.fn((key: string) => key === 'AI_API_KEY' ? 'key' : undefined) } as never, { activeProvider: vi.fn().mockResolvedValue(null) } as never);

    await expect(service.chatCompletions({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toBeInstanceOf(BadGatewayException);
  });
});
