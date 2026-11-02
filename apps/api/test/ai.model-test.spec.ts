import { BadGatewayException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Role } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { AiModelTestController } from '../src/modules/ai/ai-model-test.controller';
import { AiService } from '../src/modules/ai/ai.service';

const configuredModel = {
  id: 'model_1',
  displayName: 'Configured test model',
  baseUrl: 'https://provider.example.test/v1/',
  model: 'selected-model',
  apiKey: 'stored-secret-value',
  provider: 'OPENAI_COMPATIBLE',
};

describe('AI model connection test', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes one small structured request using only the saved configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = { providerForTest: vi.fn().mockResolvedValue(configuredModel) };
    const service = new AiService({ get: vi.fn() } as never, models as never);

    const result = await service.testConfiguredModel('model_1');

    expect(models.providerForTest).toHaveBeenCalledTimes(1);
    expect(models.providerForTest).toHaveBeenCalledWith('model_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer stored-secret-value' }),
        body: JSON.stringify({
          model: 'selected-model',
          messages: [
            {
              role: 'system',
              content: 'Return only a JSON object with one property named "ok" set to true.',
            },
            { role: 'user', content: 'Return exactly {"ok":true}.' },
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      endpoint: 'responded',
      authentication: 'accepted',
      selectedModel: 'accepted',
      structuredGeneration: 'passed',
      upstreamStatus: 200,
    });
    expect(JSON.stringify(result)).not.toContain('stored-secret-value');
  });

  it('reports safe authentication and provider diagnostics without returning secrets or prompt data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_api_key',
            param: 'authorization',
            message:
              'Key stored-secret-value rejected; Authorization: Bearer leaked-token-123456789; Return exactly {"ok":true}.',
          },
        }),
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(configuredModel) } as never,
    );

    const result = await service.testConfiguredModel('model_1');
    const output = JSON.stringify(result);

    expect(result).toMatchObject({
      success: false,
      endpoint: 'responded',
      authentication: 'rejected',
      selectedModel: 'unknown',
      structuredGeneration: 'not_run',
      upstreamStatus: 401,
      code: 'invalid_api_key',
      param: 'authorization',
    });
    expect(output).not.toContain('stored-secret-value');
    expect(output).not.toContain('leaked-token-123456789');
    expect(output).not.toContain('Return exactly');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not echo HTML error pages and keeps reachability separate from unknown auth/model status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html><body>proxy debug page</body></html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(configuredModel) } as never,
    );

    const result = await service.testConfiguredModel('model_1');

    expect(result).toMatchObject({
      success: false,
      endpoint: 'responded',
      authentication: 'unknown',
      selectedModel: 'unknown',
      structuredGeneration: 'not_run',
      upstreamStatus: 404,
    });
    expect(JSON.stringify(result)).not.toContain('proxy debug page');
    expect(result.reason).toContain('非 JSON');
  });

  it('does not infer auth or model acceptance from an unrecognized successful response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"choices":[]}', { status: 200 })),
    );
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(configuredModel) } as never,
    );

    const result = await service.testConfiguredModel('model_1');

    expect(result).toMatchObject({
      success: false,
      endpoint: 'responded',
      authentication: 'unknown',
      selectedModel: 'unknown',
      structuredGeneration: 'failed',
      reason: '接口已接受请求，但没有返回可解析的结构化生成结果。',
    });
  });

  it('separates a recognized model response from a failed structured generation', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ choices: [{ message: { content: '{"ok":false}' } }] })),
    );
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(configuredModel) } as never,
    );

    const result = await service.testConfiguredModel('model_1');

    expect(result).toMatchObject({
      success: false,
      endpoint: 'responded',
      authentication: 'accepted',
      selectedModel: 'accepted',
      structuredGeneration: 'failed',
    });
  });

  it('omits provider code and parameter values outside the safe machine-field allowlists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'private_study_answer', param: 'private_answer' } },
            { status: 400 },
          ),
        ),
    );
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(configuredModel) } as never,
    );

    const result = await service.testConfiguredModel('model_1');

    expect(result.upstreamStatus).toBe(400);
    expect(result).not.toHaveProperty('code');
    expect(result).not.toHaveProperty('param');
    expect(JSON.stringify(result)).not.toContain('private_study_answer');
    expect(JSON.stringify(result)).not.toContain('private_answer');
  });

  it('reports a network failure without exposing the fetch error and never retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Authorization: stored-secret-value'));
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn() } as never,
      { providerForTest: vi.fn().mockResolvedValue(configuredModel) } as never,
    );

    const result = await service.testConfiguredModel('model_1');

    expect(result).toMatchObject({
      success: false,
      endpoint: 'unreachable',
      authentication: 'unknown',
      selectedModel: 'unknown',
      structuredGeneration: 'not_run',
    });
    expect(JSON.stringify(result)).not.toContain('stored-secret-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry after an upstream 400 and safely includes status, code, param and reason in generation errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'unsupported_value',
            param: 'response_format',
            message: 'Unsupported value; echoed prompt: private study input',
          },
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(
      { get: vi.fn((key: string) => (key === 'AI_API_KEY' ? 'env-key' : undefined)) } as never,
      { activeProvider: vi.fn().mockResolvedValue(null) } as never,
    );

    const failure = service.chatCompletions({
      messages: [{ role: 'user', content: 'private study input' }],
    });
    const caught: unknown = await failure.catch((value: unknown) => value);
    const error = caught as BadGatewayException;
    const response = error.getResponse() as { message: string };
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(response.message).toContain('上游 HTTP 400');
    expect(response.message).toContain('code: unsupported_value');
    expect(response.message).toContain('param: response_format');
    expect(response.message).not.toContain('private study input');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a not-found response for a deleted saved configuration without calling a provider', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const models = { providerForTest: vi.fn().mockRejectedValue(new NotFoundException()) };
    const service = new AiService({ get: vi.fn() } as never, models as never);

    await expect(service.testConfiguredModel('removed')).rejects.toBeInstanceOf(NotFoundException);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('AiModelTestController access metadata', () => {
  it('requires administrator role and both JWT and role guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AiModelTestController)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AiModelTestController)).toHaveLength(2);
  });

  it('only delegates the requested saved model id', async () => {
    const testConfiguredModel = vi.fn().mockResolvedValue({ success: true });
    const logs = { record: vi.fn() };
    const controller = new AiModelTestController({ testConfiguredModel } as never, logs as never);

    await expect(controller.test('saved-model-id')).resolves.toEqual({ success: true });
    expect(testConfiguredModel).toHaveBeenCalledTimes(1);
    expect(testConfiguredModel).toHaveBeenCalledWith('saved-model-id');
    expect(logs.record).not.toHaveBeenCalled();
  });

  it('records only the safe failure code and status for an explicit model test', async () => {
    const testConfiguredModel = vi.fn().mockResolvedValue({
      success: false,
      code: 'unsupported_value',
      upstreamStatus: 400,
      param: 'response_format',
      reason: '供应商未接受本次请求，请核对模型名称和请求参数。',
    });
    const logs = { record: vi.fn().mockResolvedValue('written') };
    const controller = new AiModelTestController({ testConfiguredModel } as never, logs as never);

    await controller.test('saved-model-id');

    expect(logs.record).toHaveBeenCalledTimes(1);
    expect(logs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MODEL_TEST_unsupported_value',
        upstreamStatus: 400,
        param: 'response_format',
        route: '/api/v1/admin/ai-models/:id/test',
      }),
    );
  });
});

describe('RolesGuard protects model testing', () => {
  it('does not grant a missing or ordinary user role access', () => {
    const guard = new RolesGuard({
      getAllAndOverride: () => [Role.ADMIN],
    } as never);
    const context = {
      getHandler: () => undefined,
      getClass: () => AiModelTestController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: Role.USER } }) }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(ForbiddenException);
  });
});
