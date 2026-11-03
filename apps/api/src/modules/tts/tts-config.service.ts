import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtsProviderConfig, TtsRegion } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

export type TtsConfigInput = {
  enabled?: boolean;
  region?: TtsRegion | null;
  model?: string;
  voiceId?: string | null;
  speed?: number;
  volume?: number;
  pitch?: number;
  apiKey?: string;
  clearApiKey?: boolean;
  maxGenerationsPerUserPerDay?: number;
};

export type PublicTtsConfig = Omit<TtsProviderConfig, 'encryptedApiKey'> & {
  hasApiKey: boolean;
};

const CONFIG_ID = 'global';
const DEFAULTS = {
  id: CONFIG_ID,
  enabled: false,
  region: null as TtsRegion | null,
  model: 'speech-2.8-hd',
  voiceId: 'English_captivating_female1',
  speed: 1,
  volume: 1,
  pitch: 0,
  encryptedApiKey: null as string | null,
  maxGenerationsPerUserPerDay: 100,
};

@Injectable()
export class TtsConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async publicConfig(): Promise<PublicTtsConfig> {
    const row = await this.prisma.ttsProviderConfig.findUnique({ where: { id: CONFIG_ID } });
    const config = row ?? { ...DEFAULTS, createdAt: new Date(0), updatedAt: new Date(0) };
    const { encryptedApiKey, ...publicFields } = config;
    return { ...publicFields, hasApiKey: Boolean(encryptedApiKey) };
  }

  async save(input: TtsConfigInput): Promise<PublicTtsConfig> {
    if (input.apiKey !== undefined && input.clearApiKey) {
      throw new BadRequestException('不能同时设置和清除 API Key');
    }
    if (input.apiKey !== undefined && (!input.apiKey.trim() || input.apiKey.length > 1000)) {
      throw new BadRequestException('API Key 不能为空且不能超过 1000 个字符');
    }
    const current = await this.prisma.ttsProviderConfig.findUnique({ where: { id: CONFIG_ID } });
    const currentSettings = current ?? DEFAULTS;
    const normalized = {
      enabled: input.enabled ?? currentSettings.enabled,
      region: input.region === undefined ? currentSettings.region : input.region,
      model: normalizeText(input.model, currentSettings.model, 100, '模型名称'),
      voiceId: normalizeOptionalText(input.voiceId, currentSettings.voiceId, 200, '音色 ID'),
      speed: input.speed ?? currentSettings.speed,
      volume: input.volume ?? currentSettings.volume,
      pitch: input.pitch ?? currentSettings.pitch,
      maxGenerationsPerUserPerDay:
        input.maxGenerationsPerUserPerDay ?? currentSettings.maxGenerationsPerUserPerDay,
    };
    validateSettings(normalized);

    const encryptedApiKey = input.clearApiKey
      ? null
      : input.apiKey !== undefined
        ? this.encrypt(input.apiKey.trim())
        : (current?.encryptedApiKey ?? null);
    if (normalized.enabled && (!encryptedApiKey || !normalized.region || !normalized.voiceId)) {
      throw new BadRequestException('启用语音合成前，请配置 API Key、服务区域和音色 ID');
    }

    await this.prisma.ttsProviderConfig.upsert({
      where: { id: CONFIG_ID },
      create: { ...normalized, id: CONFIG_ID, encryptedApiKey },
      update: { ...normalized, encryptedApiKey },
    });
    return this.publicConfig();
  }

  async providerConfig() {
    const row = await this.prisma.ttsProviderConfig.findUnique({ where: { id: CONFIG_ID } });
    if (!row?.encryptedApiKey || !row.region || !row.voiceId) {
      throw new ServiceUnavailableException('管理员尚未完成语音模型配置');
    }
    return {
      enabled: row.enabled,
      region: row.region,
      model: row.model,
      voiceId: row.voiceId,
      speed: row.speed,
      volume: row.volume,
      pitch: row.pitch,
      maxGenerationsPerUserPerDay: row.maxGenerationsPerUserPerDay,
      apiKey: this.decrypt(row.encryptedApiKey),
    };
  }

  private encryptionKey() {
    const secret = this.config.get<string>('AI_CONFIG_ENCRYPTION_KEY');
    if (!secret || secret.startsWith('change-this-')) {
      throw new ServiceUnavailableException('语音密钥加密尚未配置');
    }
    return createHash('sha256').update(secret).digest();
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${content.toString('base64')}`;
  }

  private decrypt(value: string) {
    try {
      const [iv, tag, content] = value.split('.').map((part) => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('语音 API Key 无法解密，请重新配置');
    }
  }
}

function normalizeText(input: string | undefined, fallback: string, max: number, label: string) {
  const value = (input ?? fallback).trim();
  if (!value || value.length > max || /[\r\n]/.test(value)) {
    throw new BadRequestException(`${label}不能为空，且不能超过 ${max} 个字符`);
  }
  return value;
}

function normalizeOptionalText(
  input: string | null | undefined,
  fallback: string | null,
  max: number,
  label: string,
) {
  const value = input === undefined ? fallback : input;
  if (value === null || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > max || /[\r\n]/.test(normalized)) {
    throw new BadRequestException(`${label}不能超过 ${max} 个字符`);
  }
  return normalized;
}

function validateSettings(input: {
  region: TtsRegion | null;
  model: string;
  voiceId: string | null;
  speed: number;
  volume: number;
  pitch: number;
  maxGenerationsPerUserPerDay: number;
}) {
  if (input.region !== null && !Object.values(TtsRegion).includes(input.region)) {
    throw new BadRequestException('请选择有效的 MiniMax 服务区域');
  }
  if (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2) {
    throw new BadRequestException('语速必须在 0.5 到 2 之间');
  }
  if (!Number.isFinite(input.volume) || input.volume < 0.1 || input.volume > 10) {
    throw new BadRequestException('音量必须在 0.1 到 10 之间');
  }
  if (!Number.isInteger(input.pitch) || input.pitch < -12 || input.pitch > 12) {
    throw new BadRequestException('音调必须在 -12 到 12 之间');
  }
  if (
    !Number.isInteger(input.maxGenerationsPerUserPerDay) ||
    input.maxGenerationsPerUserPerDay < 1 ||
    input.maxGenerationsPerUserPerDay > 100
  ) {
    throw new BadRequestException('每账号每日生成上限必须在 1 到 100 之间');
  }
}
