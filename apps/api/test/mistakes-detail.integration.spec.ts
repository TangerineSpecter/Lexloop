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
      const otherTypeAttemptId = `mistake-${fixtureId}-owner-other-type`;
      const userIds: string[] = [];
      const attemptIds = [...ownerAttemptIds, ...otherAttemptIds, otherTypeAttemptId];
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
            wrongCount: ownerAttemptCount / 2,
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
            {
              id: otherTypeAttemptId,
              userId: owner.id,
              bookWordId,
              questionType: 'WORD_MATCHING',
              isCorrect: false,
              createdAt: new Date(sameInstant.getTime() + 1),
              selectedAnswer: { answer: 'other-question-type-only' },
            },
          ],
        });

        const service = new MistakesService(reader as never);
        const list = await service.list(owner.id, { status: 'active' });
        expect(list.items[0].weaknesses[0].wrongCount).toBe(ownerAttemptCount / 2);
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
        expect(firstPage.attempts.filter((attempt) => !attempt.isCorrect)).toHaveLength(10);
        expect(firstPage.attempts.filter((attempt) => attempt.isCorrect)).toHaveLength(10);
        expect(firstPage.attempts.map((attempt) => attempt.id)).not.toContain(otherTypeAttemptId);
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

    it('keeps cumulative wrong counts, sorted signals and saved attempts distinct when a word disappears', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const reader = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      clients.push(admin, reader);

      const fixtureId = randomUUID();
      let userId: string | null = null;
      const attemptIds = [
        `mistake-summary-${fixtureId}-wrong-1`,
        `mistake-summary-${fixtureId}-wrong-2`,
        `mistake-summary-${fixtureId}-wrong-3`,
        `mistake-summary-${fixtureId}-correct-with-snapshot`,
        `mistake-summary-${fixtureId}-correct-without-snapshot`,
        `mistake-summary-${fixtureId}-other-type`,
      ];
      try {
        const user = await admin.user.create({
          data: {
            email: `mistake-summary-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const book = await admin.vocabularyBook.create({
          data: {
            ownerId: user.id,
            kind: 'PERSONAL',
            sourceKey: `mistake-summary-${fixtureId}`,
            title: 'Mistake summary fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: ['streak-first', 'error-count-second'].map((text, position) => ({
                position,
                word: {
                  create: {
                    normalized: `mistake-summary-${fixtureId}-${text}`,
                    text,
                    meaning: '隔离测试释义',
                  },
                },
              })),
            },
          },
          select: { bookWords: { select: { id: true, word: { select: { text: true } } } } },
        });
        const firstWord = book.bookWords.find((item) => item.word.text === 'streak-first')!;
        const secondWord = book.bookWords.find((item) => item.word.text === 'error-count-second')!;
        const older = new Date('2026-10-28T09:00:00.000Z');
        const newer = new Date('2026-10-29T09:00:00.000Z');
        const firstSignal = await admin.weaknessSignal.create({
          data: {
            userId: user.id,
            bookWordId: firstWord.id,
            questionType: 'MEANING_RECOGNITION',
            status: WeaknessStatus.ACTIVE,
            wrongCount: 3,
            consecutiveCorrect: 0,
            lastWrongAt: older,
            lastAttemptAt: newer,
          },
          select: { id: true },
        });
        await admin.weaknessSignal.create({
          data: {
            userId: user.id,
            bookWordId: firstWord.id,
            questionType: 'WORD_MATCHING',
            status: WeaknessStatus.ACTIVE,
            wrongCount: 1,
            consecutiveCorrect: 0,
            lastWrongAt: older,
            lastAttemptAt: older,
          },
        });
        await admin.weaknessSignal.create({
          data: {
            userId: user.id,
            bookWordId: secondWord.id,
            questionType: 'MEANING_RECOGNITION',
            status: WeaknessStatus.ACTIVE,
            wrongCount: 4,
            consecutiveCorrect: 1,
            lastWrongAt: newer,
            lastAttemptAt: newer,
          },
        });
        await admin.wordReviewAttempt.createMany({
          data: [
            ...attemptIds.slice(0, 3).map((id, index) => ({
              id,
              userId: user.id,
              bookWordId: firstWord.id,
              questionType: 'MEANING_RECOGNITION',
              isCorrect: false,
              createdAt: new Date(older.getTime() + index),
              selectedAnswer:
                index === 1
                  ? { answer: 'incorrect answer with missing snapshot' }
                  : {
                      answer: `wrong-${index + 1}`,
                      question: { prompt: 'Saved original prompt', correctAnswers: ['steady'] },
                    },
            })),
            {
              id: attemptIds[3],
              userId: user.id,
              bookWordId: firstWord.id,
              questionType: 'MEANING_RECOGNITION',
              isCorrect: true,
              createdAt: newer,
              selectedAnswer: {
                answer: 'steady',
                question: { prompt: 'Saved original prompt', correctAnswers: ['steady'] },
              },
            },
            {
              id: attemptIds[4],
              userId: user.id,
              bookWordId: firstWord.id,
              questionType: 'MEANING_RECOGNITION',
              isCorrect: true,
              createdAt: new Date(newer.getTime() - 1),
              selectedAnswer: { answer: 'legacy correct answer without a snapshot' },
            },
            {
              id: attemptIds[5],
              userId: user.id,
              bookWordId: firstWord.id,
              questionType: 'WORD_MATCHING',
              isCorrect: false,
              createdAt: newer,
              selectedAnswer: { answer: 'unrelated type' },
            },
          ],
        });

        const service = new MistakesService(reader as never);
        const list = await service.list(user.id, { status: 'active', pageSize: 20 });
        expect(list.items.map((item) => item.word)).toEqual(['streak-first', 'error-count-second']);
        expect(list.items[0].weaknesses.map((item) => item.wrongCount)).toEqual([3, 1]);
        // The list order follows the documented low-streak-first priority,
        // even though the retained legacy severity value uses a different formula.
        expect(list.items[0].severity).toBeLessThan(list.items[1].severity);

        const detail = await service.detail(user.id, firstSignal.id);
        expect(detail.questionType).toBe('MEANING_RECOGNITION');
        expect(detail.wrongCount).toBe(3);
        expect(detail.attempts).toHaveLength(5);
        expect(detail.attempts.filter((attempt) => !attempt.isCorrect)).toHaveLength(3);
        expect(detail.attempts.filter((attempt) => attempt.isCorrect)).toHaveLength(2);
        expect(detail.attempts.map((attempt) => attempt.id)).not.toContain(attemptIds[5]);
        expect(detail.attempts.find((attempt) => attempt.id === attemptIds[1])).toMatchObject({
          isCorrect: false,
          question: null,
          selectedAnswer: 'incorrect answer with missing snapshot',
        });
        expect(detail.attempts.find((attempt) => attempt.id === attemptIds[4])).toMatchObject({
          isCorrect: true,
          question: null,
          selectedAnswer: 'legacy correct answer without a snapshot',
        });
        expect(detail.attempts.find((attempt) => attempt.id === attemptIds[4])).toMatchObject({
          isCorrect: true,
          question: null,
          selectedAnswer: 'legacy correct answer without a snapshot',
        });

        await admin.vocabularyBookWord.delete({ where: { id: firstWord.id } });
        await expect(service.detail(user.id, firstSignal.id)).rejects.toThrow('薄弱项不存在');
        await expect(service.createPracticePlan(user.id, [firstWord.id])).rejects.toThrow(
          '所选单词不再是待巩固状态',
        );
        expect(
          await admin.studyPlan.count({ where: { userId: user.id, purpose: 'WEAKNESS' } }),
        ).toBe(0);
      } finally {
        await admin.wordReviewAttempt.deleteMany({ where: { id: { in: attemptIds } } });
        if (userId) await admin.user.deleteMany({ where: { id: userId } });
      }
    });
  },
);
