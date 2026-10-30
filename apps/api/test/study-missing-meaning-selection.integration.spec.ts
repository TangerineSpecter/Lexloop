import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'meaning-safe study selection in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('keeps missing-meaning words visible and due, excludes them from every new plan source, and blocks legacy generation', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      clients.push(prisma);
      const fixtureId = randomUUID();
      let userId: string | undefined;
      let bookId: string | undefined;
      let legacyPlanId: string | undefined;
      let generatedCacheId: string | undefined;
      const wordIds: string[] = [];
      const bookWordIds: string[] = [];
      const createdPlanIds: string[] = [];

      const removePlan = async (planId: string) => {
        await prisma.studyPlan.delete({ where: { id: planId } });
        const index = createdPlanIds.indexOf(planId);
        if (index >= 0) createdPlanIds.splice(index, 1);
      };

      try {
        const learner = await prisma.user.create({
          data: {
            email: `missing-meaning-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
            defaultNewWordCount: 5,
          },
          select: { id: true },
        });
        userId = learner.id;

        const sourceRows = [
          { key: 'valid-global', text: 'steady', meaning: '稳定的', contextMeaning: null },
          { key: 'missing-null', text: 'unmapped', meaning: null, contextMeaning: null },
          {
            key: 'missing-context',
            text: 'contextless',
            meaning: '全局释义不能替代空的词表释义',
            contextMeaning: '  ',
          },
          { key: 'valid-context', text: 'local', meaning: null, contextMeaning: 'adj. 仅词表释义' },
          { key: 'placeholder', text: 'placeholder', meaning: 'n. 暂无释义', contextMeaning: null },
        ] as const;
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: learner.id,
            kind: 'PERSONAL',
            sourceKey: `missing-meaning-${fixtureId}`,
            title: 'Meaning availability integration fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: sourceRows.map((row, position) => ({
                position,
                contextMeaning: row.contextMeaning,
                word: {
                  create: {
                    normalized: `${fixtureId}-${row.key}`,
                    text: row.text,
                    meaning: row.meaning,
                  },
                },
              })),
            },
          },
          select: {
            id: true,
            bookWords: {
              orderBy: { position: 'asc' },
              select: { id: true, wordId: true, position: true },
            },
          },
        });
        bookId = book.id;
        bookWordIds.push(...book.bookWords.map((row) => row.id));
        wordIds.push(...book.bookWords.map((row) => row.wordId));
        const bookWordByKey = new Map(
          sourceRows.map((row, index) => [row.key, book.bookWords[index]]),
        );
        const dueAt = new Date(Date.now() - 60_000);
        const dueRows = (['missing-context', 'valid-context', 'placeholder'] as const).map(
          (key) => ({
            userId: learner.id,
            bookWordId: bookWordByKey.get(key)!.id,
            state: 'REVIEWING' as const,
            nextReviewAt: dueAt,
            lastReviewedAt: new Date(dueAt.getTime() - 86_400_000),
            reviewCount: 3,
            totalAttempts: 4,
            correctAttempts: 2,
          }),
        );
        await prisma.userVocabularyBook.create({
          data: { userId: learner.id, bookId: book.id, isDefault: true },
        });
        await prisma.userWordProgress.createMany({ data: dueRows });
        const weaknessTime = new Date('2026-10-01T12:00:00.000Z');
        await prisma.weaknessSignal.createMany({
          data: (['missing-null', 'missing-context', 'valid-context'] as const).map(
            (key, index) => ({
              userId: learner.id,
              bookWordId: bookWordByKey.get(key)!.id,
              questionType: 'MEANING_RECOGNITION',
              status: 'ACTIVE',
              wrongCount: 5 - index,
              lastWrongAt: weaknessTime,
              lastAttemptAt: weaknessTime,
            }),
          ),
        });

        const ai = { generateForUser: vi.fn() };
        const selectedProvider = vi.fn().mockResolvedValue({ id: 'isolated-fixture-model' });
        const service = new StudyService(
          prisma as never,
          ai as never,
          { selectedProvider } as never,
          {} as never,
        );
        const dashboard = new VocabularyService(prisma as never);
        const dashboardWords = await dashboard.getDashboardWords(learner.id, '5');
        expect(dashboardWords.reviewWords).toHaveLength(3);
        expect(
          dashboardWords.reviewWords.find((word) => word.word === 'contextless'),
        ).toMatchObject({ meaning: '暂无释义', meanings: [] });

        const beforeProgress = await prisma.userWordProgress.findMany({
          where: { userId: learner.id },
          orderBy: { bookWordId: 'asc' },
          select: {
            bookWordId: true,
            state: true,
            nextReviewAt: true,
            reviewCount: true,
            totalAttempts: true,
            correctAttempts: true,
          },
        });
        const dailyPlan = await service.createPlan(learner.id, 5, 'group', 40);
        createdPlanIds.push(dailyPlan.id);
        expect(dailyPlan.words.map((word) => word.id).sort()).toEqual(
          [bookWordByKey.get('valid-global')!.id, bookWordByKey.get('valid-context')!.id].sort(),
        );
        expect(Object.fromEntries(dailyPlan.words.map((word) => [word.id, word.source]))).toEqual({
          [bookWordByKey.get('valid-global')!.id]: 'NEW',
          [bookWordByKey.get('valid-context')!.id]: 'REVIEW',
        });
        expect(dailyPlan.words.every((word) => word.meanings.length > 0)).toBe(true);
        expect(await prisma.studyPlanItem.count({ where: { planId: dailyPlan.id } })).toBe(2);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: learner.id } })).toBe(0);
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: learner.id },
            orderBy: { bookWordId: 'asc' },
            select: {
              bookWordId: true,
              state: true,
              nextReviewAt: true,
              reviewCount: true,
              totalAttempts: true,
              correctAttempts: true,
            },
          }),
        ).toEqual(beforeProgress);
        expect(ai.generateForUser).not.toHaveBeenCalled();
        await removePlan(dailyPlan.id);

        const createIndividual = async (source: 'book' | 'mistakes' | 'random' | 'frequent') => {
          const plan = await service.createPlan(learner.id, 10, 'individual', 0, source);
          createdPlanIds.push(plan.id);
          return plan;
        };
        const bookPlan = await createIndividual('book');
        expect(bookPlan.words.map((word) => word.id)).toEqual([
          bookWordByKey.get('valid-global')!.id,
        ]);
        expect(bookPlan.words.every((word) => word.meanings.length > 0)).toBe(true);
        await removePlan(bookPlan.id);

        const mistakePlan = await createIndividual('mistakes');
        expect(mistakePlan.words.map((word) => word.id)).toEqual([
          bookWordByKey.get('valid-context')!.id,
        ]);
        expect(mistakePlan.words.every((word) => word.meanings.length > 0)).toBe(true);
        await removePlan(mistakePlan.id);

        for (const source of ['random', 'frequent'] as const) {
          const plan = await createIndividual(source);
          expect(new Set(plan.words.map((word) => word.id))).toEqual(
            new Set([
              bookWordByKey.get('valid-global')!.id,
              bookWordByKey.get('valid-context')!.id,
            ]),
          );
          expect(plan.words.every((word) => word.meanings.length > 0)).toBe(true);
          await removePlan(plan.id);
        }

        await prisma.vocabularyBookWord.update({
          where: { id: bookWordByKey.get('valid-context')!.id },
          data: { contextMeaning: null },
        });
        await prisma.vocabularyWord.updateMany({
          where: {
            id: {
              in: [
                bookWordByKey.get('valid-global')!.wordId,
                bookWordByKey.get('valid-context')!.wordId,
              ],
            },
          },
          data: { meaning: null },
        });
        const progressBeforeEmptySelection = await prisma.userWordProgress.findMany({
          where: { userId: learner.id },
          orderBy: { bookWordId: 'asc' },
          select: { bookWordId: true, state: true, nextReviewAt: true, reviewCount: true },
        });
        await expect(service.createPlan(learner.id, 5, 'group', 40)).rejects.toThrow(
          '当前选择范围没有带可用释义的单词',
        );
        expect(await prisma.studyPlan.count({ where: { userId: learner.id } })).toBe(0);
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: learner.id },
            orderBy: { bookWordId: 'asc' },
            select: { bookWordId: true, state: true, nextReviewAt: true, reviewCount: true },
          }),
        ).toEqual(progressBeforeEmptySelection);
        for (const source of ['book', 'mistakes', 'random', 'frequent'] as const) {
          await expect(service.createPlan(learner.id, 10, 'individual', 0, source)).rejects.toThrow(
            '没有带可用释义',
          );
          expect(await prisma.studyPlan.count({ where: { userId: learner.id } })).toBe(0);
        }
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: learner.id },
            orderBy: { bookWordId: 'asc' },
            select: { bookWordId: true, state: true, nextReviewAt: true, reviewCount: true },
          }),
        ).toEqual(progressBeforeEmptySelection);

        const legacyPlan = await prisma.studyPlan.create({
          data: {
            userId: learner.id,
            mode: 'GROUP',
            purpose: 'NORMAL',
            status: 'GENERATING',
            items: {
              create: {
                bookWordId: bookWordByKey.get('missing-null')!.id,
                source: 'REVIEW',
                groupIndex: 0,
              },
            },
          },
        });
        legacyPlanId = legacyPlan.id;
        const guardedLegacyPlan = await service.generatePlan(learner.id, legacyPlan.id);
        expect(guardedLegacyPlan).toMatchObject({
          id: legacyPlan.id,
          status: 'FAILED',
          wordCount: 1,
        });
        expect(guardedLegacyPlan.generationError).toContain('没有可用释义');
        expect(await prisma.studyPlanItem.count({ where: { planId: legacyPlan.id } })).toBe(1);
        expect(selectedProvider).not.toHaveBeenCalled();
        expect(ai.generateForUser).not.toHaveBeenCalled();
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: learner.id },
            orderBy: { bookWordId: 'asc' },
            select: { bookWordId: true, state: true, nextReviewAt: true, reviewCount: true },
          }),
        ).toEqual(progressBeforeEmptySelection);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: learner.id } })).toBe(0);

        await prisma.vocabularyWord.update({
          where: { id: bookWordByKey.get('missing-null')!.wordId },
          data: { meaning: 'v. 映射；对应' },
        });
        ai.generateForUser.mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [
                    {
                      index: 0,
                      title: 'Using unmapped',
                      wordOccurrences: { unmapped: 1 },
                      sentences: [
                        {
                          english: 'The label was unmapped.',
                          chinese: '这个标签没有对应内容。',
                          simplified: 'The label was unmapped.',
                          grammar: '一般过去时',
                        },
                      ],
                      questions: [
                        {
                          bookWordId: bookWordByKey.get('missing-null')!.id,
                          type: 'MEANING_RECOGNITION',
                          prompt: 'What does unmapped mean here?',
                          options: ['没有对应内容', '快速移动', '仔细标记', '完全相同'],
                          correctAnswers: ['没有对应内容'],
                          explanation: 'unmapped 在这里表示没有对应内容。',
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        });
        const retriedPlan = await service.generatePlan(learner.id, legacyPlan.id);
        expect(retriedPlan).toMatchObject({ id: legacyPlan.id, status: 'ACTIVE', wordCount: 1 });
        expect(retriedPlan.content).toMatchObject({
          groups: [
            {
              questions: [{ bookWordId: bookWordByKey.get('missing-null')!.id }],
            },
          ],
        });
        expect(await prisma.studyPlanItem.count({ where: { planId: legacyPlan.id } })).toBe(1);
        generatedCacheId =
          (
            await prisma.studyPlanItem.findFirstOrThrow({
              where: { planId: legacyPlan.id },
              select: { contentCacheId: true },
            })
          ).contentCacheId ?? undefined;
        expect(selectedProvider).toHaveBeenCalledTimes(1);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: learner.id },
            orderBy: { bookWordId: 'asc' },
            select: { bookWordId: true, state: true, nextReviewAt: true, reviewCount: true },
          }),
        ).toEqual(progressBeforeEmptySelection);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: learner.id } })).toBe(0);
      } finally {
        if (legacyPlanId) await prisma.studyPlan.deleteMany({ where: { id: legacyPlanId } });
        if (generatedCacheId)
          await prisma.studyContentCache.deleteMany({ where: { id: generatedCacheId } });
        if (createdPlanIds.length)
          await prisma.studyPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
        if (userId) {
          await prisma.weaknessSignal.deleteMany({ where: { userId } });
          await prisma.userWordProgress.deleteMany({ where: { userId } });
          await prisma.userVocabularyBook.deleteMany({ where: { userId } });
        }
        if (bookId)
          await prisma.vocabularyBook.delete({ where: { id: bookId } }).catch(() => undefined);
        if (wordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      }
    }, 30_000);
  },
);
