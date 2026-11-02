import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Role } from '@prisma/client';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';
import {
  AiModelConfigController,
  UpdateAiModelDto,
} from '../src/modules/admin/ai-model-config.controller';
import { AiModelConfigService } from '../src/modules/admin/ai-model-config.service';

const legacyModel = {
  id: 'model_1',
  displayName: 'Existing model',
  provider: 'OPENAI_COMPATIBLE',
  model: 'gpt-6-luna',
  baseUrl: 'https://provider.example.test/v1',
  encryptedApiKey: 'encrypted-value',
  isEnabled: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  temperature: null,
};

describe('AI model temperature configuration', () => {
  it('keeps existing null/default configuration when other model fields are edited', async () => {
    const update = vi.fn().mockImplementation(({ data }) => ({ ...legacyModel, ...data }));
    const prisma = {
      aiModelConfig: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(legacyModel),
        update,
      },
    };
    const service = new AiModelConfigService(prisma as never, { get: vi.fn() } as never);

    const result = await service.update('model_1', { displayName: 'Renamed model' });

    expect(update.mock.calls[0][0].data.temperature).toBeNull();
    expect(result.temperature).toBeNull();
    expect(result).not.toHaveProperty('encryptedApiKey');
  });

  it('preserves an existing explicit temperature when unrelated model fields are edited', async () => {
    const existing = { ...legacyModel, temperature: 0.45 };
    const update = vi.fn().mockImplementation(({ data }) => ({ ...existing, ...data }));
    const prisma = {
      aiModelConfig: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(existing),
        update,
      },
    };
    const service = new AiModelConfigService(prisma as never, { get: vi.fn() } as never);

    const result = await service.update('model_1', { displayName: 'Renamed model' });

    expect(update.mock.calls[0][0].data.temperature).toBe(0.45);
    expect(result.temperature).toBe(0.45);
  });

  it('persists an explicitly configured temperature and rejects values outside the provider-neutral range', async () => {
    const update = vi.fn().mockImplementation(({ data }) => ({ ...legacyModel, ...data }));
    const prisma = {
      aiModelConfig: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(legacyModel),
        update,
      },
    };
    const service = new AiModelConfigService(prisma as never, { get: vi.fn() } as never);

    const result = await service.update('model_1', { temperature: 0.65 });
    expect(update.mock.calls[0][0].data.temperature).toBe(0.65);
    expect(result.temperature).toBe(0.65);

    await expect(service.update('model_1', { temperature: 2.1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows an administrator to clear an explicit value and return to supplier defaults', async () => {
    const existing = { ...legacyModel, temperature: 0.65 };
    const update = vi.fn().mockImplementation(({ data }) => ({ ...existing, ...data }));
    const prisma = {
      aiModelConfig: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(existing),
        update,
      },
    };
    const service = new AiModelConfigService(prisma as never, { get: vi.fn() } as never);

    const result = await service.update('model_1', { temperature: null });

    expect(update.mock.calls[0][0].data.temperature).toBeNull();
    expect(result.temperature).toBeNull();
  });

  it('keeps configuration editing admin-only and validates the optional value', async () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AiModelConfigController) as unknown[];
    const roles = Reflect.getMetadata(ROLES_KEY, AiModelConfigController) as Role[];
    expect(guards).toHaveLength(2);
    expect(roles).toEqual([Role.ADMIN]);

    const valid = Object.assign(new UpdateAiModelDto(), { temperature: 0.65 });
    expect(await validate(valid)).toEqual([]);
    const invalid = Object.assign(new UpdateAiModelDto(), { temperature: 2.1 });
    expect((await validate(invalid)).some((error) => error.property === 'temperature')).toBe(true);
    const cleared = Object.assign(new UpdateAiModelDto(), { temperature: null });
    expect((await validate(cleared)).some((error) => error.property === 'temperature')).toBe(false);
  });
});
