import { PrismaClient, WeaknessStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'mistake detail history in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('pages large histories without mixing another user’s attempts or losing saved question snapshots', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const reader = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      clients.push(admin, reader);

      const fixtureId = randomUUID();
      const ownerAttemptCount = 5_000;
      const ownerAttemptIds = Array.from(
        { length: ownerAttemptCount },
        (_, index) => `mistake-${fixtureId}-owner-${String(index).padStart(5, '0')}`,
      );
      const otherAttemptIds = Array.from(
        { length: 3 },
        (_, index) => `mistake-${fixtureId}-other-${String(index).padStart(2, '0')}`,
      );
      const userIds: string[] = [];
      const attemptIds = [...ownerAttemptIds, ...otherAttemptIds];
      const insertedAfterFirstPageId = `mistake-${fixtureId}-owner-50000`;
      attemptIds.push(insertedAfterFirstPageId);
      try {
        const owner = await admin.user.create({
          data: {
            email: `mistake-detail-${fixtureId}-owner@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userIds.push(owner.id);
        const other = await admin.user.create({
          data: {
            email: `mistake-detail-${fixtureId}-other@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userIds.push(other.id);

        const book = await admin.vocabularyBook.create({
          data: {
            ownerId: owner.id,
            kind: 'PERSONAL',
            sourceKey: `mistake-detail-${fixtureId}`,
            title: 'Mistake detail fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: {
                position: 0,
                word: {
                  create: {
                    normalized: `mistake-detail-${fixtureId}`,
                    text: 'steady',
                    meaning: '稳定的',
                  },
                },
              },
            },
          },
          select: { bookWords: { select: { id: true } } },
        });
        const bookWordId = book.bookWords[0].id;
        const signal = await admin.weaknessSignal.create({
          data: {
            userId: owner.id,
            bookWordId,
            questionType: 'MEANING_RECOGNITION',
            status: WeaknessStatus.ACTIVE,
            wrongCount: ownerAttemptCount,
            lastWrongAt: new Date('2026-10-28T10:00:00.000Z'),
            lastAttemptAt: new Date('2026-10-28T10:00:00.000Z'),
          },
          select: { id: true },
        });
        const sameInstant = new Date('2026-10-28T10:00:00.000Z');
        await admin.wordReviewAttempt.createMany({
          data: [
            ...ownerAttemptIds.map((id, index) => ({
              id,
              userId: owner.id,
              bookWordId,
              questionType: 'MEANING_RECOGNITION',
              isCorrect: index % 2 === 0,
              createdAt: sameInstant,
              selectedAnswer:
                index === ownerAttemptCount - 1
                  ? { answer: 'an incorrect choice', question: null }
                  : {
                      answer: `answer-${index}`,
                      question: {
                        prompt: `Which meaning fits item ${index}?`,
                        correctAnswers: ['steady'],
                        explanation: 'Fixture snapshot',
                      },
                    },
            })),
            ...otherAttemptIds.map((id) => ({
              id,
              userId: other.id,
              bookWordId,
              questionType: 'MEANING_RECOGNITION',
              isCorrect: false,
              createdAt: sameInstant,
              selectedAnswer: { answer: 'other-user-only' },
            })),
          ],
        });

        const service = new MistakesService(reader as never);
        const startedAt = performance.now();
        const firstPage = await service.detail(owner.id, signal.id);
        const pageElapsedMs = performance.now() - startedAt;
        console.log(
          `mistake detail first page: ${ownerAttemptCount} attempts / ${firstPage.attempts.length} returned in ${pageElapsedMs.toFixed(1)} ms`,
        );
        await admin.wordReviewAttempt.create({
          data: {
            id: insertedAfterFirstPageId,
            userId: owner.id,
            bookWordId,
            questionType: 'MEANING_RECOGNITION',
            isCorrect: false,
            createdAt: sameInstant,
            selectedAnswer: { answer: 'arrived after page one' },
          },
        });
        const secondPage = await service.detail(
          owner.id,
          signal.id,
          firstPage.olderAttemptCursor!,
          'older',
        );
        const returnedPage = await service.detail(
          owner.id,
          signal.id,
          secondPage.newerAttemptCursor!,
          'newer',
        );
        const freshPage = await service.detail(owner.id, signal.id);

        expect(firstPage.attempts.map((attempt) => attempt.id)).toEqual(
          ownerAttemptIds.slice(ownerAttemptCount - 20).reverse(),
        );
        expect(firstPage.attemptHasOlder).toBe(true);
        expect(firstPage.attemptHasNewer).toBe(false);
        expect(firstPage.attempts[0]).toMatchObject({
          id: ownerAttemptIds[ownerAttemptCount - 1],
          selectedAnswer: 'an incorrect choice',
          question: null,
        });
        expect(secondPage.attempts.map((attempt) => attempt.id)).toEqual(
          ownerAttemptIds.slice(ownerAttemptCount - 40, ownerAttemptCount - 20).reverse(),
        );
        expect(secondPage.attemptHasOlder).toBe(true);
        expect(secondPage.attemptHasNewer).toBe(true);
        expect(secondPage.attempts.some((attempt) => attempt.id === insertedAfterFirstPageId)).toBe(
          false,
        );
        expect(secondPage.attempts[0]).toMatchObject({
          id: ownerAttemptIds[ownerAttemptCount - 21],
          selectedAnswer: `answer-${ownerAttemptCount - 21}`,
          question: {
            prompt: `Which meaning fits item ${ownerAttemptCount - 21}?`,
            correctAnswers: ['steady'],
          },
        });
        expect(firstPage.attempts.every((attempt) => !attempt.id.includes('-other-'))).toBe(true);
        expect(returnedPage.attempts.map((attempt) => attempt.id)).toEqual(
          firstPage.attempts.map((attempt) => attempt.id),
        );
        expect(returnedPage.attemptHasOlder).toBe(true);
        expect(returnedPage.attemptHasNewer).toBe(false);
        expect(freshPage.attempts[0].id).toBe(insertedAfterFirstPageId);
        expect(freshPage.attemptHasOlder).toBe(true);
        await expect(service.detail(other.id, signal.id)).rejects.toThrow('薄弱项不存在');
      } finally {
        await admin.wordReviewAttempt.deleteMany({ where: { id: { in: attemptIds } } });
        if (userIds.length) await admin.user.deleteMany({ where: { id: { in: userIds } } });
      }
    });
  },
);
