import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiModelProvider } from '@prisma/client';
import { generateLab } from '../src/modules/learning-lab/lab.processor';
import { gradeOutput } from '../src/modules/practice/output.processor';
import { AiService } from '../src/modules/ai/ai.service';
import { AiModelConfigService } from '../src/modules/admin/ai-model-config.service';
import {
  withProviderRequest,
  normalizeProviderResponse,
} from '../src/modules/ai/provider-protocol';

const mini = {
  provider: 'MINIMAX',
  baseUrl: 'https://api.minimax.cn/v1',
  model: 'MiniMax-M3.1-Flash',
  apiKey: 'fixture-secret',
  temperature: 0.5,
};
const completion = {
  base_resp: { status_code: 0 },
  choices: [
    {
      finish_reason: 'stop',
      message: { content: '{"ok":true}', reasoning_content: 'private reasoning' },
    },
  ],
};

describe('MiniMax native provider (offline)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses China OpenAI protocol, preserves JSON instruction, and strips reasoning', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(completion));
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn() } as never,
      { selectedProvider: vi.fn().mockResolvedValue(mini) } as never,
    );
    const controller = new AbortController();
    const response = await service.selectedChatCompletions(
      {
        messages: [{ role: 'user', content: 'Return the requested data.' }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 2200,
      },
      'learner',
      controller.signal,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.minimax.cn/v1/chat/completions');
    expect(init.signal).toBe(controller.signal);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: mini.model,
      reasoning_split: true,
      reasoning_effort: 'low',
      max_completion_tokens: 16384,
    });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.messages[0].content).toContain('JSON');
    expect(await response.text()).not.toContain('private reasoning');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects business errors and truncation without exposing upstream text or retrying', async () => {
    for (const payload of [
      { base_resp: { status_code: 1008, status_msg: 'fixture-secret' } },
      {
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning_content: 'fixture-secret' },
          },
        ],
      },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
      vi.stubGlobal('fetch', fetchMock);
      const service = new AiService(
        { get: vi.fn() } as never,
        { selectedProvider: vi.fn().mockResolvedValue(mini) } as never,
      );
      const error = await service
        .selectedChatCompletions({ messages: [] }, 'learner')
        .catch((error) => error);
      expect(error.message).toMatch(/未完成|长度上限/);
      expect(error.message).not.toContain('fixture-secret');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('validates a connection test using final JSON only and reports truncated generation', async () => {
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(mini) } as never,
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(completion)));
    expect(await service.testConfiguredModel('mini')).toMatchObject({
      success: true,
      structuredGeneration: 'passed',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: 'length' }] })),
    );
    expect(await service.testConfiguredModel('mini')).toMatchObject({
      success: false,
      reason: expect.stringContaining('长度上限'),
    });
  });

  it('handles split SSE frames while never forwarding reasoning', async () => {
    const source =
      'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(source);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37));
        controller.close();
      },
    });
    const result = await normalizeProviderResponse(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      mini,
    );
    const text = await result.text();
    expect(text).toContain('Hello');
    expect(text).toContain('[DONE]');
    expect(text).not.toContain('reasoning_content');
    expect(text).not.toContain('private reasoning');
  });

  it.each([generateLab, gradeOutput])(
    'applies the same protocol in asynchronous workers',
    async (process) => {
      const service = {
        claim: vi.fn().mockResolvedValue({
          done: false,
          leaseToken: 'lease',
          auditId: 'audit',
          provider: mini,
          messages: [{ role: 'user', content: 'Return JSON.' }],
        }),
        complete: vi.fn(),
        fail: vi.fn(),
      };
      const job = {
        data: { submissionId: 'submission1', workerToken: 'a'.repeat(64) },
        attemptsMade: 0,
        opts: { attempts: 1 },
      };
      const fetchMock = vi.fn().mockResolvedValue(Response.json(completion));
      vi.stubGlobal('fetch', fetchMock);
      await process(job as never, service as never);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        model: mini.model,
        max_completion_tokens: 16384,
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('response_format');
      expect(service.complete).toHaveBeenCalledWith('submission1', 'a'.repeat(64), 'lease', {
        ok: true,
      });
    },
  );

  it('rejects oversized and malformed responses with safe errors', async () => {
    await expect(
      normalizeProviderResponse(new Response('x'.repeat(2 * 1024 * 1024 + 1)), mini),
    ).rejects.toThrow('读取上限');
    await expect(
      normalizeProviderResponse(new Response('secret-invalid-json'), mini),
    ).rejects.toThrow('不是有效 JSON');
  });

  it('does not reinterpret existing custom OpenAI endpoints, models, budgets, or responses', async () => {
    const request = {
      temperature: 0.4,
      max_tokens: 2200,
      response_format: { type: 'json_object' },
      messages: [],
    };
    expect(
      withProviderRequest(request, { provider: 'OPENAI_COMPATIBLE', temperature: 0.8 }),
    ).toEqual({ ...request, temperature: 0.8 });
    expect(withProviderRequest(request, { provider: 'DEEPSEEK' })).toEqual(request);
    const response = Response.json(completion);
    expect(await normalizeProviderResponse(response, { provider: 'OPENAI_COMPATIBLE' })).toBe(
      response,
    );
  });

  it('adds the native endpoint without touching existing custom ciphertext', async () => {
    const current = {
      id: 'legacy',
      displayName: 'Existing custom',
      provider: AiModelProvider.OPENAI_COMPATIBLE,
      model: 'MiniMax-M3.1-Flash',
      baseUrl: 'https://custom.example.test/v1',
      encryptedApiKey: 'untouched-ciphertext',
      temperature: null,
    };
    const update = vi.fn().mockImplementation(({ data }) => ({ ...current, ...data }));
    const service = new AiModelConfigService(
      { aiModelConfig: { findUniqueOrThrow: vi.fn().mockResolvedValue(current), update } } as never,
      { get: vi.fn() } as never,
    );
    await service.update('legacy', { displayName: 'Renamed custom' });
    expect(update.mock.calls[0][0].data).toMatchObject({
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: current.baseUrl,
      model: current.model,
    });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('encryptedApiKey');
    const result = await service.update('legacy', { provider: AiModelProvider.MINIMAX });
    expect(update.mock.calls[1][0].data.baseUrl).toBe('https://api.minimax.cn/v1');
    expect(update.mock.calls[1][0].data).not.toHaveProperty('encryptedApiKey');
    expect(result).not.toHaveProperty('encryptedApiKey');
  });
});
