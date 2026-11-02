import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModelConfigService } from '../admin/ai-model-config.service';
import { withProviderTemperature } from './model-temperature';

export interface ChatCompletionRequest {
  model?: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  response_format?: unknown;
}
export type OpenAiChatCompletionRequest = ChatCompletionRequest & Record<string, unknown>;

export interface GenerateRequest {
  purpose: string;
  prompt: string;
  schema?: Record<string, unknown>;
}
export interface AiProvider {
  generate(request: GenerateRequest): Promise<unknown>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ModelConnectionTestResult {
  success: boolean;
  endpoint: 'responded' | 'unreachable';
  authentication: 'accepted' | 'rejected' | 'unknown';
  selectedModel: 'accepted' | 'unknown';
  structuredGeneration: 'passed' | 'failed' | 'not_run';
  upstreamStatus?: number;
  code?: string;
  param?: string;
  reason: string;
}

type ProviderErrorDetails = Pick<ModelConnectionTestResult, 'upstreamStatus' | 'code' | 'param'> & {
  reason: string;
};

const MODEL_TEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_BODY_BYTES = 8 * 1024;
const MODEL_TEST_SYSTEM_PROMPT =
  'Return only a JSON object with one property named "ok" set to true.';
const MODEL_TEST_USER_PROMPT = 'Return exactly {"ok":true}.';
const SAFE_PROVIDER_CODES = new Set([
  'invalid_api_key',
  'unsupported_value',
  'model_not_found',
  'context_length_exceeded',
  'rate_limit_exceeded',
  'insufficient_quota',
  'invalid_request_error',
  'server_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'invalid_parameter',
  'unsupported_parameter',
]);
const SAFE_PROVIDER_PARAMS = new Set([
  'authorization',
  'model',
  'messages',
  'messages[0].content',
  'messages[1].content',
  'messages.0.content',
  'messages.1.content',
  'response_format',
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'top_p',
  'stream',
  'tools',
  'tool_choice',
  'frequency_penalty',
  'presence_penalty',
]);

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

@Injectable()
export class AiService implements AiProvider {
  constructor(
    private readonly config: ConfigService,
    private readonly modelConfigs: AiModelConfigService,
  ) {}

  async chatCompletions(request: OpenAiChatCompletionRequest, userId?: string): Promise<Response> {
    const configured = await this.modelConfigs.activeProvider(userId);
    const apiKey = configured?.apiKey || this.config.get<string>('AI_API_KEY');
    if (!apiKey)
      throw new ServiceUnavailableException('AI 服务尚未配置：请在 API 环境变量中设置 AI_API_KEY');

    const baseUrl = (
      configured?.baseUrl ||
      this.config.get<string>('AI_BASE_URL') ||
      DEEPSEEK_BASE_URL
    ).replace(/\/+$/, '');
    const model =
      configured?.model || this.config.get<string>('AI_MODEL') || DEEPSEEK_DEFAULT_MODEL;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(withProviderTemperature({ ...request, model }, configured)),
      });
    } catch {
      throw new BadGatewayException('AI Provider 无法连接，请检查 AI_BASE_URL 或稍后重试');
    }

    if (!response.ok) throw new BadGatewayException(await this.providerError(response, apiKey));
    return response;
  }

  async selectedChatCompletions(
    request: OpenAiChatCompletionRequest,
    userId: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const configured = await this.modelConfigs.selectedProvider(userId);
    if (!configured) {
      throw new ServiceUnavailableException('请先在阅读材料模型设置中选择可用的大模型');
    }
    let response: Response;
    try {
      response = await fetch(`${configured.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${configured.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          withProviderTemperature({ ...request, model: configured.model }, configured),
        ),
        signal,
      });
    } catch {
      throw new BadGatewayException('AI Provider 无法连接，请检查模型配置或稍后重试');
    }
    if (!response.ok)
      throw new BadGatewayException(await this.providerError(response, configured.apiKey));
    return response;
  }

  async testConfiguredModel(id: string): Promise<ModelConnectionTestResult> {
    const configured = await this.modelConfigs.providerForTest(id);
    let response: Response;
    try {
      response = await fetch(`${configured.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${configured.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          withProviderTemperature(
            {
              model: configured.model,
              messages: [
                { role: 'system', content: MODEL_TEST_SYSTEM_PROMPT },
                { role: 'user', content: MODEL_TEST_USER_PROMPT },
              ],
              temperature: 0.7,
              response_format: { type: 'json_object' },
            },
            configured,
          ),
        ),
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        success: false,
        endpoint: 'unreachable',
        authentication: 'unknown',
        selectedModel: 'unknown',
        structuredGeneration: 'not_run',
        reason: timedOut
          ? `测试请求超过 ${MODEL_TEST_TIMEOUT_MS / 1000} 秒，未收到接口响应。`
          : '未收到接口响应；请检查 API 地址、TLS 证书或网络连接。',
      };
    }

    if (!response.ok) {
      const details = await this.providerErrorDetails(response, configured.apiKey);
      return {
        success: false,
        endpoint: 'responded',
        authentication: response.status === 401 || response.status === 403 ? 'rejected' : 'unknown',
        selectedModel: 'unknown',
        structuredGeneration: 'not_run',
        ...details,
      };
    }

    const parsed = await readJsonResponse(response);
    if (!parsed.ok || !isChatCompletionResponse(parsed.value)) {
      return {
        success: false,
        endpoint: 'responded',
        authentication: 'unknown',
        selectedModel: 'unknown',
        structuredGeneration: 'failed',
        upstreamStatus: response.status,
        reason: parsed.truncated
          ? '接口响应超过诊断读取上限，未显示响应内容。'
          : '接口已接受请求，但没有返回可解析的结构化生成结果。',
      };
    }

    if (!isSuccessfulModelTest(parsed.value)) {
      return {
        success: false,
        endpoint: 'responded',
        authentication: 'accepted',
        selectedModel: 'accepted',
        structuredGeneration: 'failed',
        upstreamStatus: response.status,
        reason: '模型返回了兼容响应，但未完成要求的结构化生成。',
      };
    }

    return {
      success: true,
      endpoint: 'responded',
      authentication: 'accepted',
      selectedModel: 'accepted',
      structuredGeneration: 'passed',
      upstreamStatus: response.status,
      reason: '本次简短结构化生成请求已成功返回并解析。',
    };
  }

  async generateForUser(request: GenerateRequest, userId: string): Promise<unknown> {
    const response = await this.selectedChatCompletions(
      {
        messages: [
          {
            role: 'system',
            content: '你是 Lexloop 的英语学习内容设计师。只输出符合要求的 JSON，不输出 Markdown。',
          },
          { role: 'user', content: request.prompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      },
      userId,
    );
    return response.json();
  }

  async generate(request: GenerateRequest): Promise<unknown> {
    const response = await this.chatCompletions({
      messages: [{ role: 'user', content: request.prompt }],
      ...(request.schema ? { response_format: { type: 'json_object' } } : {}),
    });
    return response.json();
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new ServiceUnavailableException(
      '当前 AI Provider 仅配置了 Chat Completions；嵌入模型适配器尚未配置',
    );
  }

  async explain(text: string) {
    return this.generate({ purpose: 'explain', prompt: text });
  }

  private async providerError(response: Response, apiKey: string): Promise<string> {
    const details = await this.providerErrorDetails(response, apiKey);
    const diagnostic = [
      `上游 HTTP ${details.upstreamStatus}`,
      details.code ? `code: ${details.code}` : undefined,
      details.param ? `param: ${details.param}` : undefined,
    ]
      .filter(Boolean)
      .join('；');
    return `${details.reason}（${diagnostic}）`;
  }

  private async providerErrorDetails(
    response: Response,
    apiKey: string,
  ): Promise<ProviderErrorDetails> {
    const body = await readJsonResponse(response);
    const root = isRecord(body.value) ? body.value : undefined;
    const error = root && isRecord(root.error) ? root.error : root;
    // Provider messages can echo prompts, credentials, or request headers. Expose only
    // allow-listed machine fields and status-derived guidance; never forward raw text.
    const code = safeProviderField(error?.code, apiKey, SAFE_PROVIDER_CODES);
    const param = safeProviderField(error?.param, apiKey, SAFE_PROVIDER_PARAMS);
    let reason: string;
    if (body.truncated) {
      reason = '供应商错误响应过长，已隐藏原文。';
    } else if (!body.ok) {
      reason = '接口返回了非 JSON 错误响应；请检查 API 地址是否指向兼容接口。';
    } else if (response.status === 401 || response.status === 403) {
      reason = '模型认证未通过，请检查已保存的 API Key 和供应商权限。';
    } else if (response.status === 404) {
      reason = '接口或模型路由未找到，请检查 API 地址与模型配置。';
    } else if (response.status === 408) {
      reason = '供应商处理请求超时。';
    } else if (response.status === 429) {
      reason = '请求被限流或额度策略拒绝。';
    } else if (response.status >= 500) {
      reason = '供应商暂时无法处理请求。';
    } else {
      reason = '供应商未接受本次请求，请核对模型名称和请求参数。';
    }
    return {
      upstreamStatus: response.status,
      ...(code ? { code } : {}),
      ...(param ? { param } : {}),
      reason,
    };
  }
}

async function readJsonResponse(response: Response): Promise<{
  ok: boolean;
  value?: unknown;
  truncated: boolean;
}> {
  const { text, truncated } = await readLimitedBody(response);
  if (truncated) return { ok: false, truncated: true };
  try {
    return { ok: true, value: JSON.parse(text) as unknown, truncated: false };
  } catch {
    return { ok: false, truncated: false };
  }
}

async function readLimitedBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = MAX_PROVIDER_BODY_BYTES - byteLength;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        byteLength += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } catch {
    return { text: '', truncated: true };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSuccessfulModelTest(value: unknown): boolean {
  if (!isChatCompletionResponse(value)) return false;
  const firstChoice = value.choices[0];
  const content = firstChoice.message.content;
  if (typeof content !== 'string') return false;
  try {
    const result: unknown = JSON.parse(content);
    return isRecord(result) && result.ok === true;
  } catch {
    return false;
  }
}

function isChatCompletionResponse(
  value: unknown,
): value is { choices: Array<{ message: { content: unknown } }> } {
  if (!isRecord(value) || !Array.isArray(value.choices) || !value.choices.length) return false;
  const firstChoice = value.choices[0];
  return isRecord(firstChoice) && isRecord(firstChoice.message) && 'content' in firstChoice.message;
}

function safeProviderField(
  value: unknown,
  apiKey: string,
  allowedValues: ReadonlySet<string>,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  let result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!result || /<\/?(?:html|body|script|pre|title|!doctype)\b/i.test(result)) return undefined;
  if (apiKey) result = result.split(apiKey).join('[已隐藏]');
  result = result
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, '[已隐藏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]');
  return allowedValues.has(result) ? result : undefined;
}
