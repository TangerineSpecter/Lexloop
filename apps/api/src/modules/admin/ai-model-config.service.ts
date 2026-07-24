import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModelProvider } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

export type AiModelInput = { displayName: string; provider: AiModelProvider; model: string; apiKey?: string; baseUrl?: string };

@Injectable()
export class AiModelConfigService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async list() {
    const models = await this.prisma.aiModelConfig.findMany({ orderBy: { createdAt: 'asc' } });
    return models.map(({ encryptedApiKey, ...model }) => ({ ...model, hasApiKey: Boolean(encryptedApiKey) }));
  }

  async listEnabled(userId: string) {
    const models = await this.prisma.aiModelConfig.findMany({ where: { isEnabled: true }, orderBy: { createdAt: 'asc' } });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { selectedAiModelId: true } });
    const selectedId = user?.selectedAiModelId;
    return models.map(({ id, displayName, provider, model }) => ({ id, displayName, provider, model, isSelected: id === selectedId }));
  }

  async create(input: AiModelInput & { apiKey: string }) {
    const normalized = this.normalize(input);
    return this.prisma.aiModelConfig.create({ data: { ...normalized, encryptedApiKey: this.encrypt(input.apiKey) } }).then(this.toPublic);
  }

  async update(id: string, input: Partial<AiModelInput>) {
    const current = await this.prisma.aiModelConfig.findUniqueOrThrow({ where: { id } });
    const normalized = this.normalize({ ...current, ...input });
    const model = await this.prisma.aiModelConfig.update({
      where: { id },
      data: { ...normalized, ...(input.apiKey ? { encryptedApiKey: this.encrypt(input.apiKey) } : {}) },
    });
    return this.toPublic(model);
  }

  async setEnabled(id: string, isEnabled: boolean) { return this.prisma.aiModelConfig.update({ where: { id }, data: { isEnabled } }).then(this.toPublic); }
  async remove(id: string) { await this.prisma.aiModelConfig.delete({ where: { id } }); return { id }; }

  async selectForUser(userId: string, modelId: string) {
    const model = await this.prisma.aiModelConfig.findFirst({ where: { id: modelId, isEnabled: true }, select: { id: true } });
    if (!model) throw new BadRequestException('该模型不存在或已关闭');
    await this.prisma.user.update({ where: { id: userId }, data: { selectedAiModelId: model.id } });
    return { id: model.id };
  }

  async activeProvider(userId?: string) {
    const selected = userId ? await this.prisma.user.findUnique({ where: { id: userId }, select: { selectedAiModel: true } }) : null;
    const model = selected?.selectedAiModel?.isEnabled ? selected.selectedAiModel : await this.prisma.aiModelConfig.findFirst({ where: { isEnabled: true }, orderBy: { createdAt: 'asc' } });
    return model ? { baseUrl: model.baseUrl, model: model.model, apiKey: this.decrypt(model.encryptedApiKey), provider: model.provider } : null;
  }

  async selectedProvider(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { selectedAiModel: true },
    });
    const model = user?.selectedAiModel;
    if (!model?.isEnabled) return null;
    return {
      id: model.id,
      displayName: model.displayName,
      baseUrl: model.baseUrl,
      model: model.model,
      apiKey: this.decrypt(model.encryptedApiKey),
      provider: model.provider,
    };
  }

  private normalize(input: { displayName?: string; provider: AiModelProvider; model?: string; baseUrl?: string }) {
    const displayName = input.displayName?.trim();
    const model = input.model?.trim();
    const baseUrl = input.provider === AiModelProvider.DEEPSEEK ? 'https://api.deepseek.com' : input.baseUrl?.trim().replace(/\/+$/, '');
    if (!displayName || !model || !baseUrl) throw new BadRequestException('请填写展示名称、模型与 API 地址');
    try { new URL(baseUrl); } catch { throw new BadRequestException('API 地址必须是完整的 URL'); }
    return { displayName, model, baseUrl, provider: input.provider };
  }

  private toPublic<T extends { encryptedApiKey: string }>(model: T) { const { encryptedApiKey, ...result } = model; return { ...result, hasApiKey: Boolean(encryptedApiKey) }; }
  private encryptionKey() {
    const secret = this.config.get<string>('AI_CONFIG_ENCRYPTION_KEY');
    if (!secret || secret.startsWith('change-this-')) throw new ServiceUnavailableException('请设置安全的 AI_CONFIG_ENCRYPTION_KEY 后再保存模型密钥');
    return createHash('sha256').update(secret).digest();
  }
  private encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv); const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${content.toString('base64')}`; }
  private decrypt(value: string) { try { const [iv, tag, content] = value.split('.').map(part => Buffer.from(part, 'base64')); const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8'); } catch { throw new ServiceUnavailableException('模型密钥无法解密，请重新配置该模型'); } }
}
