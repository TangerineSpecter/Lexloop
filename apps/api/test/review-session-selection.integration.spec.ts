import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'bounded review selection in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('keeps unselected due words unchanged, limits plans to 40, and scopes selection to the learner', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      clients.push(prisma);
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const bookWordIds: string[] = [];
      const wordIds: string[] = [];
      const dueAt = new Map<string, Date>();

      try {
        const users = await Promise.all(
          ['owner', 'other'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `review-selection-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
                defaultNewWordCount: 10,
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));

        const createBook = async (userIndex: number, suffix: string, count: number) => {
          const book = await prisma.vocabularyBook.create({
            data: {
              ownerId: users[userIndex].id,
              kind: 'PERSONAL',
              sourceKey: `review-selection-${fixtureId}-${suffix}`,
              title: 'Review selection test',
              sourcePath: 'test',
              category: 'GENERAL',
              bookWords: {
                create: Array.from({ length: count }, (_, position) => ({
                  position,
                  word: {
                    create: {
                      normalized: `review-selection-${fixtureId}-${suffix}-${position}`,
                      text: `review${position}`,
                      meaning: '复习测试词',
                    },
                  },
                })),
              },
            },
            select: { id: true, bookWords: { select: { id: true, wordId: true, position: true } } },
          });
          bookWordIds.push(...book.bookWords.map((item) => item.id));
          wordIds.push(...book.bookWords.map((item) => item.wordId));
          await prisma.userVocabularyBook.create({
            data: { userId: users[userIndex].id, bookId: book.id, isDefault: true },
          });
          return book.bookWords;
        };

        const ownerWords = await createBook(0, 'owner', 43);
        const otherWords = await createBook(1, 'other', 1);
        const now = Date.now();
        await prisma.userWordProgress.createMany({
          data: ownerWords.map((item, index) => {
            const nextReviewAt = new Date(now - (100 - index) * 86_400_000);
            dueAt.set(item.id, nextReviewAt);
            return {
              userId: users[0].id,
              bookWordId: item.id,
              state: 'REVIEWING',
              nextReviewAt,
              lastReviewedAt: new Date(nextReviewAt.getTime() - 86_400_000),
              reviewCount: 3,
              totalAttempts: 4,
              correctAttempts: 2,
            };
          }),
        });
        const otherDueAt = new Date(now - 1_000 * 86_400_000);
        await prisma.userWordProgress.create({
          data: {
            userId: users[1].id,
            bookWordId: otherWords[0].id,
            state: 'REVIEWING',
            nextReviewAt: otherDueAt,
          },
        });

        const ai = { generateForUser: vi.fn() };
        const service = new StudyService(
          prisma as never,
          ai as never,
          {
            selectedProvider: vi.fn().mockResolvedValue({ id: 'isolated-fixture-model' }),
          } as never,
          {} as never,
        );

        const before = await prisma.userWordProgress.findMany({
          where: { userId: users[0].id },
          orderBy: { bookWordId: 'asc' },
          select: { bookWordId: true, nextReviewAt: true, reviewCount: true, totalAttempts: true },
        });
        await expect(service.createPlan(users[0].id, 0, 'group', 0)).rejects.toThrow(
          '没有带可用释义的单词',
        );
        expect(await prisma.studyPlan.count({ where: { userId: users[0].id } })).toBe(0);
        const firstPlan = await service.createPlan(users[0].id, 0, 'group', 2);
        const expectedFirst = [...ownerWords]
          .sort((a, b) => dueAt.get(a.id)!.getTime() - dueAt.get(b.id)!.getTime())
          .slice(0, 2)
          .map((item) => item.id);
        expect(firstPlan.words.map((word) => word.id).sort()).toEqual(expectedFirst.sort());
        expect(firstPlan.wordCount).toBe(2);
        const reusedPlan = await service.createPlan(users[0].id, 0, 'group', 0);
        expect(reusedPlan.id).toBe(firstPlan.id);
        expect(reusedPlan.words.map((word) => word.id).sort()).toEqual(expectedFirst.sort());
        expect(await prisma.studyPlan.count({ where: { userId: users[0].id } })).toBe(1);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: users[0].id } })).toBe(0);
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: users[0].id },
            orderBy: { bookWordId: 'asc' },
            select: {
              bookWordId: true,
              nextReviewAt: true,
              reviewCount: true,
              totalAttempts: true,
            },
          }),
        ).toEqual(before);
        expect(
          await prisma.studyPlanItem.count({ where: { planId: firstPlan.id, source: 'REVIEW' } }),
        ).toBe(2);
        expect(
          (await service.listPlans(users[0].id)).find((plan) => plan.id === firstPlan.id)
            ?.blocksNewPlanCreation,
        ).toBe(true);
        await prisma.studyPlan.update({
          where: { id: firstPlan.id },
          data: {
            status: 'ACTIVE',
            generatedContent: { groups: [] },
            generatedAt: new Date(now),
          },
        });
        expect(
          (await service.listPlans(users[0].id)).find((plan) => plan.id === firstPlan.id)
            ?.blocksNewPlanCreation,
        ).toBe(true);
        await prisma.studyPlan.update({
          where: { id: firstPlan.id },
          data: { status: 'FAILED', createdAt: new Date(now) },
        });
        expect(
          (await service.listPlans(users[0].id)).find((plan) => plan.id === firstPlan.id)
            ?.blocksNewPlanCreation,
        ).toBe(true);
        await prisma.studyPlan.update({
          where: { id: firstPlan.id },
          data: { createdAt: new Date(now - 2 * 86_400_000) },
        });
        expect(
          (await service.listPlans(users[0].id)).find((plan) => plan.id === firstPlan.id)
            ?.blocksNewPlanCreation,
        ).toBe(false);
        expect(ai.generateForUser).not.toHaveBeenCalled();
        await expect(service.createPlan(users[0].id, 0, 'group', 41)).rejects.toThrow(
          '本次复习数量必须在 0 到 40 之间',
        );

        await prisma.studyPlan.update({
          where: { id: firstPlan.id },
          data: { status: 'COMPLETED', createdAt: new Date(now) },
        });
        await prisma.userWordProgress.updateMany({
          where: { userId: users[0].id, bookWordId: { in: expectedFirst } },
          data: { nextReviewAt: new Date(now + 10 * 86_400_000) },
        });
        const nextPlan = await service.createPlan(users[0].id, 0);
        expect(nextPlan.wordCount).toBe(40);
        expect(nextPlan.words.map((word) => word.id)).not.toContain(otherWords[0].id);
        const remainingDue = await prisma.userWordProgress.findMany({
          where: { userId: users[0].id, state: 'REVIEWING', nextReviewAt: { lte: new Date() } },
          select: { bookWordId: true },
        });
        expect(remainingDue).toHaveLength(41);
        expect(nextPlan.words.map((word) => word.id)).not.toContain(ownerWords[42].id);
        expect(
          (
            await prisma.userWordProgress.findUniqueOrThrow({
              where: { userId_bookWordId: { userId: users[1].id, bookWordId: otherWords[0].id } },
              select: { nextReviewAt: true },
            })
          ).nextReviewAt,
        ).toEqual(otherDueAt);
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        if (bookWordIds.length)
          await prisma.vocabularyBookWord.deleteMany({ where: { id: { in: bookWordIds } } });
        if (wordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
        await prisma.vocabularyBook.deleteMany({
          where: { sourceKey: { startsWith: `review-selection-${fixtureId}-` } },
        });
      }
    }, 30_000);
  },
);
