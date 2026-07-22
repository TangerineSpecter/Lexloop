import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GenerateRequest { purpose: string; prompt: string; schema?: Record<string, unknown>; }
export interface AiProvider { generate(request: GenerateRequest): Promise<unknown>; embed(texts: string[]): Promise<number[][]>; }

@Injectable()
export class AiService implements AiProvider {
  constructor(private readonly config: ConfigService) {}

  private unavailable(): never {
    if (!this.config.get<string>('AI_API_KEY')) throw new ServiceUnavailableException('AI 服务尚未配置：请在 API 环境变量中设置 AI_API_KEY');
    throw new ServiceUnavailableException('AI Provider Adapter 尚未实现：请配置具体模型供应商适配器');
  }
  async generate(_request: GenerateRequest): Promise<unknown> { return this.unavailable(); }
  async embed(_texts: string[]): Promise<number[][]> { return this.unavailable(); }
  async explain(text: string) { return this.generate({ purpose: 'explain', prompt: text }); }
}
