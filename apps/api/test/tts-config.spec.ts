import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Role, TtsRegion } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TtsAdminController } from '../src/modules/tts/tts-admin.controller';
import { TtsConfigService } from '../src/modules/tts/tts-config.service';

function harness(encryptionKey = 'test-encryption-key-that-is-not-a-real-secret') {
  let stored: Record<string, unknown> | null = null;
  const prisma = {
    ttsProviderConfig: {
      findUnique: vi.fn(async () => stored),
      upsert: vi.fn(async ({ create, update }: { create: unknown; update: unknown }) => {
        stored = { ...(stored ?? (create as object)), ...(update as object) };
        return stored;
      }),
    },
  };
  const config = {
    get: vi.fn((key: string) => (key === 'AI_CONFIG_ENCRYPTION_KEY' ? encryptionKey : undefined)),
  };
  return {
    service: new TtsConfigService(prisma as never, config as never),
    prisma,
    read: () => stored,
  };
}

describe('TtsConfigService', () => {
  it('defaults disabled with the user supplied voice example, and never returns a stored secret', async () => {
    const { service, prisma } = harness();
    const value = await service.publicConfig();
    expect(value).toMatchObject({
      enabled: false,
      region: null,
      model: 'speech-2.8-hd',
      voiceId: 'English_captivating_female1',
      hasApiKey: false,
    });
    expect(value).not.toHaveProperty('encryptedApiKey');
    expect(prisma.ttsProviderConfig.upsert).not.toHaveBeenCalled();
  });

  it('encrypts an administrator key at rest and only returns hasApiKey', async () => {
    const { service, read } = harness();
    const publicConfig = await service.save({
      enabled: true,
      region: TtsRegion.CHINA,
      apiKey: 'mock-only-key-value',
    });
    const stored = read() as Record<string, unknown>;

    expect(stored.encryptedApiKey).toEqual(expect.any(String));
    expect(stored.encryptedApiKey).not.toBe('mock-only-key-value');
    expect(JSON.stringify(publicConfig)).not.toContain('mock-only-key-value');
    expect(publicConfig).not.toHaveProperty('encryptedApiKey');
    expect(publicConfig.hasApiKey).toBe(true);
    expect((await service.providerConfig()).apiKey).toBe('mock-only-key-value');
  });

  it('requires disabled/default configuration to remain safe without an encryption secret', async () => {
    const { service } = harness('change-this-development-key');
    await expect(
      service.save({ enabled: false, apiKey: 'mock-only-key-value' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.save({ speed: 2.1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires key, region and voice before enabling; clearing an active key is rejected', async () => {
    const { service } = harness();
    await expect(service.save({ enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    await service.save({ enabled: true, region: TtsRegion.CHINA, apiKey: 'mock-only-key' });
    await expect(service.save({ clearApiKey: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bounds the per-account daily generation ceiling', async () => {
    const { service } = harness();
    await expect(service.save({ maxGenerationsPerUserPerDay: 101 })).rejects.toThrow(
      '1 到 100 之间',
    );
  });

  it('protects admin configuration and connection testing with ADMIN role guards', () => {
    const guards = Reflect.getMetadata('__guards__', TtsAdminController) as unknown[];
    const roles = Reflect.getMetadata('roles', TtsAdminController) as Role[];
    expect(guards).toHaveLength(2);
    expect(roles).toEqual([Role.ADMIN]);
  });
});
