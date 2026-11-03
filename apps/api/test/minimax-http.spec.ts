import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiController, ChatCompletionDto } from '../src/modules/ai/ai.controller';
import { AiService } from '../src/modules/ai/ai.service';
import { AiModelConfigService } from '../src/modules/admin/ai-model-config.service';

const config = {
  provider: 'MINIMAX',
  baseUrl: 'https://api.minimax.cn/v1',
  model: 'MiniMax-M3.1-Flash',
  apiKey: 'test-only-key',
};
let provider = config;
const activeProvider = vi.fn(async () => provider);
const fetchMock = vi.fn();
let app: NestFastifyApplication;
let token: string;

beforeAll(async () => {
  Reflect.defineMetadata('design:paramtypes', [AiService, AiModelConfigService], AiController);
  Reflect.defineMetadata(
    'design:paramtypes',
    [ChatCompletionDto, Object, Object],
    AiController.prototype,
    'chatCompletions',
  );
  const jwt = new JwtService({ secret: 'offline-http-test-secret' });
  const module = await Test.createTestingModule({
    controllers: [AiController],
    providers: [
      { provide: JwtService, useValue: jwt },
      {
        provide: ConfigService,
        useValue: { get: vi.fn(), getOrThrow: () => 'offline-http-test-secret' },
      },
      { provide: AiModelConfigService, useValue: { activeProvider } },
      {
        provide: AiService,
        useFactory: () => new AiService({ get: vi.fn() } as never, { activeProvider } as never),
      },
    ],
  }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  token = await jwt.signAsync({ sub: 'authenticated-learner' });
});
beforeEach(() => {
  provider = config;
  fetchMock
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }),
    );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => app?.close());
const post = (limits: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/ai/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { messages: [{ role: 'user', content: 'Hello' }], ...limits },
  });

describe('authenticated MiniMax completion HTTP budget boundary', () => {
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    it.each([-1, 0, 1.5, '100', 'Infinity', null, {}, [], 32769, 524288, 1e100])(
      `rejects invalid ${key}=%j before any provider request`,
      async (value) => {
        const result = await post({ [key]: value });
        expect(result.statusCode).toBe(400);
        expect(result.json().message).toContain(key);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
    it.each([1, 32768])(`accepts ${key} boundary %s`, async (value) => {
      const result = await post({ [key]: value });
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.max_completion_tokens).toBe(
        key === 'max_tokens' ? Math.max(16384, value) : value,
      );
      expect(body).not.toHaveProperty('max_tokens');
    });
  }
  it('validates both fields even when the explicit completion limit takes precedence', async () => {
    expect((await post({ max_tokens: -1, max_completion_tokens: 1000 })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await post({ max_tokens: 2200, max_completion_tokens: 24000 })).statusCode).toBe(201);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_completion_tokens).toBe(24000);
  });
  it('keeps the default bounded and ordinary overrides working', async () => {
    expect((await post({})).statusCode).toBe(201);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_completion_tokens).toBe(16384);
    expect((await post({ max_tokens: 20000 })).statusCode).toBe(201);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_completion_tokens).toBe(20000);
  });
  it.each(['DEEPSEEK', 'OPENAI_COMPATIBLE'])(
    'does not clamp or rewrite %s token fields',
    async (kind) => {
      provider = { ...config, provider: kind };
      expect((await post({ max_tokens: 65536, max_completion_tokens: 131072 })).statusCode).toBe(
        201,
      );
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        max_tokens: 65536,
        max_completion_tokens: 131072,
      });
    },
  );
});

describe('public MiniMax SSE responses', () => {
  it.each([false, true])('reports completion accurately (normal=%s)', async (normal) => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      ...(normal
        ? ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']
        : []),
    ];
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              const chunk = chunks.shift();
              if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
              else controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const result = await post({ stream: true });
    expect(result.statusCode).toBe(201);
    expect(result.headers['content-type']).toContain('text/event-stream');
    expect(result.body.includes('STREAM_INCOMPLETE')).toBe(!normal);
    expect(result.body.includes('[DONE]')).toBe(normal);
    expect(result.body).not.toContain('test-only-key');
  });
});
