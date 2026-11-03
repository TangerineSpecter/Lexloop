import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MiniMaxTtsClient } from '../src/modules/tts/minimax-tts.client';
import { TtsAudioStore } from '../src/modules/tts/tts-audio-store';
import { TtsConfigService } from '../src/modules/tts/tts-config.service';
import { TtsService } from '../src/modules/tts/tts.service';

const TEST_ENCRYPTION_KEY = 'isolated-postgres-test-encryption-key-only';
const TEST_TEXT = 'A short fixture sentence for pronunciation.';
const BASE_AUDIO = Buffer.alloc(128, 0x41);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'MiniMax TTS leases and private audio cache on isolated PostgreSQL',
  () => {
    it('single-flights same-account requests across service instances and atomically stores one audio object', async () => {
      const fixture = await createFixture();
      const providerEntered = deferred();
      const finishProvider = deferred<Buffer>();
      const synthesize = vi.fn(async () => {
        providerEntered.resolve();
        return finishProvider.promise;
      });
      const serviceA = fixture.makeService(synthesize);
      const serviceB = fixture.makeService(synthesize);
      const user = await fixture.makeUser();
      const claimKey = await fixture.claimKey(serviceA, user.id, TEST_TEXT);
      fixture.trackClaim(claimKey);

      try {
        const first = serviceA.generate(user.id, TEST_TEXT, true);
        await providerEntered.promise;
        const second = serviceB.generate(user.id, TEST_TEXT, true);
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(synthesize).toHaveBeenCalledTimes(1);

        finishProvider.resolve(BASE_AUDIO);
        const results = await Promise.all([first, second]);
        expect(synthesize).toHaveBeenCalledTimes(1);
        expect(results.map((result) => result.cache).sort()).toEqual(['generated', 'reused']);
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: user.id } })).toBe(1);
        expect(
          await fixture.admin.ttsAudioGenerationClaim.count({ where: { cacheKey: claimKey } }),
        ).toBe(0);
        expect(
          await fixture.admin.ttsDailyUsage.findMany({
            where: { userId: user.id },
            select: { generationCount: true, characterCount: true },
          }),
        ).toEqual([{ generationCount: 1, characterCount: Array.from(TEST_TEXT).length }]);

        const files = await readdir(fixture.audioDirectory);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[a-f0-9]{32}\.mp3$/);
        expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
        const cache = await fixture.admin.ttsAudioCache.findFirstOrThrow({
          where: { userId: user.id },
        });
        expect(await fixture.store.read(cache.objectName)).toEqual(BASE_AUDIO);
      } finally {
        finishProvider.resolve(BASE_AUDIO);
        await fixture.cleanup();
      }
    }, 20_000);

    it('keeps identical text private across accounts and rejects cross-account audio reads', async () => {
      const fixture = await createFixture();
      const synthesize = vi.fn(async (_text: string, _settings: unknown) =>
        Buffer.from(BASE_AUDIO),
      );
      const serviceA = fixture.makeService(synthesize);
      const serviceB = fixture.makeService(synthesize);
      const [userA, userB] = await Promise.all([fixture.makeUser(), fixture.makeUser()]);
      const [keyA, keyB] = await Promise.all([
        fixture.claimKey(serviceA, userA.id, TEST_TEXT),
        fixture.claimKey(serviceB, userB.id, TEST_TEXT),
      ]);
      fixture.trackClaim(keyA);
      fixture.trackClaim(keyB);

      try {
        const [resultA, resultB] = await Promise.all([
          serviceA.generate(userA.id, TEST_TEXT, true),
          serviceB.generate(userB.id, TEST_TEXT, true),
        ]);
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(resultA.audioId).not.toBe(resultB.audioId);
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: userA.id } })).toBe(1);
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: userB.id } })).toBe(1);
        await expect(serviceB.readAudio(userB.id, resultA.audioId)).rejects.toThrow(
          '不存在或无权访问',
        );
        expect(
          await fixture.admin.ttsAudioGenerationClaim.count({
            where: { cacheKey: { in: [keyA, keyB] } },
          }),
        ).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);

    it('does not call the provider when a paused pre-provider owner loses its expired lease', async () => {
      const fixture = await createFixture();
      const synthesize = vi.fn(async () => Buffer.from(BASE_AUDIO));
      const serviceA = fixture.makeService(synthesize);
      const serviceB = fixture.makeService(synthesize);
      const user = await fixture.makeUser();
      const claimKey = await fixture.claimKey(serviceA, user.id, TEST_TEXT);
      fixture.trackClaim(claimKey);
      const oldAuditCreated = deferred();
      const resumeOldOwner = deferred();
      const internals = serviceA as unknown as {
        startAudit: (userId: string, model: string, purpose: string) => Promise<string>;
      };
      const originalStartAudit = internals.startAudit.bind(serviceA);
      let pauseFirstAudit = true;
      internals.startAudit = async (userId, model, purpose) => {
        const auditId = await originalStartAudit(userId, model, purpose);
        if (pauseFirstAudit) {
          pauseFirstAudit = false;
          oldAuditCreated.resolve();
          await resumeOldOwner.promise;
        }
        return auditId;
      };

      try {
        const staleRequest = serviceA.generate(user.id, TEST_TEXT, true);
        await oldAuditCreated.promise;
        const staleClaim = await fixture.admin.ttsAudioGenerationClaim.findUniqueOrThrow({
          where: { cacheKey: claimKey },
        });
        expect(staleClaim.ownerToken).toBeTruthy();

        await fixture.admin.ttsAudioGenerationClaim.update({
          where: { cacheKey: claimKey },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        const takeoverResult = await serviceB.generate(user.id, TEST_TEXT, true);
        resumeOldOwner.resolve();
        await expect(staleRequest).rejects.toThrow('租约已失效');

        expect(synthesize).toHaveBeenCalledTimes(1);
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: user.id } })).toBe(1);
        expect(
          await fixture.admin.ttsAudioCache.findFirstOrThrow({ where: { userId: user.id } }),
        ).toMatchObject({
          id: takeoverResult.audioId,
        });
        expect(
          await fixture.admin.ttsDailyUsage.findMany({
            where: { userId: user.id },
            select: { generationCount: true, characterCount: true },
          }),
        ).toEqual([{ generationCount: 1, characterCount: Array.from(TEST_TEXT).length }]);
        const audits = await fixture.admin.aiCallAudit.findMany({
          where: { userId: user.id, purpose: 'tts.synthesis' },
          orderBy: { createdAt: 'asc' },
          select: { status: true },
        });
        expect(audits.map(({ status }) => status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
      } finally {
        resumeOldOwner.resolve();
        await fixture.cleanup();
      }
    }, 20_000);

    it('rechecks the absolute lease immediately before fetch after a renewed owner resumes late', async () => {
      const fixture = await createFixture();
      const providerFetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              base_resp: { status_code: 0 },
              data: { audio: BASE_AUDIO.toString('hex') },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal('fetch', providerFetch);
      const serviceA = fixture.makeServiceWithClient(new MiniMaxTtsClient());
      const serviceB = fixture.makeServiceWithClient(new MiniMaxTtsClient());
      const user = await fixture.makeUser();
      const claimKey = await fixture.claimKey(serviceA, user.id, TEST_TEXT);
      fixture.trackClaim(claimKey);
      const renewedLease = deferred<Date | null>();
      const resumeOldOwner = deferred();
      const internals = serviceA as unknown as {
        renewClaimBeforeProviderCall: (
          cacheKey: string,
          ownerToken: string,
        ) => Promise<Date | null>;
      };
      const originalRenew = internals.renewClaimBeforeProviderCall.bind(serviceA);
      let pauseAfterSuccessfulRenew = true;
      internals.renewClaimBeforeProviderCall = async (key, token) => {
        const expiresAt = await originalRenew(key, token);
        if (pauseAfterSuccessfulRenew) {
          pauseAfterSuccessfulRenew = false;
          renewedLease.resolve(expiresAt);
          await resumeOldOwner.promise;
        }
        return expiresAt;
      };

      try {
        const staleRequest = serviceA.generate(user.id, TEST_TEXT, true);
        const absoluteExpiry = await renewedLease.promise;
        expect(absoluteExpiry).toBeInstanceOf(Date);

        await fixture.admin.ttsAudioGenerationClaim.update({
          where: { cacheKey: claimKey },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        const takeoverResult = await serviceB.generate(user.id, TEST_TEXT, true);
        expect(providerFetch).toHaveBeenCalledTimes(1);

        const realDateNow = Date.now;
        vi.spyOn(Date, 'now').mockImplementation(() => absoluteExpiry!.getTime() + 1);
        resumeOldOwner.resolve();
        await expect(staleRequest).rejects.toThrow('租约剩余时间不足');
        vi.spyOn(Date, 'now').mockImplementation(realDateNow);

        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: user.id } })).toBe(1);
        await expect(
          fixture.admin.ttsAudioCache.findFirstOrThrow({ where: { userId: user.id } }),
        ).resolves.toMatchObject({ id: takeoverResult.audioId });
        expect(
          await fixture.admin.ttsDailyUsage.findMany({
            where: { userId: user.id },
            select: { generationCount: true, characterCount: true },
          }),
        ).toEqual([{ generationCount: 1, characterCount: Array.from(TEST_TEXT).length }]);
        const audits = await fixture.admin.aiCallAudit.findMany({
          where: { userId: user.id, purpose: 'tts.synthesis' },
          orderBy: { createdAt: 'asc' },
          select: { status: true, errorCode: true },
        });
        expect(audits.map(({ status }) => status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
        expect(audits.find(({ status }) => status === 'FAILED')?.errorCode).toBe(
          'TTS_LEASE_EXPIRED',
        );
      } finally {
        resumeOldOwner.resolve();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await fixture.cleanup();
      }
    }, 20_000);

    it('refunds one original reservation once without reducing a concurrent reservation', async () => {
      const fixture = await createFixture();
      const service = fixture.makeService(async () => Buffer.from(BASE_AUDIO));
      const user = await fixture.makeUser();
      const internals = service as unknown as {
        startAudit: (userId: string, model: string, purpose: string) => Promise<string>;
        reserveDailyUsage: (
          userId: string,
          text: string,
          limit: number,
        ) => Promise<{
          userId: string;
          dateKey: string;
          characterCount: number;
        }>;
        releaseDailyUsage: (
          reservation: { userId: string; dateKey: string; characterCount: number },
          auditId: string,
        ) => Promise<void>;
      };
      const provider = await fixture.admin.ttsProviderConfig.findUniqueOrThrow({
        where: { id: 'global' },
      });
      const refundedAuditId = await internals.startAudit(user.id, provider.model, 'tts.synthesis');
      const remainingAuditId = await internals.startAudit(user.id, provider.model, 'tts.synthesis');
      const refundReservation = await internals.reserveDailyUsage(
        user.id,
        'short',
        provider.maxGenerationsPerUserPerDay,
      );
      const remainingReservation = await internals.reserveDailyUsage(
        user.id,
        'a longer concurrent reservation',
        provider.maxGenerationsPerUserPerDay,
      );

      try {
        expect(refundReservation.userId).toBe(user.id);
        expect(refundReservation.dateKey).toBe(remainingReservation.dateKey);
        await Promise.all([
          internals.releaseDailyUsage(refundReservation, refundedAuditId),
          internals.releaseDailyUsage(refundReservation, refundedAuditId),
        ]);

        const usage = await fixture.admin.ttsDailyUsage.findUniqueOrThrow({
          where: {
            userId_dateKey: {
              userId: remainingReservation.userId,
              dateKey: remainingReservation.dateKey,
            },
          },
        });
        expect(usage).toMatchObject({
          generationCount: 1,
          characterCount: remainingReservation.characterCount,
        });
        expect(
          await fixture.admin.aiCallAudit.findUniqueOrThrow({ where: { id: refundedAuditId } }),
        ).toMatchObject({ status: 'FAILED', errorCode: 'TTS_REQUEST_NOT_DISPATCHED' });
        expect(
          await fixture.admin.aiCallAudit.findUniqueOrThrow({ where: { id: remainingAuditId } }),
        ).toMatchObject({ status: 'PENDING' });

        await internals.releaseDailyUsage(remainingReservation, remainingAuditId);
        expect(
          await fixture.admin.ttsDailyUsage.findUnique({
            where: {
              userId_dateKey: {
                userId: remainingReservation.userId,
                dateKey: remainingReservation.dateKey,
              },
            },
          }),
        ).toBeNull();
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);

    it('does not let an old in-flight provider response overwrite the newer lease owner', async () => {
      const fixture = await createFixture();
      const providerEntered = deferred();
      const finishOldProvider = deferred<Buffer>();
      const synthesize = vi.fn(async () => {
        if (synthesize.mock.calls.length === 1) {
          providerEntered.resolve();
          return finishOldProvider.promise;
        }
        return Buffer.alloc(128, 0x62);
      });
      const serviceA = fixture.makeService(synthesize);
      const serviceB = fixture.makeService(synthesize);
      const user = await fixture.makeUser();
      const claimKey = await fixture.claimKey(serviceA, user.id, TEST_TEXT);
      fixture.trackClaim(claimKey);

      try {
        const oldRequest = serviceA.generate(user.id, TEST_TEXT, true);
        await providerEntered.promise;
        await fixture.admin.ttsAudioGenerationClaim.update({
          where: { cacheKey: claimKey },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        const newResult = await serviceB.generate(user.id, TEST_TEXT, true);
        finishOldProvider.resolve(Buffer.alloc(128, 0x11));
        const oldResult = await oldRequest;

        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(oldResult).toEqual({ audioId: newResult.audioId, cache: 'reused' });
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: user.id } })).toBe(1);
        const cached = await fixture.admin.ttsAudioCache.findFirstOrThrow({
          where: { userId: user.id },
        });
        expect(await fixture.store.read(cached.objectName)).toEqual(Buffer.alloc(128, 0x62));
        expect((await readdir(fixture.audioDirectory)).sort()).toEqual([cached.objectName]);
      } finally {
        finishOldProvider.resolve(Buffer.alloc(128, 0x11));
        await fixture.cleanup();
      }
    }, 20_000);

    it('places failed requests into cooldown without issuing an automatic retry', async () => {
      const fixture = await createFixture();
      const synthesize = vi
        .fn<(_text: string, _settings: unknown) => Promise<Buffer>>()
        .mockRejectedValueOnce(new Error('mock provider failure'))
        .mockResolvedValue(Buffer.from(BASE_AUDIO));
      const service = fixture.makeService(synthesize);
      const user = await fixture.makeUser();
      const claimKey = await fixture.claimKey(service, user.id, TEST_TEXT);
      fixture.trackClaim(claimKey);

      try {
        await expect(service.generate(user.id, TEST_TEXT, true)).rejects.toThrow();
        const cooledClaim = await fixture.admin.ttsAudioGenerationClaim.findUniqueOrThrow({
          where: { cacheKey: claimKey },
        });
        expect(cooledClaim.ownerToken).toBeNull();
        expect(cooledClaim.retryAfter?.getTime()).toBeGreaterThan(Date.now());
        await expect(service.generate(user.id, TEST_TEXT, true)).rejects.toMatchObject({
          status: 429,
        });
        expect(synthesize).toHaveBeenCalledTimes(1);

        const firstCache = await fixture.admin.ttsAudioCache
          .findFirstOrThrow({
            where: { userId: user.id },
          })
          .catch(() => null);
        expect(firstCache).toBeNull();
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);

    it('rebuilds a missing audio object only after another explicit generation request', async () => {
      const fixture = await createFixture();
      const synthesize = vi.fn(async () => Buffer.from(BASE_AUDIO));
      const service = fixture.makeService(synthesize);
      const user = await fixture.makeUser();
      const claimKey = await fixture.claimKey(service, user.id, TEST_TEXT);
      fixture.trackClaim(claimKey);

      try {
        const first = await service.generate(user.id, TEST_TEXT, true);
        const firstCache = await fixture.admin.ttsAudioCache.findUniqueOrThrow({
          where: { id: first.audioId },
        });
        await fixture.store.remove(firstCache.objectName);
        await expect(service.lookup(user.id, TEST_TEXT)).resolves.toEqual({ state: 'missing' });
        expect(synthesize).toHaveBeenCalledTimes(1);
        const rebuilt = await service.generate(user.id, TEST_TEXT, true);
        expect(rebuilt.cache).toBe('generated');
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(await fixture.admin.ttsAudioCache.count({ where: { userId: user.id } })).toBe(1);
        const newCache = await fixture.admin.ttsAudioCache.findUniqueOrThrow({
          where: { id: rebuilt.audioId },
        });
        expect(await fixture.store.read(newCache.objectName)).toEqual(BASE_AUDIO);
        expect((await readdir(fixture.audioDirectory)).sort()).toEqual([newCache.objectName]);
        expect(
          await fixture.admin.ttsDailyUsage.findMany({ where: { userId: user.id } }),
        ).toMatchObject([{ generationCount: 2, characterCount: Array.from(TEST_TEXT).length * 2 }]);
      } finally {
        await fixture.cleanup();
      }
    }, 20_000);
  },
);

async function createFixture() {
  const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const serviceClients = [
    new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
    new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
  ];
  const audioDirectory = await mkdtemp(join(tmpdir(), 'lexloop-tts-pg-test-'));
  const config = {
    get: (key: string) => {
      if (key === 'AI_CONFIG_ENCRYPTION_KEY') return TEST_ENCRYPTION_KEY;
      if (key === 'LEXLOOP_TTS_AUDIO_DIR') return audioDirectory;
      if (key === 'APP_TIMEZONE') return 'Asia/Shanghai';
      return undefined;
    },
  };
  const settings = new TtsConfigService(admin as never, config as never);
  await settings.save({
    enabled: true,
    region: 'CHINA',
    model: 'speech-2.8-hd',
    voiceId: 'Fixture_English',
    speed: 1,
    volume: 1,
    pitch: 0,
    maxGenerationsPerUserPerDay: 10,
    apiKey: 'no-network-mock-only',
  });
  const logs = { record: vi.fn().mockResolvedValue(undefined) };
  const users: string[] = [];
  const claimKeys = new Set<string>();
  const stores = serviceClients.map(() => new TtsAudioStore(config as never));
  let createdUserIndex = 0;

  function makeService(synthesize: (_text: string, _settings: unknown) => Promise<Buffer>) {
    const client = {
      synthesize: vi.fn(
        async (
          text: string,
          providerSettings: unknown,
          dispatchLease?: { onDispatch?: () => void },
        ) => {
          dispatchLease?.onDispatch?.();
          return synthesize(text, providerSettings);
        },
      ),
    };
    return makeServiceWithClient(client as never);
  }

  function makeServiceWithClient(client: MiniMaxTtsClient) {
    const ttsSettings = new TtsConfigService(admin as never, config as never);
    const store = stores[createdUserIndex % stores.length];
    createdUserIndex += 1;
    return new TtsService(
      serviceClients[(createdUserIndex - 1) % serviceClients.length] as never,
      config as never,
      ttsSettings,
      client as never,
      store,
      logs as never,
    );
  }

  return {
    admin,
    audioDirectory,
    makeService,
    makeServiceWithClient,
    makeUser: async () => {
      const user = await admin.user.create({
        data: {
          email: `tts-isolated-${randomUUID()}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      users.push(user.id);
      return user;
    },
    claimKey: async (service: TtsService, userId: string, text: string) => {
      const instance = service as unknown as {
        cacheKey: (userId: string, text: string, settings: Record<string, unknown>) => string;
      };
      const provider = await settings.providerConfig();
      return instance.cacheKey(userId, text, provider);
    },
    trackClaim: (cacheKey: string) => claimKeys.add(cacheKey),
    store: stores[0],
    cleanup: async () => {
      const cached = users.length
        ? await admin.ttsAudioCache.findMany({
            where: { userId: { in: users } },
            select: { objectName: true },
          })
        : [];
      for (const row of cached) await stores[0].remove(row.objectName).catch(() => undefined);
      if (claimKeys.size) {
        await admin.ttsAudioGenerationClaim.deleteMany({
          where: { cacheKey: { in: [...claimKeys] } },
        });
      }
      await admin.ttsProviderConfig.deleteMany({ where: { id: 'global' } });
      if (users.length) await admin.user.deleteMany({ where: { id: { in: users } } });
      for (const store of stores) await store.closeSweepDirectory().catch(() => undefined);
      await Promise.all([...serviceClients, admin].map((client) => client.$disconnect()));
      await rm(audioDirectory, { recursive: true, force: true });
    },
  };
}
