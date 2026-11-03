import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type TtsReservation = {
  userId: string;
  dateKey: string;
  characterCount: number;
  ledger?: true;
};
const MAX_CHARACTERS = 20_000;
const RESERVATION_MS = 120_000;

/** RESERVED proves no dispatch barrier was crossed; DISPATCHING proves only possibility. */
export class TtsQuotaLedger {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(userId: string, text: string, limit: number, model: string, timeZone: string) {
    const now = new Date();
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const characterCount = Array.from(text).length;
    return this.prisma.$transaction(async (tx) => {
      await tx.ttsDailyUsage.upsert({
        where: { userId_dateKey: { userId, dateKey } },
        create: { userId, dateKey },
        update: {},
      });
      const increment = await tx.ttsDailyUsage.updateMany({
        where: {
          userId,
          dateKey,
          generationCount: { lt: limit },
          characterCount: { lte: MAX_CHARACTERS - characterCount },
        },
        data: { generationCount: { increment: 1 }, characterCount: { increment: characterCount } },
      });
      if (increment.count !== 1)
        throw new HttpException(
          '今日语音生成已达到本地额度上限；缓存播放不计入上限。',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const audit = await tx.aiCallAudit.create({
        data: {
          userId,
          purpose: 'tts.synthesis',
          provider: 'MINIMAX',
          model,
          promptVersion: 'tts-ledger-v1',
          status: 'PENDING',
        },
      });
      await tx.ttsQuotaReservation.create({
        data: {
          auditId: audit.id,
          userId,
          dateKey,
          characterCount,
          expiresAt: new Date(now.getTime() + RESERVATION_MS),
        },
      });
      return {
        auditId: audit.id,
        reservation: { userId, dateKey, characterCount, ledger: true as const },
      };
    });
  }

  async beforeDispatch(auditId: string) {
    const changed = await this.prisma.ttsQuotaReservation.updateMany({
      where: { auditId, state: 'RESERVED', expiresAt: { gt: new Date() } },
      data: { state: 'DISPATCHING' },
    });
    if (changed.count !== 1)
      throw new ServiceUnavailableException('本地语音预留已过期或已恢复，本次没有发送请求。');
  }

  async refund(auditId: string, expiredOnly = false) {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.ttsQuotaReservation.updateMany({
        where: {
          auditId,
          state: 'RESERVED',
          ...(expiredOnly ? { expiresAt: { lte: new Date() } } : {}),
        },
        data: { state: 'REFUNDED', lastRecoveryError: null },
      });
      const row = await tx.ttsQuotaReservation.findUnique({ where: { auditId } });
      if (changed.count !== 1) return row?.state === 'REFUNDED';
      if (!row) throw new Error('Missing TTS reservation');
      const released = await tx.ttsDailyUsage.updateMany({
        where: {
          userId: row.userId,
          dateKey: row.dateKey,
          generationCount: { gt: 0 },
          characterCount: { gte: row.characterCount },
        },
        data: {
          generationCount: { decrement: 1 },
          characterCount: { decrement: row.characterCount },
        },
      });
      if (released.count !== 1) throw new Error('TTS ledger aggregate mismatch');
      await tx.aiCallAudit.update({
        where: { id: auditId },
        data: {
          status: 'FAILED',
          errorCode: 'TTS_REQUEST_NOT_DISPATCHED',
          completedAt: new Date(),
          latencyMs: 0,
        },
      });
      // Keep a zero aggregate row: concurrent reservations can safely increment it.
      return true;
    });
  }

  async recover() {
    const rows = await this.prisma.ttsQuotaReservation.findMany({
      where: { state: 'RESERVED', expiresAt: { lte: new Date() } },
      orderBy: [{ updatedAt: 'asc' }, { auditId: 'asc' }],
      take: 100,
      select: { auditId: true },
    });
    let recovered = 0,
      failed = 0;
    for (const row of rows) {
      try {
        if (await this.refund(row.auditId, true)) recovered++;
      } catch {
        failed++;
        // Persist a safe diagnostic and rotate a poison record behind untouched
        // candidates. Never release uncertain quota just to advance the queue.
        await this.prisma.ttsQuotaReservation
          .updateMany({
            where: { auditId: row.auditId, state: 'RESERVED' },
            data: { lastRecoveryError: 'TTS_QUOTA_RECOVERY_FAILED', updatedAt: new Date() },
          })
          .catch(() => undefined);
      }
    }
    const uncertain = await this.prisma.ttsQuotaReservation.count({
      where: {
        state: 'DISPATCHING',
        expiresAt: { lte: new Date() },
        audit: { status: { not: 'SUCCEEDED' } },
      },
    });
    return { recovered, failed, uncertain };
  }
}
