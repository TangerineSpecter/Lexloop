import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'study answer visibility in an isolated database',
  () => {
    it('unlocks answers only after every item in that user group is complete and preserves completed history', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const createdAt = new Date();
      const completedAt = new Date(Date.now() + 1_000);
      const users: Array<{ id: string }> = [];
      const words: Array<{ id: string }> = [];
      let bookId: string | undefined;
      try {
        for (const suffix of ['one', 'two']) {
          users.push(
            await prisma.user.create({
              data: {
                email: `study-answer-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          );
        }
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: users[0].id,
            kind: 'PERSONAL',
            sourceKey: fixtureId,
            title: 'Study answer visibility test',
            sourcePath: 'test',
            category: 'GENERAL',
          },
        });
        bookId = book.id;
        for (const [position, text] of ['bright', 'help'].entries()) {
          words.push(
            await prisma.vocabularyWord.create({
              data: {
                normalized: `study-answer-${fixtureId}-${text}`,
                text,
                meaning: position ? '帮助' : '明亮的',
              },
              select: { id: true },
            }),
          );
        }
        const bookWords = await Promise.all(
          words.map((word, position) =>
            prisma.vocabularyBookWord.create({
              data: { bookId: book.id, wordId: word.id, position },
              select: { id: true },
            }),
          ),
        );
        const questions = [
          {
            bookWordId: bookWords[0].id,
            type: 'MEANING_RECOGNITION',
            prompt: 'Choose the meaning of bright.',
            options: ['暗的', '明亮的'],
            correctAnswers: ['明亮的'],
            explanation: 'bright 描述光线充足或颜色鲜明。',
          },
          {
            bookWordId: bookWords[1].id,
            type: 'MEANING_RECOGNITION',
            prompt: 'Choose the meaning of help.',
            options: ['帮助', '拒绝'],
            correctAnswers: ['帮助'],
            explanation: 'help 表示提供帮助。',
          },
        ];
        const generatedContent = {
          groups: [
            {
              index: 0,
              title: 'A bright helping hand',
              wordOccurrences: { bright: 1, help: 1 },
              sentences: [],
              questions,
            },
          ],
        };
        const createPlan = async (
          userId: string,
          status: 'ACTIVE' | 'COMPLETED',
          completedIndices: number[],
          groupIndices = [0, 0],
        ) =>
          prisma.studyPlan.create({
            data: {
              userId,
              mode: 'GROUP',
              purpose: 'NORMAL',
              status,
              generatedContent,
              generatedAt: createdAt,
              completedAt: status === 'COMPLETED' ? completedAt : null,
              items: {
                create: questions.map((question, index) => ({
                  bookWordId: bookWords[index].id,
                  source: 'NEW',
                  groupIndex: groupIndices[index],
                  question,
                  completedAt: completedIndices.includes(index) ? completedAt : null,
                })),
              },
            },
            select: { id: true },
          });
        const [
          ownerPlan,
          partialPlan,
          legacyCompletedPlan,
          competingPlan,
          rollbackPlan,
          crossGroupPlan,
          otherUserPlan,
        ] = await Promise.all([
          createPlan(users[0].id, 'ACTIVE', []),
          createPlan(users[1].id, 'ACTIVE', [0]),
          createPlan(users[0].id, 'COMPLETED', [0, 1]),
          createPlan(users[0].id, 'ACTIVE', []),
          createPlan(users[0].id, 'ACTIVE', []),
          createPlan(users[0].id, 'ACTIVE', [], [0, 1]),
          createPlan(users[1].id, 'ACTIVE', []),
        ]);
        const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);
        type SerializedQuestion = { correctAnswers?: string[]; explanation?: string };
        type SerializedPlan = {
          id: string;
          content: { groups: Array<{ questions: SerializedQuestion[] }> };
          words: Array<{ question: SerializedQuestion }>;
        };

        const ownerPlans = (await service.listPlans(users[0].id)) as unknown as SerializedPlan[];
        const partialPlans = (await service.listPlans(users[1].id)) as unknown as SerializedPlan[];
        expect(ownerPlans.map((plan) => plan.id)).toContain(ownerPlan.id);
        expect(ownerPlans.map((plan) => plan.id)).not.toContain(partialPlan.id);
        expect(partialPlans.map((plan) => plan.id)).toContain(partialPlan.id);
        const partialPlanSummary = partialPlans.find((plan) => plan.id === partialPlan.id)!;
        expect(partialPlanSummary.content!.groups[0].questions[0]).not.toHaveProperty(
          'correctAnswers',
        );
        expect(partialPlanSummary.words[0].question).not.toHaveProperty('correctAnswers');
        expect(partialPlanSummary.content!.groups[0].questions[1]).not.toHaveProperty(
          'explanation',
        );

        await prisma.studyPlanItem.updateMany({
          where: { planId: partialPlan.id, groupIndex: 0 },
          data: { completedAt },
        });
        const completedPartial = (await service.listPlans(
          users[1].id,
        )) as unknown as SerializedPlan[];
        const completedPartialPlan = completedPartial.find((plan) => plan.id === partialPlan.id)!;
        expect(completedPartialPlan.content!.groups[0].questions[0].correctAnswers).toEqual([
          '明亮的',
        ]);
        expect(completedPartialPlan.words[1].question.correctAnswers).toEqual(['帮助']);

        const history = await service.listCompletedPlans(users[0].id);
        const historyItems = history.items as unknown as SerializedPlan[];
        expect(historyItems.map((plan) => plan.id)).toContain(legacyCompletedPlan.id);
        const oldPlan = historyItems.find((plan) => plan.id === legacyCompletedPlan.id)!;
        expect(oldPlan.content!.groups[0].questions[0].correctAnswers).toEqual(['明亮的']);
        await expect(service.completeGroup(users[1].id, ownerPlan.id, 0, [])).rejects.toThrow(
          '学习分组不存在或计划尚未生成完毕',
        );

        await prisma.userWordProgress.createMany({
          data: users.flatMap((user) =>
            bookWords.map((bookWord) => ({
              userId: user.id,
              bookWordId: bookWord.id,
              state: 'LEARNING',
            })),
          ),
        });
        await prisma.weaknessSignal.create({
          data: {
            userId: users[0].id,
            bookWordId: bookWords[0].id,
            questionType: 'MEANING_RECOGNITION',
            lastWrongAt: createdAt,
            lastAttemptAt: createdAt,
          },
        });

        const answersFor = (correct: boolean) =>
          bookWords.map((bookWord, index) => ({
            bookWordId: bookWord.id,
            selectedAnswer: [correct ? (index ? '帮助' : '明亮的') : index ? '拒绝' : '暗的'],
            responseTimeMs: 800,
          }));
        const progressFor = (userId: string) =>
          prisma.userWordProgress.findMany({
            where: { userId, bookWordId: { in: bookWords.map((word) => word.id) } },
            orderBy: { bookWordId: 'asc' },
            select: {
              bookWordId: true,
              totalAttempts: true,
              correctAttempts: true,
              consecutiveCorrect: true,
              reviewCount: true,
            },
          });
        const attemptsFor = async (planId: string) => {
          const items = await prisma.studyPlanItem.findMany({
            where: { planId },
            select: { id: true },
          });
          return prisma.wordReviewAttempt.findMany({
            where: { planItemId: { in: items.map((item) => item.id) } },
            orderBy: { planItemId: 'asc' },
            select: { planItemId: true, isCorrect: true, selectedAnswer: true },
          });
        };
        const createReadBarrierService = (targets: Set<string>, expectedReaders: number) => {
          let waitingReaders = 0;
          let releaseReaders!: () => void;
          const allReads = new Promise<void>((resolve) => {
            releaseReaders = resolve;
          });
          const gatedStudyPlanItems = new Proxy(prisma.studyPlanItem, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property !== 'findMany')
                return typeof value === 'function' ? value.bind(target) : value;
              return async (...args: any[]) => {
                const rows = await value.apply(target, args);
                const key = `${args[0]?.where?.planId}:${args[0]?.where?.groupIndex}`;
                if (targets.has(key)) {
                  waitingReaders++;
                  if (waitingReaders === expectedReaders) releaseReaders();
                  await allReads;
                }
                return rows;
              };
            },
          });
          const gatedPrisma = new Proxy(prisma, {
            get(target, property) {
              if (property === 'studyPlanItem') return gatedStudyPlanItems;
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return new StudyService(
            gatedPrisma as never,
            {} as never,
            {} as never,
            new MistakesService({} as never),
          );
        };
        const serviceWithMistakes = new StudyService(
          prisma as never,
          {} as never,
          {} as never,
          new MistakesService({} as never),
        );

        const sameAnswerService = createReadBarrierService(new Set([`${ownerPlan.id}:0`]), 2);
        const correctAnswers = answersFor(true);
        const identicalSubmissions = await Promise.all([
          sameAnswerService.completeGroup(users[0].id, ownerPlan.id, 0, correctAnswers),
          sameAnswerService.completeGroup(users[0].id, ownerPlan.id, 0, correctAnswers),
        ]);
        expect(identicalSubmissions.map((result) => result.status)).toEqual([
          'COMPLETED',
          'COMPLETED',
        ]);
        expect(await attemptsFor(ownerPlan.id)).toHaveLength(2);
        const firstProgress = await progressFor(users[0].id);
        expect(firstProgress).toHaveLength(2);
        expect(
          firstProgress.every(
            (row) =>
              row.totalAttempts === 1 &&
              row.correctAttempts === 1 &&
              row.consecutiveCorrect === 1 &&
              row.reviewCount === 1,
          ),
        ).toBe(true);
        const weakness = await prisma.weaknessSignal.findFirstOrThrow({
          where: { userId: users[0].id, bookWordId: bookWords[0].id },
        });
        expect(weakness).toMatchObject({ status: 'ACTIVE', consecutiveCorrect: 1, wrongCount: 1 });

        const differentAnswerService = createReadBarrierService(
          new Set([`${competingPlan.id}:0`]),
          2,
        );
        const competingSubmissions = await Promise.all([
          differentAnswerService.completeGroup(users[0].id, competingPlan.id, 0, correctAnswers),
          differentAnswerService.completeGroup(users[0].id, competingPlan.id, 0, answersFor(false)),
        ]);
        expect(competingSubmissions.map((result) => result.status)).toEqual([
          'COMPLETED',
          'COMPLETED',
        ]);
        const competingItems = await prisma.studyPlanItem.findMany({
          where: { planId: competingPlan.id },
          select: { id: true, bookWordId: true },
        });
        const competingAttempts = await attemptsFor(competingPlan.id);
        expect(competingAttempts).toHaveLength(2);
        expect(new Set(competingAttempts.map((attempt) => attempt.planItemId)).size).toBe(2);
        const allCorrectWon = competingAttempts.every((attempt) => attempt.isCorrect);
        const allWrongWon = competingAttempts.every((attempt) => !attempt.isCorrect);
        expect(allCorrectWon || allWrongWon).toBe(true);
        for (const attempt of competingAttempts) {
          const item = competingItems.find((candidate) => candidate.id === attempt.planItemId)!;
          const index = bookWords.findIndex((word) => word.id === item.bookWordId);
          expect(attempt.selectedAnswer).toEqual([
            allCorrectWon ? (index ? '帮助' : '明亮的') : index ? '拒绝' : '暗的',
          ]);
        }
        const afterCompetingAnswers = await progressFor(users[0].id);
        expect(
          afterCompetingAnswers.every(
            (row) =>
              row.totalAttempts === 2 &&
              row.reviewCount === 2 &&
              row.correctAttempts === (allCorrectWon ? 2 : 1) &&
              row.consecutiveCorrect === (allCorrectWon ? 2 : 0),
          ),
        ).toBe(true);

        const savedResult = await serviceWithMistakes.completeGroup(
          users[0].id,
          competingPlan.id,
          0,
          allCorrectWon ? answersFor(true) : answersFor(false),
        );
        const lateDifferentAnswer = await serviceWithMistakes.completeGroup(
          users[0].id,
          competingPlan.id,
          0,
          allCorrectWon ? answersFor(false) : answersFor(true),
        );
        expect(lateDifferentAnswer.words.map(({ id, result }) => ({ id, result }))).toEqual(
          savedResult.words.map(({ id, result }) => ({ id, result })),
        );
        expect(await attemptsFor(competingPlan.id)).toEqual(competingAttempts);

        const beforeFailedTransaction = await progressFor(users[0].id);
        const weaknessBeforeFailedTransaction = await prisma.weaknessSignal.findFirstOrThrow({
          where: { userId: users[0].id, bookWordId: bookWords[0].id },
        });
        let attemptCreates = 0;
        const failingPrisma = new Proxy(prisma, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== '$transaction')
              return typeof value === 'function' ? value.bind(target) : value;
            return (callback: (...args: any[]) => unknown, ...options: any[]) =>
              value.call(
                target,
                (tx: any) => {
                  const failingAttemptDelegate = new Proxy(tx.wordReviewAttempt, {
                    get(delegate, method) {
                      const methodValue = Reflect.get(delegate, method, delegate);
                      if (method !== 'create')
                        return typeof methodValue === 'function'
                          ? methodValue.bind(delegate)
                          : methodValue;
                      return async (...args: any[]) => {
                        attemptCreates++;
                        if (attemptCreates === 2) {
                          throw new Error('simulated attempt write failure');
                        }
                        return methodValue.apply(delegate, args);
                      };
                    },
                  });
                  const failingTx = new Proxy(tx, {
                    get(transaction, method) {
                      if (method === 'wordReviewAttempt') return failingAttemptDelegate;
                      const methodValue = Reflect.get(transaction, method, transaction);
                      return typeof methodValue === 'function'
                        ? methodValue.bind(transaction)
                        : methodValue;
                    },
                  });
                  return callback(failingTx);
                },
                ...options,
              );
          },
        });
        const failingService = new StudyService(
          failingPrisma as never,
          {} as never,
          {} as never,
          new MistakesService({} as never),
        );
        await expect(
          failingService.completeGroup(users[0].id, rollbackPlan.id, 0, correctAnswers),
        ).rejects.toThrow('simulated attempt write failure');
        expect(await attemptsFor(rollbackPlan.id)).toHaveLength(0);
        const rolledBackItems = await prisma.studyPlanItem.findMany({
          where: { planId: rollbackPlan.id },
          select: { completedAt: true },
        });
        expect(rolledBackItems.every((item) => item.completedAt === null)).toBe(true);
        expect(await progressFor(users[0].id)).toEqual(beforeFailedTransaction);
        expect(
          await prisma.weaknessSignal.findFirstOrThrow({
            where: { userId: users[0].id, bookWordId: bookWords[0].id },
          }),
        ).toEqual(weaknessBeforeFailedTransaction);
        const retriedAfterFailure = await serviceWithMistakes.completeGroup(
          users[0].id,
          rollbackPlan.id,
          0,
          correctAnswers,
        );
        expect(retriedAfterFailure.status).toBe('COMPLETED');
        expect(await attemptsFor(rollbackPlan.id)).toHaveLength(2);
        const afterSuccessfulRetry = await progressFor(users[0].id);
        expect(
          afterSuccessfulRetry.every(
            (row, index) =>
              row.totalAttempts === beforeFailedTransaction[index].totalAttempts + 1 &&
              row.correctAttempts === beforeFailedTransaction[index].correctAttempts + 1 &&
              row.consecutiveCorrect === beforeFailedTransaction[index].consecutiveCorrect + 1 &&
              row.reviewCount === beforeFailedTransaction[index].reviewCount + 1,
          ),
        ).toBe(true);
        const weaknessAfterRetry = await prisma.weaknessSignal.findFirstOrThrow({
          where: { userId: users[0].id, bookWordId: bookWords[0].id },
        });
        expect(weaknessAfterRetry.wrongCount).toBe(weaknessBeforeFailedTransaction.wrongCount);
        expect(weaknessAfterRetry.consecutiveCorrect).toBe(
          weaknessBeforeFailedTransaction.consecutiveCorrect + 1,
        );

        let claimReached!: () => void;
        let releaseClaim!: () => void;
        let held = false;
        const claimIsHeld = new Promise<void>((resolve) => {
          claimReached = resolve;
        });
        const releaseHeldClaim = new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
        const blockingPrisma = new Proxy(prisma, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== '$transaction')
              return typeof value === 'function' ? value.bind(target) : value;
            return (...args: any[]) => {
              const [callback, ...options] = args;
              return value.call(
                target,
                (tx: any) => {
                  const blockingItemDelegate = new Proxy(tx.studyPlanItem, {
                    get(delegate, method) {
                      const methodValue = Reflect.get(delegate, method, delegate);
                      if (method !== 'updateMany')
                        return typeof methodValue === 'function'
                          ? methodValue.bind(delegate)
                          : methodValue;
                      return async (...updateArgs: any[]) => {
                        const result = await methodValue.apply(delegate, updateArgs);
                        if (!held && updateArgs[0]?.where?.completedAt === null) {
                          held = true;
                          claimReached();
                          await releaseHeldClaim;
                        }
                        return result;
                      };
                    },
                  });
                  const blockingTx = new Proxy(tx, {
                    get(transaction, method) {
                      if (method === 'studyPlanItem') return blockingItemDelegate;
                      const methodValue = Reflect.get(transaction, method, transaction);
                      return typeof methodValue === 'function'
                        ? methodValue.bind(transaction)
                        : methodValue;
                    },
                  });
                  return callback(blockingTx);
                },
                ...options,
              );
            };
          },
        });
        const blockingService = new StudyService(
          blockingPrisma as never,
          {} as never,
          {} as never,
          new MistakesService({} as never),
        );
        const heldGroupSubmission = blockingService.completeGroup(
          users[0].id,
          crossGroupPlan.id,
          0,
          [correctAnswers[0]],
        );
        await claimIsHeld;
        const independentSubmissions = Promise.all([
          serviceWithMistakes.completeGroup(users[0].id, crossGroupPlan.id, 1, [correctAnswers[1]]),
          serviceWithMistakes.completeGroup(users[1].id, otherUserPlan.id, 0, correctAnswers),
        ]);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const progressedBeforeRelease = await Promise.race([
          independentSubmissions.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 5_000);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        releaseClaim();
        const [, independentResults] = await Promise.all([
          heldGroupSubmission,
          independentSubmissions,
        ]);
        expect(progressedBeforeRelease).toBe(true);
        expect(independentResults[0]).toMatchObject({ status: 'ACTIVE', completed: 1 });
        expect(independentResults[1].status).toBe('COMPLETED');
        expect(
          await prisma.studyPlanItem.count({
            where: { planId: crossGroupPlan.id, groupIndex: 1, completedAt: null },
          }),
        ).toBe(0);
        expect(
          await prisma.studyPlan.findUniqueOrThrow({
            where: { id: crossGroupPlan.id },
            select: { status: true },
          }),
        ).toMatchObject({ status: 'COMPLETED' });
        expect(await attemptsFor(otherUserPlan.id)).toHaveLength(2);
      } finally {
        if (users.length) {
          await prisma.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
        }
        if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        if (words.length) {
          await prisma.vocabularyWord.deleteMany({
            where: { id: { in: words.map(({ id }) => id) }, bookWords: { none: {} } },
          });
        }
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
