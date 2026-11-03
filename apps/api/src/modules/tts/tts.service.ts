import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtsProviderConfig } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemLogService } from '../admin/system-log.service';
import {
  MiniMaxTtsClient,
  MiniMaxTtsError,
  MINIMAX_TTS_REQUEST_TIMEOUT_MS,
} from './minimax-tts.client';
import { TtsAudioStore } from './tts-audio-store';
import { TtsConfigService } from './tts-config.service';

const MAX_TEXT_CODEPOINTS = 2_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_BYTES_PER_USER = 256 * 1024 * 1024;
const CACHE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const CACHE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const CLAIM_LEASE_SAFETY_MARGIN_MS = 15_000;
const CLAIM_LEASE_MS = MINIMAX_TTS_REQUEST_TIMEOUT_MS + CLAIM_LEASE_SAFETY_MARGIN_MS;
const CLAIM_WAIT_MS = 47_000;
const CLAIM_POLL_MS = 250;
const FAILURE_COOLDOWN_MS = 15_000;
const MAX_DAILY_CHARACTERS = 20_000;
const TEST_SENTENCE = 'Hello. This is a short speech test.';

type CacheLookup =
  { state: 'disabled' | 'miss' | 'missing' } | { state: 'hit'; audioId: string; mimeType: string };
type DailyUsageReservation = { userId: string; dateKey: string; characterCount: number };

@Injectable()
export class TtsService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: TtsConfigService,
    private readonly client: MiniMaxTtsClient,
    private readonly store: TtsAudioStore,
    private readonly logs: SystemLogService,
  ) {}

  onModuleInit() {
    this.cleanupTimer = setInterval(() => {
      void this.pruneExpiredCacheBatch().catch(() => undefined);
    }, CACHE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
    void this.pruneExpiredCacheBatch().catch(() => undefined);
  }

  async onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.store.closeSweepDirectory().catch(() => undefined);
  }

  async publicStatus() {
    const config = await this.settings.publicConfig();
    return {
      enabled: config.enabled && config.hasApiKey && Boolean(config.region && config.voiceId),
    };
  }

  async lookup(userId: string, rawText: string): Promise<CacheLookup> {
    const text = normalizeText(rawText);
    await this.pruneExpiredUserCache(userId);
    const config = await this.settings.publicConfig();
    if (!config.enabled || !config.hasApiKey || !config.region || !config.voiceId) {
      return { state: 'disabled' };
    }
    const cacheKey = this.cacheKey(userId, text, config);
    const cache = await this.prisma.ttsAudioCache.findUnique({ where: { cacheKey } });
    if (!cache) return { state: 'miss' };
    if (cache.userId !== userId) return { state: 'miss' };
    if (!(await this.store.exists(cache.objectName))) {
      await this.prisma.ttsAudioCache.deleteMany({ where: { id: cache.id, userId } });
      return { state: 'missing' };
    }
    await this.prisma.ttsAudioCache.updateMany({
      where: { id: cache.id, userId },
      data: { lastUsedAt: new Date() },
    });
    return { state: 'hit', audioId: cache.id, mimeType: cache.mimeType };
  }

  async readAudio(userId: string, audioId: string) {
    const cache = await this.prisma.ttsAudioCache.findFirst({ where: { id: audioId, userId } });
    if (!cache) throw new NotFoundException('语音缓存不存在或无权访问');
    const audio = await this.store.read(cache.objectName);
    if (
      !audio ||
      audio.byteLength !== cache.byteSize ||
      createHash('sha256').update(audio).digest('hex') !== cache.audioSha256
    ) {
      await this.prisma.ttsAudioCache.deleteMany({ where: { id: cache.id, userId } });
      await this.store.remove(cache.objectName).catch(() => undefined);
      throw new NotFoundException('语音缓存缺失或校验失败，请重新播放并确认后按需生成');
    }
    await this.prisma.ttsAudioCache.updateMany({
      where: { id: cache.id, userId },
      data: { lastUsedAt: new Date() },
    });
    return { audio, mimeType: cache.mimeType };
  }

  async generate(userId: string, rawText: string, consent: boolean) {
    if (!consent)
      throw new BadRequestException('生成语音前需要确认文本会发送给 MiniMax 且可能产生费用');
    const text = normalizeText(rawText);
    const provider = await this.settings.providerConfig();
    if (!provider.enabled) throw new ServiceUnavailableException('管理员尚未启用 MiniMax 语音合成');
    await this.pruneExpiredUserCache(userId);
    const cacheKey = this.cacheKey(userId, text, provider);
    const initial = await this.findReadyCache(cacheKey, userId);
    if (initial) return { audioId: initial.id, cache: 'reused' as const };

    const ownerToken = randomUUID().replace(/-/g, '');
    if (!(await this.tryAcquire(cacheKey, ownerToken))) {
      const ready = await this.waitForCacheOrClaim(userId, cacheKey, ownerToken);
      if (ready) return { audioId: ready.id, cache: 'reused' as const };
    }

    const claim = await this.prisma.ttsAudioGenerationClaim.findUnique({ where: { cacheKey } });
    if (claim?.ownerToken !== ownerToken) {
      const ready = await this.findReadyCache(cacheKey, userId);
      if (ready) return { audioId: ready.id, cache: 'reused' as const };
      throw new ServiceUnavailableException('相同文本的语音正在生成，请稍后重试');
    }

    const readyAfterClaim = await this.findReadyCache(cacheKey, userId);
    if (readyAfterClaim) {
      await this.releaseClaim(cacheKey, ownerToken);
      return { audioId: readyAfterClaim.id, cache: 'reused' as const };
    }

    let auditId: string;
    try {
      auditId = await this.startAudit(userId, provider.model, 'tts.synthesis');
    } catch (error) {
      await this.releaseClaim(cacheKey, ownerToken);
      throw error;
    }
    let usageReservation: DailyUsageReservation;
    try {
      usageReservation = await this.reserveDailyUsage(
        userId,
        text,
        provider.maxGenerationsPerUserPerDay,
      );
    } catch (error) {
      await this.releaseClaim(cacheKey, ownerToken);
      const safe = safeFailure(error);
      await this.finishAudit(auditId, 'FAILED', 0, safe.code).catch(() => undefined);
      throw error;
    }
    return this.synthesizeAndStore(
      userId,
      text,
      provider,
      cacheKey,
      ownerToken,
      'tts.synthesis',
      usageReservation,
      auditId,
    );
  }

  async testConnection(userId: string) {
    const provider = await this.settings.providerConfig();
    const auditId = await this.startAudit(userId, provider.model, 'tts.connection_test');
    try {
      await this.reserveDailyUsage(userId, TEST_SENTENCE, provider.maxGenerationsPerUserPerDay);
    } catch (error) {
      const safe = safeFailure(error);
      await this.finishAudit(auditId, 'FAILED', 0, safe.code).catch(() => undefined);
      throw error;
    }
    const startedAt = Date.now();
    try {
      const audio = await this.client.synthesize(TEST_SENTENCE, provider);
      await this.finishAudit(auditId, 'SUCCEEDED', Date.now() - startedAt);
      return audio;
    } catch (error) {
      const safe = safeFailure(error);
      await this.finishAudit(auditId, 'FAILED', Date.now() - startedAt, safe.code);
      this.recordFailure('tts.connection_test', '/api/v1/admin/tts-config/test', safe);
      throw new ServiceUnavailableException(safe.reason);
    }
  }

  private async synthesizeAndStore(
    userId: string,
    text: string,
    provider: Awaited<ReturnType<TtsConfigService['providerConfig']>>,
    cacheKey: string,
    ownerToken: string,
    purpose: string,
    usageReservation: DailyUsageReservation,
    auditId: string,
  ) {
    const startedAt = Date.now();
    let objectName: string | null = null;
    const evictedObjectNames: string[] = [];
    let providerRequestStarted = false;
    try {
      const leaseExpiresAt = await this.renewClaimBeforeProviderCall(cacheKey, ownerToken);
      if (!leaseExpiresAt) {
        throw new ServiceUnavailableException(
          '语音生成租约已失效，本次没有新增模型请求；请重新点击播放',
        );
      }
      const audio = await this.client.synthesize(text, provider, {
        leaseExpiresAt,
        safetyMarginMs: CLAIM_LEASE_SAFETY_MARGIN_MS,
        onDispatch: () => {
          providerRequestStarted = true;
        },
      });
      if (audio.byteLength <= 0 || audio.byteLength > MAX_AUDIO_BYTES) {
        throw new MiniMaxTtsError('TTS_AUDIO_SIZE', '生成的语音超出缓存大小限制。');
      }
      const configFingerprint = fingerprintSettings(provider);
      const rowId = randomUUID();
      const saved = await this.prisma.$transaction(async (tx) => {
        const currentClaim = await tx.ttsAudioGenerationClaim.findFirst({
          where: { cacheKey, ownerToken, leaseExpiresAt: { gt: new Date() } },
        });
        if (!currentClaim) return null;
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`lexloop-tts-cache:${userId}`}))`;
        let totalBytes =
          (
            await tx.ttsAudioCache.aggregate({
              where: { userId },
              _sum: { byteSize: true },
            })
          )._sum.byteSize ?? 0;
        while (totalBytes + audio.byteLength > MAX_CACHE_BYTES_PER_USER) {
          const oldestRows = await tx.ttsAudioCache.findMany({
            where: { userId },
            orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'asc' }],
            take: 100,
            select: { id: true, objectName: true, byteSize: true },
          });
          if (oldestRows.length === 0) {
            throw new ServiceUnavailableException('个人语音缓存暂时无法腾出空间，请稍后重试');
          }
          for (const oldRow of oldestRows) {
            const deleted = await tx.ttsAudioCache.deleteMany({
              where: { id: oldRow.id, userId },
            });
            if (deleted.count === 1) {
              totalBytes -= oldRow.byteSize;
              evictedObjectNames.push(oldRow.objectName);
            }
            if (totalBytes + audio.byteLength <= MAX_CACHE_BYTES_PER_USER) break;
          }
        }
        objectName = await this.store.write(audio);
        const row = await tx.ttsAudioCache.create({
          data: {
            id: rowId,
            userId,
            cacheKey,
            objectName: objectName!,
            configFingerprint,
            model: provider.model,
            voiceId: provider.voiceId,
            speed: provider.speed,
            volume: provider.volume,
            pitch: provider.pitch,
            format: 'mp3',
            mimeType: 'audio/mpeg',
            byteSize: audio.byteLength,
            audioSha256: createHash('sha256').update(audio).digest('hex'),
          },
        });
        const released = await tx.ttsAudioGenerationClaim.deleteMany({
          where: { cacheKey, ownerToken, leaseExpiresAt: { gt: new Date() } },
        });
        if (released.count !== 1) throw new Error('TTS generation lease was lost before commit');
        return row;
      });
      for (const oldObjectName of evictedObjectNames) {
        await this.store.remove(oldObjectName).catch(() => undefined);
      }
      if (!saved) {
        if (objectName) await this.store.remove(objectName);
        objectName = null;
        const current = await this.findReadyCache(cacheKey, userId);
        if (current) {
          await this.finishAudit(auditId, 'SUCCEEDED', Date.now() - startedAt).catch(
            () => undefined,
          );
          return { audioId: current.id, cache: 'reused' as const };
        }
        throw new ServiceUnavailableException('生成租约已失效，本次语音未保存；请重新点击播放');
      }
      await this.finishAudit(auditId, 'SUCCEEDED', Date.now() - startedAt).catch(() => undefined);
      return { audioId: saved.id, cache: 'generated' as const };
    } catch (error) {
      if (objectName) await this.store.remove(objectName).catch(() => undefined);
      if (!providerRequestStarted) {
        await this.releaseDailyUsage(usageReservation, auditId).catch(() => undefined);
      }
      const safe = safeFailure(error);
      await this.failClaim(cacheKey, ownerToken, safe.code);
      await this.finishAudit(auditId, 'FAILED', Date.now() - startedAt, safe.code);
      this.recordFailure(purpose, '/api/v1/tts/audio/generate', safe);
      throw error instanceof ServiceUnavailableException
        ? error
        : new ServiceUnavailableException(safe.reason);
    }
  }

  private async waitForCacheOrClaim(userId: string, cacheKey: string, ownerToken: string) {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    while (Date.now() < deadline) {
      const ready = await this.findReadyCache(cacheKey, userId);
      if (ready) return ready;
      const claim = await this.prisma.ttsAudioGenerationClaim.findUnique({ where: { cacheKey } });
      if (claim?.retryAfter && claim.retryAfter > new Date()) {
        throw new HttpException(
          '上一次语音生成刚失败，请稍后再手动重试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (!claim || !claim.leaseExpiresAt || claim.leaseExpiresAt <= new Date()) {
        if (await this.tryAcquire(cacheKey, ownerToken)) return null;
      }
      await delay(CLAIM_POLL_MS);
    }
    const ready = await this.findReadyCache(cacheKey, userId);
    if (ready) return ready;
    throw new ServiceUnavailableException('相同文本仍在生成，请稍后再试；本次没有新增模型请求');
  }

  private async findReadyCache(cacheKey: string, userId: string) {
    const row = await this.prisma.ttsAudioCache.findUnique({ where: { cacheKey } });
    if (!row || row.userId !== userId) return null;
    if (await this.store.exists(row.objectName)) {
      await this.prisma.ttsAudioCache.updateMany({
        where: { id: row.id, userId },
        data: { lastUsedAt: new Date() },
      });
      return row;
    }
    await this.prisma.ttsAudioCache.deleteMany({ where: { id: row.id, userId } });
    return null;
  }

  private async pruneExpiredUserCache(userId: string) {
    const cutoff = new Date(Date.now() - CACHE_RETENTION_MS);
    const expired = await this.prisma.ttsAudioCache.findMany({
      where: { userId, lastUsedAt: { lt: cutoff } },
      select: { id: true, objectName: true },
      take: 500,
      orderBy: { lastUsedAt: 'asc' },
    });
    for (const row of expired) {
      const deleted = await this.prisma.ttsAudioCache.deleteMany({
        where: { id: row.id, userId, lastUsedAt: { lt: cutoff } },
      });
      if (deleted.count === 1) await this.store.remove(row.objectName).catch(() => undefined);
    }
  }

  private async pruneExpiredCacheBatch() {
    const cutoff = new Date(Date.now() - CACHE_RETENTION_MS);
    const expired = await this.prisma.ttsAudioCache.findMany({
      where: { lastUsedAt: { lt: cutoff } },
      select: { id: true, userId: true, objectName: true },
      take: 500,
      orderBy: { lastUsedAt: 'asc' },
    });
    for (const row of expired) {
      const deleted = await this.prisma.ttsAudioCache.deleteMany({
        where: { id: row.id, userId: row.userId, lastUsedAt: { lt: cutoff } },
      });
      if (deleted.count === 1) await this.store.remove(row.objectName).catch(() => undefined);
    }
    const staleUsageBefore = new Date(Date.now() - CACHE_RETENTION_MS);
    await this.prisma.ttsDailyUsage.deleteMany({ where: { updatedAt: { lt: staleUsageBefore } } });
    await this.prisma.ttsAudioGenerationClaim.deleteMany({
      where: {
        ownerToken: null,
        retryAfter: { lt: staleUsageBefore },
      },
    });
    const staleObjectCandidates = await this.store.takeOldObjectCandidates(
      new Date(Date.now() - 24 * 60 * 60 * 1_000),
    );
    const staleAudioNames = staleObjectCandidates.filter((name) => name.endsWith('.mp3'));
    const referencedObjects = staleAudioNames.length
      ? await this.prisma.ttsAudioCache.findMany({
          where: { objectName: { in: staleAudioNames } },
          select: { objectName: true },
        })
      : [];
    const referencedNames = new Set(referencedObjects.map((row) => row.objectName));
    for (const objectName of staleObjectCandidates) {
      if (objectName.endsWith('.tmp') || !referencedNames.has(objectName)) {
        await this.store.removeOldCandidate(objectName).catch(() => undefined);
      }
    }
  }

  private async tryAcquire(cacheKey: string, ownerToken: string) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    try {
      await this.prisma.ttsAudioGenerationClaim.create({
        data: { cacheKey, ownerToken, leaseExpiresAt },
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const updated = await this.prisma.ttsAudioGenerationClaim.updateMany({
      where: {
        cacheKey,
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
          { OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
        ],
      },
      data: { ownerToken, leaseExpiresAt, retryAfter: null, lastFailureCode: null },
    });
    return updated.count === 1;
  }

  private async releaseClaim(cacheKey: string, ownerToken: string) {
    await this.prisma.ttsAudioGenerationClaim.deleteMany({ where: { cacheKey, ownerToken } });
  }

  private async renewClaimBeforeProviderCall(cacheKey: string, ownerToken: string) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const renewed = await this.prisma.ttsAudioGenerationClaim.updateMany({
      where: { cacheKey, ownerToken, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt },
    });
    return renewed.count === 1 ? leaseExpiresAt : null;
  }

  private async failClaim(cacheKey: string, ownerToken: string, code: string) {
    await this.prisma.ttsAudioGenerationClaim.updateMany({
      where: { cacheKey, ownerToken },
      data: {
        ownerToken: null,
        leaseExpiresAt: null,
        retryAfter: new Date(Date.now() + FAILURE_COOLDOWN_MS),
        lastFailureCode: code,
      },
    });
  }

  private async reserveDailyUsage(userId: string, text: string, limit: number) {
    const now = new Date();
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.get<string>('APP_TIMEZONE') ?? 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    await this.prisma.ttsDailyUsage.upsert({
      where: { userId_dateKey: { userId, dateKey } },
      create: { userId, dateKey, updatedAt: now },
      update: {},
    });
    const updated = await this.prisma.ttsDailyUsage.updateMany({
      where: {
        userId,
        dateKey,
        generationCount: { lt: limit },
        characterCount: { lte: MAX_DAILY_CHARACTERS - Array.from(text).length },
      },
      data: {
        generationCount: { increment: 1 },
        characterCount: { increment: Array.from(text).length },
        updatedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new HttpException(
        `今日语音生成已达到上限（${limit} 次或 ${MAX_DAILY_CHARACTERS} 个字符）；缓存播放不计入上限。`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { userId, dateKey, characterCount: Array.from(text).length };
  }

  private async releaseDailyUsage(reservation: DailyUsageReservation, auditId: string) {
    await this.prisma.$transaction(async (tx) => {
      const refundReceipt = await tx.aiCallAudit.updateMany({
        where: { id: auditId, status: 'PENDING' },
        data: {
          status: 'FAILED',
          errorCode: 'TTS_REQUEST_NOT_DISPATCHED',
          latencyMs: 0,
          completedAt: new Date(),
        },
      });
      if (refundReceipt.count !== 1) return;

      const released = await tx.ttsDailyUsage.updateMany({
        where: {
          userId: reservation.userId,
          dateKey: reservation.dateKey,
          generationCount: { gt: 0 },
          characterCount: { gte: reservation.characterCount },
        },
        data: {
          generationCount: { decrement: 1 },
          characterCount: { decrement: reservation.characterCount },
          updatedAt: new Date(),
        },
      });
      if (released.count !== 1) throw new Error('TTS daily usage reservation is missing');
      await tx.ttsDailyUsage.deleteMany({
        where: {
          userId: reservation.userId,
          dateKey: reservation.dateKey,
          generationCount: 0,
          characterCount: 0,
        },
      });
    });
  }

  private async startAudit(userId: string, model: string, purpose: string) {
    const row = await this.prisma.aiCallAudit.create({
      data: {
        userId,
        purpose,
        provider: 'MINIMAX',
        model,
        promptVersion: 'tts-v1',
        status: 'PENDING',
      },
    });
    return row.id;
  }

  private async finishAudit(
    id: string,
    status: 'SUCCEEDED' | 'FAILED',
    latencyMs: number,
    errorCode?: string,
  ) {
    await this.prisma.aiCallAudit.update({
      where: { id },
      data: {
        status,
        latencyMs: Math.max(0, Math.min(Math.round(latencyMs), 2_147_483_647)),
        ...(errorCode ? { errorCode } : {}),
        completedAt: new Date(),
      },
    });
  }

  private cacheKey(
    userId: string,
    text: string,
    settings: Pick<
      TtsProviderConfig,
      'region' | 'model' | 'voiceId' | 'speed' | 'volume' | 'pitch'
    >,
  ) {
    const secret = this.config.get<string>('AI_CONFIG_ENCRYPTION_KEY');
    if (!secret || secret.startsWith('change-this-')) {
      throw new ServiceUnavailableException('语音缓存指纹密钥未配置');
    }
    const configuration = fingerprintSettings(settings);
    const key = createHash('sha256').update(`lexloop-tts-cache-key\0${secret}`).digest();
    return createHmac('sha256', key)
      .update(JSON.stringify({ version: 1, userId, text, configuration }))
      .digest('hex');
  }

  private recordFailure(kind: string, route: string, failure: { code: string; reason: string }) {
    void this.logs
      .record({
        source: 'api',
        kind,
        code: failure.code,
        method: 'POST',
        route,
        reason: failure.reason,
      })
      .catch(() => undefined);
  }
}

function normalizeText(raw: string) {
  const text = raw.normalize('NFC');
  const length = Array.from(text).length;
  if (!text.trim() || length > MAX_TEXT_CODEPOINTS) {
    throw new BadRequestException(`朗读文本不能为空且不能超过 ${MAX_TEXT_CODEPOINTS} 个字符`);
  }
  return text;
}

function fingerprintSettings(
  settings: Pick<TtsProviderConfig, 'region' | 'model' | 'voiceId' | 'speed' | 'volume' | 'pitch'>,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        provider: 'MINIMAX',
        region: settings.region,
        model: settings.model,
        voiceId: settings.voiceId,
        speed: settings.speed,
        volume: settings.volume,
        pitch: settings.pitch,
        languageBoost: 'auto',
        sampleRate: 32_000,
        bitrate: 128_000,
        format: 'mp3',
        channel: 1,
      }),
    )
    .digest('hex');
}

function safeFailure(error: unknown) {
  if (error instanceof MiniMaxTtsError) {
    return { code: error.code.slice(0, 80), reason: error.publicReason };
  }
  if (error instanceof HttpException) {
    return { code: 'TTS_REQUEST_LIMIT', reason: error.message };
  }
  return { code: 'TTS_INTERNAL', reason: '语音生成暂时失败，请稍后手动重试。' };
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
