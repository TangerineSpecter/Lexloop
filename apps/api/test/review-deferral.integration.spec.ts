import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { VocabularyController } from '../src/modules/vocabulary/vocabulary.controller';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'review deferral retry safety on PostgreSQL',
  () => {
    it('counts a repeated or concurrent defer only once and preserves a newer review schedule', async () => {
      const db = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await db.user.create({
        data: { email: `defer-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
      });
      const word = await db.vocabularyWord.create({
        data: { normalized: `defer-${randomUUID()}`, text: 'help', meaning: 'v. 帮助' },
      });
      const book = await db.vocabularyBook.create({
        data: {
          ownerId: user.id,
          kind: 'PERSONAL',
          sourceKey: randomUUID(),
          sourcePath: 'fixture',
          title: 'Deferral fixture',
          category: 'GENERAL',
        },
      });
      const bw = await db.vocabularyBookWord.create({
        data: { bookId: book.id, wordId: word.id, position: 0 },
      });
      const service = new VocabularyService(db as never);
      try {
        const original = await db.userWordProgress.create({
          data: {
            userId: user.id,
            bookWordId: bw.id,
            state: 'REVIEWING',
            nextReviewAt: new Date(Date.now() - 60_000),
            totalAttempts: 3,
            reviewCount: 3,
          },
        });
        await Promise.all([
          service.deferReview(user.id, bw.id),
          service.deferReview(user.id, bw.id),
        ]);
        const deferred = await db.userWordProgress.findUniqueOrThrow({
          where: { id: original.id },
        });
        console.log('deferral repeated-request evidence', {
          postponedCount: deferred.postponedCount,
        });
        expect(deferred.postponedCount).toBe(1);
        await service.deferReview(user.id, bw.id);
        expect(await db.userWordProgress.findUniqueOrThrow({ where: { id: original.id } })).toEqual(
          deferred,
        );
        const later = new Date(Date.now() + 7 * 86400_000);
        await db.userWordProgress.update({
          where: { id: original.id },
          data: { nextReviewAt: later, postponedCount: 0 },
        });
        await service.deferReview(user.id, bw.id);
        expect(await db.userWordProgress.findUnique({ where: { id: original.id } })).toMatchObject({
          nextReviewAt: later,
          postponedCount: 0,
          totalAttempts: 3,
          reviewCount: 3,
        });
        // Hold an actual progress update open, then prove defer is blocked on it.
        // This models the row-write boundary, not a complete answer submission.
        let announceWriter!: (pid: number) => void;
        let releaseWriter!: () => void;
        const writerReady = new Promise<number>((resolve) => {
          announceWriter = resolve;
        });
        const writerRelease = new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        const writer = db.$transaction(
          async (tx) => {
            const [connection] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            await tx.userWordProgress.update({
              where: { id: original.id },
              data: { nextReviewAt: new Date(later.getTime() + 86400_000), reviewCount: 4 },
            });
            announceWriter(connection.pid);
            await writerRelease;
          },
          { timeout: 10000 },
        );
        const writerPid = await writerReady;
        const waitingDeferral = service.deferReview(user.id, bw.id, later.toISOString());
        try {
          let blocked = false;
          const deadline = Date.now() + 2000;
          while (!blocked && Date.now() < deadline) {
            const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
              SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                WHERE ${writerPid} = ANY(pg_blocking_pids(pid))) AS blocked`;
            blocked = rows[0].blocked;
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
        } finally {
          releaseWriter();
          await writer;
        }
        expect(await waitingDeferral).toMatchObject({
          deferred: false,
          reason: 'SCHEDULE_CHANGED',
        });
        expect(await db.userWordProgress.findUnique({ where: { id: original.id } })).toMatchObject({
          nextReviewAt: new Date(later.getTime() + 86400_000),
          reviewCount: 4,
          postponedCount: 0,
        });
        const staleDue = original.nextReviewAt!.toISOString();
        const changedDue = new Date(Date.now() - 30_000);
        await db.userWordProgress.update({
          where: { id: original.id },
          data: { nextReviewAt: changedDue },
        });
        const current = await db.userWordProgress.findUniqueOrThrow({ where: { id: original.id } });
        expect(await service.deferReview(user.id, bw.id, staleDue)).toMatchObject({
          deferred: false,
          reason: 'SCHEDULE_CHANGED',
        });
        expect(await db.userWordProgress.findUnique({ where: { id: original.id } })).toEqual(
          current,
        );
        await db.userMasteredWord.create({ data: { userId: user.id, wordId: word.id } });
        expect(await service.deferReview(user.id, bw.id, changedDue.toISOString())).toMatchObject({
          deferred: false,
          reason: 'STATE_CHANGED',
        });
        expect(await db.userWordProgress.findUnique({ where: { id: original.id } })).toEqual(
          current,
        );
        await db.userMasteredWord.deleteMany({ where: { userId: user.id } });
        const secret = 'isolated-deferral-jwt-only';
        const module = await Test.createTestingModule({
          imports: [JwtModule.register({})],
          controllers: [VocabularyController],
          providers: [
            { provide: VocabularyService, useValue: service },
            JwtAuthGuard,
            { provide: ConfigService, useValue: { getOrThrow: () => secret } },
          ],
        }).compile();
        const app = module.createNestApplication(new FastifyAdapter());
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.init();
        const http = app.getHttpAdapter().getInstance();
        await http.ready();
        try {
          const jwt = new JwtService({ secret });
          const headers = { authorization: `Bearer ${await jwt.signAsync({ sub: user.id })}` };
          const url = `/vocabulary/words/${bw.id}/defer-review`;
          expect((await http.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
          expect(
            (
              await http.inject({
                method: 'POST',
                url,
                headers: { authorization: `Bearer ${await jwt.signAsync({ sub: 'other-user' })}` },
                payload: {},
              })
            ).statusCode,
          ).toBe(404);
          expect(
            (
              await http.inject({
                method: 'POST',
                url,
                headers,
                payload: { expectedNextReviewAt: 'invalid-date' },
              })
            ).statusCode,
          ).toBe(400);
          const response = await http.inject({
            method: 'POST',
            url,
            headers,
            payload: { expectedNextReviewAt: changedDue.toISOString() },
          });
          expect(response.statusCode).toBe(201);
          expect(response.json().deferred).toBe(true);
          const afterHttp = await db.userWordProgress.findUniqueOrThrow({
            where: { id: original.id },
          });
          const retry = await http.inject({
            method: 'POST',
            url,
            headers,
            payload: { expectedNextReviewAt: changedDue.toISOString() },
          });
          expect(retry.json().deferred).toBe(false);
          expect(await db.userWordProgress.findUnique({ where: { id: original.id } })).toEqual(
            afterHttp,
          );
          expect(await db.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);
        } finally {
          await app.close();
        }
      } finally {
        await db.user.delete({ where: { id: user.id } });
        await db.vocabularyWord.delete({ where: { id: word.id } });
        await db.$disconnect();
      }
    });
  },
);
