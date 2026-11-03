import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import { TtsQuotaLedger } from '../src/modules/tts/tts-quota-ledger';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'durable TTS local quota on isolated PostgreSQL',
  () => {
    it.each([false, true])(
      'recovers only proven pre-dispatch quota after SIGKILL (barrier=%s)',
      async (barrier) => {
        const f = await fixture();
        const source = transpileModule(
          readFileSync('src/modules/tts/tts-quota-ledger.ts', 'utf8'),
          { compilerOptions: { module: ModuleKind.CommonJS } },
        ).outputText;
        const child = spawn(
          process.execPath,
          [
            '-e',
            source +
              `
        const {PrismaClient} = require('@prisma/client');
        const db = new PrismaClient({datasources: {db: {url: process.env.LAB_TEST_DATABASE_URL}}});
        const ledger = new exports.TtsQuotaLedger(db);
        (async () => {
          const result = await ledger.reserve(process.env.FIXTURE_USER, 'crash', 10, 'fixture', 'UTC');
          if (process.env.FIXTURE_BARRIER === 'true') await ledger.beforeDispatch(result.auditId);
          process.send(result.auditId);
          setInterval(() => {}, 1000);
        })().catch(() => process.exit(1));
      `,
          ],
          {
            env: {
              PATH: process.env.PATH,
              LAB_TEST_DATABASE_URL: process.env.LAB_TEST_DATABASE_URL,
              FIXTURE_USER: f.userId,
              FIXTURE_BARRIER: String(barrier),
            },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        try {
          const auditId = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture child did not commit')), 8000);
            child.once('message', (id) => {
              clearTimeout(timer);
              resolve(String(id));
            });
            child.once('error', (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once('exit', () => {
              clearTimeout(timer);
              reject(new Error('fixture child exited before receipt'));
            });
          });
          child.kill('SIGKILL');
          await exited;
          await f.db.ttsQuotaReservation.update({
            where: { auditId },
            data: { expiresAt: new Date(0) },
          });
          await new TtsQuotaLedger(f.second as never).recover();
          expect(await f.db.ttsQuotaReservation.findUnique({ where: { auditId } })).toMatchObject({
            state: barrier ? 'DISPATCHING' : 'REFUNDED',
          });
          expect(await f.db.ttsDailyUsage.findFirst({ where: { userId: f.userId } })).toMatchObject(
            { generationCount: barrier ? 1 : 0 },
          );
        } finally {
          child.kill('SIGKILL');
          await exited;
          await f.cleanup();
        }
      },
      15_000,
    );

    it('recovers committed reservations after restart, preserves original day and excludes legacy or dispatched attempts', async () => {
      const f = await fixture();
      try {
        const first = await f.ledger.reserve(f.userId, 'hello', 10, 'fixture', 'Asia/Shanghai');
        const other = await f.ledger.reserve(f.userId, 'world!', 10, 'fixture', 'Asia/Shanghai');
        await f.ledger.beforeDispatch(other.auditId);
        // Simulate a previous day and no application receipt surviving a restart.
        const oldDay = '2020-01-01';
        await f.db.ttsDailyUsage.update({
          where: { userId_dateKey: { userId: f.userId, dateKey: first.reservation.dateKey } },
          data: { dateKey: oldDay },
        });
        await f.db.ttsQuotaReservation.updateMany({
          where: { userId: f.userId },
          data: { dateKey: oldDay, expiresAt: new Date(0) },
        });
        const legacy = await f.db.aiCallAudit.create({
          data: { userId: f.userId, purpose: 'tts.synthesis' },
        });
        await f.db.$disconnect();
        const restarted = new TtsQuotaLedger(f.second as never);
        const recovered = await restarted.recover();
        expect(recovered.recovered).toBe(1);
        expect(recovered.uncertain).toBe(1);
        await restarted.recover();
        expect(
          await f.second.ttsDailyUsage.findFirst({ where: { userId: f.userId } }),
        ).toMatchObject({ dateKey: oldDay, generationCount: 1, characterCount: 6 });
        expect(await f.second.aiCallAudit.findUnique({ where: { id: legacy.id } })).toMatchObject({
          status: 'PENDING',
        });
        expect(await restarted.refund(other.auditId)).toBe(false);
        await expect(restarted.beforeDispatch(first.auditId)).rejects.toThrow();
      } finally {
        await f.cleanup();
      }
    });

    it('serializes a recovery winner against a paused sender and never refunds a dispatch winner', async () => {
      const f = await fixture();
      try {
        const reservation = await f.ledger.reserve(f.userId, 'abc', 10, 'fixture', 'UTC');
        await f.db.ttsQuotaReservation.update({
          where: { auditId: reservation.auditId },
          data: { expiresAt: new Date(0) },
        });
        const locked = deferred(),
          release = deferred();
        const blocker = f.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "TtsQuotaReservation" WHERE "auditId" = ${reservation.auditId} FOR UPDATE`;
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const recovery = new TtsQuotaLedger(f.second as never).recover();
        const sender = f.ledger.beforeDispatch(reservation.auditId).then(
          () => true,
          () => false,
        );
        release.resolve();
        await blocker;
        expect((await recovery).recovered).toBe(1);
        expect(await sender).toBe(false);
        const next = await f.ledger.reserve(f.userId, 'abcdef', 10, 'fixture', 'UTC');
        await f.ledger.beforeDispatch(next.auditId);
        await f.db.ttsQuotaReservation.update({
          where: { auditId: next.auditId },
          data: { expiresAt: new Date(0) },
        });
        expect(
          await Promise.all([
            f.ledger.refund(next.auditId),
            new TtsQuotaLedger(f.second as never).refund(next.auditId),
          ]),
        ).toEqual([false, false]);
        expect(await f.db.ttsDailyUsage.findFirst({ where: { userId: f.userId } })).toMatchObject({
          generationCount: 1,
          characterCount: 6,
        });
      } finally {
        await f.cleanup();
      }
    });

    it('rolls back failed recovery and retries once across workers without touching another reservation', async () => {
      const f = await fixture();
      const name = `quota_fault_${randomUUID().replaceAll('-', '')}`;
      try {
        const first = await f.ledger.reserve(f.userId, 'abc', 10, 'fixture', 'UTC');
        await f.ledger.reserve(f.userId, 'abcdef', 10, 'fixture', 'UTC');
        await f.db.ttsQuotaReservation.update({
          where: { auditId: first.auditId },
          data: { expiresAt: new Date(0) },
        });
        await f.db.$executeRawUnsafe(
          `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."userId" = '${f.userId}' AND NEW."generationCount" < OLD."generationCount" THEN RAISE EXCEPTION 'fixture refund failure'; END IF; RETURN NEW; END $$`,
        );
        await f.db.$executeRawUnsafe(
          `CREATE TRIGGER "${name}" BEFORE UPDATE ON "TtsDailyUsage" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
        );
        expect((await f.ledger.recover()).failed).toBe(1);
        expect(
          await f.db.ttsQuotaReservation.findUnique({ where: { auditId: first.auditId } }),
        ).toMatchObject({ state: 'RESERVED' });
        expect(await f.db.aiCallAudit.findUnique({ where: { id: first.auditId } })).toMatchObject({
          status: 'PENDING',
        });
        await f.db.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "TtsDailyUsage"`);
        await Promise.all([f.ledger.recover(), new TtsQuotaLedger(f.second as never).recover()]);
        expect(await f.db.ttsDailyUsage.findFirst({ where: { userId: f.userId } })).toMatchObject({
          generationCount: 1,
          characterCount: 6,
        });
        expect(await f.ledger.refund(first.auditId)).toBe(true);
      } finally {
        await f.second.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "TtsDailyUsage"`);
        await f.second.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
        await f.cleanup();
      }
    });

    it('protects old aggregates from cleanup and user deletion still cascades safely', async () => {
      const f = await fixture();
      try {
        const reserved = await f.ledger.reserve(f.userId, 'abc', 10, 'fixture', 'UTC');
        await f.db.ttsDailyUsage.updateMany({
          where: { userId: f.userId },
          data: { updatedAt: new Date(0) },
        });
        await f.db.ttsQuotaReservation.update({
          where: { auditId: reserved.auditId },
          data: { expiresAt: new Date(0) },
        });
        // Old cleanup SQL cannot silently remove the recorded aggregate.
        await expect(
          f.db.ttsDailyUsage.deleteMany({ where: { userId: f.userId } }),
        ).rejects.toThrow();
        await Promise.all([
          f.ledger.recover(),
          f.second.ttsDailyUsage.deleteMany({
            where: { userId: f.userId, updatedAt: { lt: new Date(1) }, reservations: { none: {} } },
          }),
        ]);
        expect(await f.db.ttsDailyUsage.findFirst({ where: { userId: f.userId } })).toMatchObject({
          generationCount: 0,
        });
        await f.db.user.delete({ where: { id: f.userId } });
        expect(await f.db.ttsQuotaReservation.count({ where: { userId: f.userId } })).toBe(0);
      } finally {
        await f.cleanup();
      }
    });

    it('rotates a full failed batch so later safe reservations can recover', async () => {
      const f = await fixture();
      try {
        for (let index = 0; index < 100; index++)
          await f.ledger.reserve(f.userId, 'a', 200, 'fixture', 'UTC');
        await f.db.ttsQuotaReservation.updateMany({
          where: { userId: f.userId },
          data: { characterCount: 1000, expiresAt: new Date(0), updatedAt: new Date(0) },
        });
        const safe = await f.ledger.reserve(f.userId, 'b', 200, 'fixture', 'UTC');
        await f.db.ttsQuotaReservation.update({
          where: { auditId: safe.auditId },
          data: { expiresAt: new Date(0) },
        });
        expect((await f.ledger.recover()).failed).toBe(100);
        expect((await f.ledger.recover()).recovered).toBe(1);
        expect(
          await f.db.ttsQuotaReservation.findUnique({ where: { auditId: safe.auditId } }),
        ).toMatchObject({ state: 'REFUNDED' });
        expect(
          await f.db.ttsQuotaReservation.count({
            where: {
              userId: f.userId,
              state: 'RESERVED',
              lastRecoveryError: 'TTS_QUOTA_RECOVERY_FAILED',
            },
          }),
        ).toBe(100);
      } finally {
        await f.cleanup();
      }
    }, 20_000);

    it('does not leave an audit or reservation when the aggregate reservation is refused', async () => {
      const f = await fixture();
      try {
        await expect(f.ledger.reserve(f.userId, 'abc', 0, 'fixture', 'UTC')).rejects.toMatchObject({
          status: 429,
        });
        expect(await f.db.ttsDailyUsage.count({ where: { userId: f.userId } })).toBe(0);
        expect(await f.db.aiCallAudit.count({ where: { userId: f.userId } })).toBe(0);
        expect(await f.db.ttsQuotaReservation.count({ where: { userId: f.userId } })).toBe(0);
      } finally {
        await f.cleanup();
      }
    });
  },
);

async function fixture() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } } });
  const second = new PrismaClient({
    datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
  });
  const user = await db.user.create({
    data: { email: `quota-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
  });
  return {
    db,
    second,
    userId: user.id,
    ledger: new TtsQuotaLedger(db as never),
    cleanup: async () => {
      await second.ttsQuotaReservation.deleteMany({ where: { userId: user.id } });
      await second.user.deleteMany({ where: { id: user.id } });
      await Promise.all([db.$disconnect(), second.$disconnect()]);
    },
  };
}
