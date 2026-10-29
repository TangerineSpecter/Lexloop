import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModelConfigService } from '../admin/ai-model-config.service';

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
        body: JSON.stringify({ ...request, model }),
      });
    } catch {
      throw new BadGatewayException('AI Provider 无法连接，请检查 AI_BASE_URL 或稍后重试');
    }

    if (!response.ok) throw new BadGatewayException(await this.providerError(response));
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
        body: JSON.stringify({ ...request, model: configured.model }),
        signal,
      });
    } catch {
      throw new BadGatewayException('AI Provider 无法连接，请检查模型配置或稍后重试');
    }
    if (!response.ok) throw new BadGatewayException(await this.providerError(response));
    return response;
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

  private async providerError(response: Response): Promise<string> {
    try {
      await response.json();
    } catch {
      /* Provider returned a non-JSON error body. */
    }
    if (response.status === 401 || response.status === 403)
      return '模型认证失败，请在模型设置中检查 API Key 是否有效后重试。';
    if (response.status === 404) return '模型接口不存在，请检查 API 地址和模型配置。';
    if (response.status === 408 || response.status === 429)
      return '模型服务暂时繁忙或额度不足，请稍后再试。';
    if (response.status >= 500) return '模型服务暂时不可用，请稍后再试。';
    return '模型请求未被接受，请检查模型名称和参数配置。';
  }
}
