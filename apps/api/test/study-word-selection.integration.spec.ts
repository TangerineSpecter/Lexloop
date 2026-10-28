import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'individual word selection in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('keeps book, mistake, random, and frequent selections scoped to each learner', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      clients.push(prisma);

      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const planIds: string[] = [];
      let bookId: string | undefined;
      let bookWordIds: string[] = [];
      let wordIds: string[] = [];

      try {
        const createLearner = async (suffix: string) => {
          const user = await prisma.user.create({
            data: {
              email: `study-selection-${fixtureId}-${suffix}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
              defaultNewWordCount: 10,
            },
            select: { id: true },
          });
          userIds.push(user.id);
          return user;
        };

        const learner = await createLearner('one');
        const otherLearner = await createLearner('two');
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey: `study-selection-${fixtureId}`,
            category: 'GENERAL',
            title: 'Individual selection integration fixture',
            sourcePath: 'test',
            bookWords: {
              create: (
                [
                  { text: 'alpha', priority: 100, level: 'B2' },
                  { text: 'beta', priority: 50, level: 'A1' },
                  { text: 'gamma', priority: 50, level: 'B1' },
                  { text: 'delta', priority: 0, level: 'A2' },
                ] as const
              ).map((word, position) => ({
                position,
                word: {
                  create: {
                    normalized: `${fixtureId}-${word.text}`,
                    text: word.text,
                    meaning: 'n. 测试词',
                    spokenPriority: word.priority,
                    cefrLevel: word.level,
                  },
                },
              })),
            },
          },
          select: { id: true, bookWords: { select: { id: true, wordId: true, position: true } } },
        });
        bookId = book.id;
        const orderedBookWords = [...book.bookWords].sort(
          (left, right) => left.position - right.position,
        );
        bookWordIds = orderedBookWords.map((item) => item.id);
        wordIds = orderedBookWords.map((item) => item.wordId);

        await prisma.userVocabularyBook.createMany({
          data: [learner.id, otherLearner.id].map((userId) => ({
            userId,
            bookId: book.id,
            isDefault: true,
          })),
        });

        const wordByText = new Map(
          orderedBookWords.map((item, index) => [['alpha', 'beta', 'gamma', 'delta'][index], item]),
        );
        const alpha = wordByText.get('alpha')!;
        const beta = wordByText.get('beta')!;
        const gamma = wordByText.get('gamma')!;
        const delta = wordByText.get('delta')!;

        await prisma.userMasteredWord.create({
          data: { userId: learner.id, wordId: alpha.wordId },
        });
        await prisma.userWordProgress.create({
          data: {
            userId: learner.id,
            bookWordId: gamma.id,
            state: 'LEARNING',
            totalAttempts: 8,
          },
        });
        await prisma.userWordProgress.create({
          data: {
            userId: learner.id,
            bookWordId: beta.id,
            state: 'LEARNING',
            totalAttempts: 3,
          },
        });

        const lastWrongAt = new Date('2026-10-01T12:00:00.000Z');
        const createWeakness = (
          userId: string,
          bookWordId: string,
          questionType: string,
          wrongCount: number,
        ) => ({
          userId,
          bookWordId,
          questionType,
          wrongCount,
          lastWrongAt,
          lastAttemptAt: lastWrongAt,
        });
        await prisma.weaknessSignal.createMany({
          data: [
            createWeakness(learner.id, alpha.id, 'MEANING_RECOGNITION', 5),
            createWeakness(learner.id, gamma.id, 'MEANING_RECOGNITION', 3),
            createWeakness(learner.id, beta.id, 'MEANING_RECOGNITION', 2),
            createWeakness(learner.id, beta.id, 'WORD_MATCHING', 1),
            createWeakness(otherLearner.id, delta.id, 'MEANING_RECOGNITION', 9),
          ],
        });

        const ai = { generateForUser: vi.fn() };
        const selectedProvider = vi.fn(async () => ({ id: 'isolated-fixture-model' }));
        const service = new StudyService(
          prisma as never,
          ai as never,
          { selectedProvider } as never,
          {} as never,
        );

        const select = async (
          userId: string,
          source: 'book' | 'mistakes' | 'random' | 'frequent',
          count = 20,
        ) => {
          const plan = await service.createPlan(userId, count, 'individual', 0, source);
          planIds.push(plan.id);
          return plan as {
            id: string;
            mode: string;
            words: Array<{ id: string; source: string; groupIndex: number }>;
          };
        };
        const removePlan = async (planId: string) => {
          await prisma.studyPlan.delete({ where: { id: planId } });
          planIds.splice(planIds.indexOf(planId), 1);
        };

        const learnerBookPlan = await select(learner.id, 'book');
        expect(learnerBookPlan.mode).toBe('individual');
        expect(learnerBookPlan.words.map((item) => item.id)).toEqual([delta.id]);
        await removePlan(learnerBookPlan.id);

        const otherLearnerBookPlan = await select(otherLearner.id, 'book');
        expect(otherLearnerBookPlan.words.map((item) => item.id)).toEqual(bookWordIds);
        await removePlan(otherLearnerBookPlan.id);

        const mistakePlan = await select(learner.id, 'mistakes');
        expect(mistakePlan.words.map((item) => item.id)).toEqual([gamma.id, beta.id]);
        expect(mistakePlan.words.every((item) => item.source === 'REVIEW')).toBe(true);
        await removePlan(mistakePlan.id);

        const randomPlan = await select(learner.id, 'random', 3);
        expect(new Set(randomPlan.words.map((item) => item.id))).toEqual(
          new Set([beta.id, gamma.id, delta.id]),
        );
        expect(Object.fromEntries(randomPlan.words.map((item) => [item.id, item.source]))).toEqual({
          [beta.id]: 'REVIEW',
          [gamma.id]: 'REVIEW',
          [delta.id]: 'NEW',
        });
        await removePlan(randomPlan.id);

        const frequentPlan = await select(learner.id, 'frequent', 3);
        expect(frequentPlan.words.map((item) => item.id)).toEqual([gamma.id, beta.id, delta.id]);
        expect(frequentPlan.words.map((item) => item.source)).toEqual(['REVIEW', 'REVIEW', 'NEW']);
        await removePlan(frequentPlan.id);

        expect(selectedProvider).toHaveBeenCalledTimes(5);
        expect(ai.generateForUser).not.toHaveBeenCalled();
        expect(await prisma.studyPlanItem.count({ where: { planId: { in: planIds } } })).toBe(0);
      } finally {
        if (planIds.length) await prisma.studyPlan.deleteMany({ where: { id: { in: planIds } } });
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        if (wordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
      }
    }, 30_000);
  },
);
