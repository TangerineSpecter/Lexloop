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
      const otherWordIds: string[] = [];
      let bookId: string | undefined;
      let userId: string | undefined;
      let otherBookId: string | undefined;
      let otherUserId: string | undefined;
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
        const otherUser = await prisma.user.create({
          data: {
            email: `practice-model-other-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        otherUserId = otherUser.id;
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
              create: [
                {
                  text: 'miss the bus',
                  meaning: '赶公交车',
                  contextMeaning: '因交通延误没赶上公交车',
                },
                { text: 'journey', meaning: '旅程' },
                { text: 'bright', meaning: '明亮的' },
                { text: 'I missed the bus yesterday', meaning: '昨天我错过了公交车' },
              ].map(({ text, meaning, contextMeaning }, position) => ({
                position,
                contextMeaning,
                word: {
                  create: {
                    normalized: `practice-model-${fixtureId}-${text}`,
                    text,
                    meaning,
                  },
                },
              })),
            },
          },
          select: { id: true, bookWords: { select: { id: true, wordId: true } } },
        });
        bookId = book.id;
        createdWordIds.push(...book.bookWords.map((item) => item.wordId));
        const otherBook = await prisma.vocabularyBook.create({
          data: {
            ownerId: otherUser.id,
            kind: 'PERSONAL',
            sourceKey: `practice-model-other-${fixtureId}`,
            title: 'Other account expression fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            userBooks: { create: { userId: otherUser.id, isDefault: true } },
            bookWords: {
              create: [
                {
                  position: 0,
                  contextMeaning: '为任务按时完成期限',
                  word: {
                    create: {
                      normalized: `practice-model-${fixtureId}-other-meet-a-deadline`,
                      text: 'meet a deadline',
                      meaning: '赶上截止日期',
                    },
                  },
                },
              ],
            },
          },
          select: { id: true, bookWords: { select: { wordId: true } } },
        });
        otherBookId = otherBook.id;
        otherWordIds.push(...otherBook.bookWords.map((item) => item.wordId));
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
          'miss the bus',
        ]);
        expect(daily?.targets.find((target) => target.word === 'miss the bus')).toMatchObject({
          word: 'miss the bus',
          meaning: '因交通延误没赶上公交车',
        });
        const otherDaily = await unavailableModelService.daily(otherUser.id);
        expect(otherDaily?.targets.map((target) => target.word)).toEqual(['meet a deadline']);

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
        if (otherUserId) await prisma.user.deleteMany({ where: { id: otherUserId } });
        if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        if (otherBookId) await prisma.vocabularyBook.deleteMany({ where: { id: otherBookId } });
        if (createdWordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: createdWordIds } } });
        if (otherWordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: otherWordIds } } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
