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

export interface GenerateRequest { purpose: string; prompt: string; schema?: Record<string, unknown>; }
export interface AiProvider { generate(request: GenerateRequest): Promise<unknown>; embed(texts: string[]): Promise<number[][]>; }

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

@Injectable()
export class AiService implements AiProvider {
  constructor(private readonly config: ConfigService, private readonly modelConfigs: AiModelConfigService) {}

  async chatCompletions(request: OpenAiChatCompletionRequest, userId?: string): Promise<Response> {
    const configured = await this.modelConfigs.activeProvider(userId);
    const apiKey = configured?.apiKey || this.config.get<string>('AI_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException('AI 服务尚未配置：请在 API 环境变量中设置 AI_API_KEY');

    const baseUrl = (configured?.baseUrl || this.config.get<string>('AI_BASE_URL') || DEEPSEEK_BASE_URL).replace(/\/+$/, '');
    const model = configured?.model || this.config.get<string>('AI_MODEL') || DEEPSEEK_DEFAULT_MODEL;

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

    if (!response.ok) {
      const detail = await this.providerError(response);
      throw new BadGatewayException(`AI Provider 请求失败（${response.status}）：${detail}`);
    }
    return response;
  }

  async selectedChatCompletions(request: OpenAiChatCompletionRequest, userId: string): Promise<Response> {
    const configured = await this.modelConfigs.selectedProvider(userId);
    if (!configured) {
      throw new ServiceUnavailableException('请先在阅读材料模型设置中选择可用的大模型');
    }
    let response: Response;
    try {
      response = await fetch(`${configured.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${configured.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, model: configured.model }),
      });
    } catch {
      throw new BadGatewayException('AI Provider 无法连接，请检查模型配置或稍后重试');
    }
    if (!response.ok) {
      const detail = await this.providerError(response);
      throw new BadGatewayException(`AI Provider 请求失败（${response.status}）：${detail}`);
    }
    return response;
  }

  async generateForUser(request: GenerateRequest, userId: string): Promise<unknown> {
    const response = await this.selectedChatCompletions({
      messages: [
        { role: 'system', content: '你是 Lexloop 的英语学习内容设计师。只输出符合要求的 JSON，不输出 Markdown。' },
        { role: 'user', content: request.prompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    }, userId);
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
    throw new ServiceUnavailableException('当前 AI Provider 仅配置了 Chat Completions；嵌入模型适配器尚未配置');
  }

  async explain(text: string) { return this.generate({ purpose: 'explain', prompt: text }); }

  private async providerError(response: Response): Promise<string> {
    try {
      const payload: unknown = await response.json();
      if (typeof payload === 'object' && payload !== null) {
        const error = (payload as { error?: unknown }).error;
        if (typeof error === 'string') return error;
        if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
      }
    } catch { /* Provider returned a non-JSON error body. */ }
    return '请检查模型、请求参数和 Provider 配置';
  }
}
