import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtsService } from '../src/modules/tts/tts.service';

const provider = {
  enabled: true,
  region: 'CHINA',
  model: 'speech-2.8-hd',
  voiceId: 'English_captivating_female1',
  speed: 1,
  volume: 1,
  pitch: 0,
  maxGenerationsPerUserPerDay: 10,
  apiKey: 'mock-only-key',
};

function harness(
  options: {
    readyCache?: unknown;
    ownerAvailable?: boolean;
    dailyLimit?: boolean;
    enabled?: boolean;
    audio?: Buffer | null;
  } = {},
) {
  let claim: { ownerToken: string; leaseExpiresAt: Date } | null = null;
  const cacheRows: Array<Record<string, unknown>> = [];
  const findCache = vi.fn(
    async (_input: { where: { cacheKey: string } }) => (options.readyCache as never) ?? null,
  );
  const deleteClaim = vi.fn(async () => {
    claim = null;
    return { count: 1 };
  });
  const prisma = {
    ttsAudioCache: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: findCache,
      findFirst: vi.fn().mockResolvedValue(options.readyCache ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        cacheRows.push(data);
        return data;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _sum: { byteSize: 0 } }),
    },
    ttsAudioGenerationClaim: {
      create: vi.fn(async ({ data }: { data: { ownerToken: string; leaseExpiresAt: Date } }) => {
        claim = data;
        return data;
      }),
      findUnique: vi.fn(async () => claim),
      findFirst: vi.fn(async () => (options.ownerAvailable === false ? null : claim)),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: deleteClaim,
    },
    ttsDailyUsage: {
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: options.dailyLimit === false ? 0 : 1 }),
      deleteMany: vi.fn(),
    },
    aiCallAudit: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    aiCallAudit: { updateMany: prisma.aiCallAudit.updateMany },
    ttsAudioCache: {
      aggregate: prisma.ttsAudioCache.aggregate,
      findMany: prisma.ttsAudioCache.findMany,
      deleteMany: prisma.ttsAudioCache.deleteMany,
      create: prisma.ttsAudioCache.create,
    },
    ttsAudioGenerationClaim: {
      findFirst: prisma.ttsAudioGenerationClaim.findFirst,
      deleteMany: vi.fn(async () => {
        claim = null;
        return { count: 1 };
      }),
    },
    ttsDailyUsage: {
      updateMany: prisma.ttsDailyUsage.updateMany,
      deleteMany: prisma.ttsDailyUsage.deleteMany,
    },
  };
  const store = {
    exists: vi.fn().mockResolvedValue(false),
    read: vi.fn().mockResolvedValue(options.audio ?? null),
    write: vi.fn().mockResolvedValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3'),
    remove: vi.fn().mockResolvedValue(undefined),
    takeOldObjectCandidates: vi.fn().mockResolvedValue([]),
    removeOldCandidate: vi.fn().mockResolvedValue(undefined),
    closeSweepDirectory: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    synthesize: vi.fn(
      async (_text: string, _settings: unknown, dispatchLease?: { onDispatch?: () => void }) => {
        dispatchLease?.onDispatch?.();
        return Buffer.alloc(128, 0x42);
      },
    ),
  };
  const settings = {
    publicConfig: vi.fn().mockResolvedValue({ ...provider, hasApiKey: true }),
    providerConfig: vi.fn().mockResolvedValue({ ...provider, enabled: options.enabled ?? true }),
  };
  const config = {
    get: vi.fn((key: string) =>
      key === 'AI_CONFIG_ENCRYPTION_KEY'
        ? 'test-encryption-key-that-is-not-a-real-secret'
        : undefined,
    ),
  };
  const logs = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new TtsService(
    prisma as never,
    config as never,
    settings as never,
    client as never,
    store as never,
    logs as never,
  );
  return { service, prisma, tx, store, client, settings, logs, cacheRows, claim: () => claim };
}

afterEach(() => vi.useRealTimers());

describe('TtsService', () => {
  it('only performs a lookup when the user has not confirmed generation', async () => {
    const { service, client, prisma } = harness();
    await expect(service.lookup('user-a', 'A short sentence.')).resolves.toEqual({ state: 'miss' });
    expect(client.synthesize).not.toHaveBeenCalled();
    expect(prisma.ttsAudioCache.findUnique.mock.calls.at(0)?.[0].where.cacheKey).not.toContain(
      'A short sentence.',
    );
  });

  it('keeps otherwise identical cached words in separate user fingerprints', async () => {
    const { service, prisma } = harness();
    await service.lookup('user-a', 'café');
    await service.lookup('user-b', 'café');
    const calls = prisma.ttsAudioCache.findUnique.mock.calls;
    const keys = calls.map((call) => call[0].where.cacheKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(calls.every((call) => !('text' in call[0].where))).toBe(true);
  });

  it('marks a missing object as missing and removes only that account cache row', async () => {
    const row = {
      id: 'audio-a',
      userId: 'user-a',
      objectName: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3',
      mimeType: 'audio/mpeg',
    };
    const { service, prisma, store } = harness({ readyCache: row });
    prisma.ttsAudioCache.findUnique.mockResolvedValueOnce(row as never);
    await expect(service.lookup('user-a', 'a word')).resolves.toEqual({ state: 'missing' });
    expect(prisma.ttsAudioCache.deleteMany).toHaveBeenCalledWith({
      where: { id: 'audio-a', userId: 'user-a' },
    });
    expect(store.exists).toHaveBeenCalledWith(row.objectName);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('checks cache ownership in the audio query and rejects another account', async () => {
    const row = {
      id: 'audio-a',
      userId: 'user-a',
      objectName: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3',
      mimeType: 'audio/mpeg',
      byteSize: 128,
      audioSha256: createHash('sha256').update(Buffer.alloc(128, 0x42)).digest('hex'),
    };
    const { service, prisma, store } = harness({ readyCache: row });
    prisma.ttsAudioCache.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.readAudio('user-b', 'audio-a')).rejects.toThrow('不存在或无权访问');
    expect(prisma.ttsAudioCache.findFirst).toHaveBeenCalledWith({
      where: { id: 'audio-a', userId: 'user-b' },
    });
    expect(store.read).not.toHaveBeenCalled();
  });

  it('drops a restored database row when its private audio object is missing', async () => {
    const row = {
      id: 'audio-a',
      userId: 'user-a',
      objectName: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3',
      mimeType: 'audio/mpeg',
      byteSize: 128,
      audioSha256: createHash('sha256').update(Buffer.alloc(128, 0x42)).digest('hex'),
    };
    const { service, prisma } = harness({ readyCache: row });
    await expect(service.readAudio('user-a', 'audio-a')).rejects.toThrow('播放并确认后按需生成');
    expect(prisma.ttsAudioCache.deleteMany).toHaveBeenCalledWith({
      where: { id: 'audio-a', userId: 'user-a' },
    });
  });

  it('rejects a cache file whose content no longer matches its metadata', async () => {
    const row = {
      id: 'audio-a',
      userId: 'user-a',
      objectName: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3',
      mimeType: 'audio/mpeg',
      byteSize: 128,
      audioSha256: '0'.repeat(64),
    };
    const { service, prisma, store } = harness({ readyCache: row, audio: Buffer.alloc(128, 0x42) });
    await expect(service.readAudio('user-a', 'audio-a')).rejects.toThrow('校验失败');
    expect(prisma.ttsAudioCache.deleteMany).toHaveBeenCalledWith({
      where: { id: 'audio-a', userId: 'user-a' },
    });
    expect(store.remove).toHaveBeenCalledWith(row.objectName);
  });

  it('cleans old orphan audio and temp files but retains files referenced by cache rows', async () => {
    const orphan = `${'a'.repeat(32)}.mp3`;
    const referenced = `${'b'.repeat(32)}.mp3`;
    const temporary = `${'c'.repeat(32)}.mp3.${'d'.repeat(32)}.tmp`;
    const { service, prisma, store } = harness();
    store.takeOldObjectCandidates.mockResolvedValueOnce([orphan, referenced, temporary]);
    prisma.ttsAudioCache.findMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ objectName: referenced }] as never);

    await (
      service as unknown as { pruneExpiredCacheBatch: () => Promise<void> }
    ).pruneExpiredCacheBatch();

    expect(store.takeOldObjectCandidates).toHaveBeenCalledWith(expect.any(Date));
    expect(prisma.ttsAudioCache.findMany).toHaveBeenNthCalledWith(2, {
      where: { objectName: { in: [orphan, referenced] } },
      select: { objectName: true },
    });
    expect(store.removeOldCandidate).toHaveBeenCalledTimes(2);
    expect(store.removeOldCandidate).toHaveBeenCalledWith(orphan);
    expect(store.removeOldCandidate).toHaveBeenCalledWith(temporary);
    expect(store.removeOldCandidate).not.toHaveBeenCalledWith(referenced);
  });

  it('rejects generation without explicit consent and makes no provider request', async () => {
    const { service, client, prisma } = harness();
    await expect(service.generate('user-a', 'Hello.', false)).rejects.toThrow(
      '需要确认文本会发送给 MiniMax 且可能产生费用',
    );
    expect(client.synthesize).not.toHaveBeenCalled();
    expect(prisma.ttsAudioGenerationClaim.create).not.toHaveBeenCalled();
  });

  it('does not allow a direct API request to generate while the administrator switch is off', async () => {
    const { service, client, prisma } = harness({ enabled: false });
    await expect(service.generate('user-a', 'Hello.', true)).rejects.toThrow(
      '管理员尚未启用 MiniMax 语音合成',
    );
    expect(client.synthesize).not.toHaveBeenCalled();
    expect(prisma.ttsAudioGenerationClaim.create).not.toHaveBeenCalled();
  });

  it('generates once, saves only private fingerprint and settings metadata, and enforces a user cache lock', async () => {
    const { service, prisma, tx, client, store, cacheRows } = harness();
    const result = await service.generate('user-a', 'A learner sentence.', true);
    expect(result).toEqual({ audioId: expect.any(String), cache: 'generated' });
    expect(client.synthesize).toHaveBeenCalledTimes(1);
    expect(prisma.ttsDailyUsage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(cacheRows).toHaveLength(1);
    expect(JSON.stringify(cacheRows[0])).not.toContain('A learner sentence.');
    expect(JSON.stringify(cacheRows[0])).not.toContain(provider.apiKey);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('releases the lease and does not call the provider when the daily quota is exhausted', async () => {
    const { service, client, prisma } = harness({ dailyLimit: false });
    await expect(service.generate('user-a', 'Hello.', true)).rejects.toBeInstanceOf(HttpException);
    expect(client.synthesize).not.toHaveBeenCalled();
    expect(prisma.ttsAudioGenerationClaim.deleteMany).toHaveBeenCalledWith({
      where: { cacheKey: expect.any(String), ownerToken: expect.any(String) },
    });
  });

  it('does not save generated audio if the lease is lost before the transaction', async () => {
    const { service, tx, prisma, client, store, cacheRows } = harness({ ownerAvailable: false });
    await expect(service.generate('user-a', 'Hello.', true)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(client.synthesize).toHaveBeenCalledTimes(1);
    expect(tx.ttsAudioCache.create).not.toHaveBeenCalled();
    expect(cacheRows).toHaveLength(0);
    expect(store.write).not.toHaveBeenCalled();
  });
});
