import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OutputService } from '../src/modules/practice/output.service';

describe.skipIf(!process.env.PRACTICE_TEST_DATABASE_URL)(
  'daily output model setup recovery in an isolated database',
  () => {
    it('keeps a missing-model attempt out of the queue and accepts the same request after setup', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.PRACTICE_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const createdWordIds: string[] = [];
      let bookId: string | undefined;
      let userId: string | undefined;
      const queue = { add: vi.fn().mockResolvedValue({ id: 'isolated-output-job' }) };
      const evidence = {} as never;
      const provider = {
        id: 'isolated-fixture-model',
        provider: 'OPENAI_COMPATIBLE',
        baseUrl: 'https://example.invalid',
        model: 'mock-only',
        apiKey: 'test-only',
      };

      try {
        const user = await prisma.user.create({
          data: {
            email: `practice-model-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: user.id,
            kind: 'PERSONAL',
            sourceKey: `practice-model-${fixtureId}`,
            title: 'Daily output model setup fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            userBooks: { create: { userId: user.id, isDefault: true } },
            bookWords: {
              create: ['journey', 'bright', 'steady'].map((text, position) => ({
                position,
                word: {
                  create: {
                    normalized: `practice-model-${fixtureId}-${text}`,
                    text,
                    meaning: `Fixture meaning for ${text}`,
                  },
                },
              })),
            },
          },
          select: { id: true, bookWords: { select: { id: true, wordId: true } } },
        });
        bookId = book.id;
        createdWordIds.push(...book.bookWords.map((item) => item.wordId));
        await prisma.userWordProgress.createMany({
          data: book.bookWords.map((item) => ({
            userId: user.id,
            bookWordId: item.id,
            state: 'LEARNING',
          })),
        });

        const selectedProvider = vi.fn(async () => null as typeof provider | null);
        const unavailableModelService = new OutputService(
          prisma as never,
          { get: () => 'Asia/Shanghai' } as never,
          { selectedProvider } as never,
          evidence,
          queue as never,
        );
        const daily = await unavailableModelService.daily(user.id);
        expect(daily?.targets.map((target) => target.word).sort()).toEqual([
          'bright',
          'journey',
          'steady',
        ]);

        const answer = 'Our journey stayed bright and steady after the rain.';
        const clientRequestId = randomUUID();
        await expect(
          unavailableModelService.submit(user.id, daily!.id, answer, clientRequestId, 2400),
        ).rejects.toThrow('请先在首页阅读材料模型设置中选择可用模型');
        expect(selectedProvider).toHaveBeenCalledTimes(1);
        expect(queue.add).not.toHaveBeenCalled();
        expect(await prisma.outputSubmission.count({ where: { challengeId: daily!.id } })).toBe(0);
        expect(
          await prisma.wordReviewAttempt.count({
            where: { userId: user.id, questionType: 'OUTPUT' },
          }),
        ).toBe(0);
        expect(
          await prisma.learningEvent.count({
            where: { userId: user.id, type: 'OUTPUT_COMPLETED' },
          }),
        ).toBe(0);

        selectedProvider.mockResolvedValue(provider);
        const configuredModelService = new OutputService(
          prisma as never,
          { get: () => 'Asia/Shanghai' } as never,
          { selectedProvider } as never,
          evidence,
          queue as never,
        );
        const queued = await configuredModelService.submit(
          user.id,
          daily!.id,
          answer,
          clientRequestId,
          2400,
        );
        expect(queued.status).toBe('QUEUED');
        expect(queue.add).toHaveBeenCalledTimes(1);
        const saved = await prisma.outputSubmission.findUniqueOrThrow({
          where: { id: queued.id },
          select: { answer: true, clientRequestId: true, status: true },
        });
        expect(saved).toEqual({ answer, clientRequestId, status: 'QUEUED' });
        expect(await prisma.outputSubmission.count({ where: { challengeId: daily!.id } })).toBe(1);
        expect(
          await prisma.wordReviewAttempt.count({
            where: { userId: user.id, questionType: 'OUTPUT' },
          }),
        ).toBe(0);
      } finally {
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        if (createdWordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: createdWordIds } } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
