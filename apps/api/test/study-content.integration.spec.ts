import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { StudyService } from '../src/modules/study/study.service';
import { lockUserWordProgress } from '../src/modules/study/user-word-progress-lock';

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
        type SerializedPlanWord = {
          id: string;
          source: 'NEW' | 'REVIEW';
          result?: boolean;
          selectedAnswer?: string[];
          nextReviewAt: Date | string | null;
          activeWeaknesses: Array<{
            questionType: string;
            wrongCount: number;
            consecutiveCorrect: number;
            remainingCorrect: number;
          }>;
          question: SerializedQuestion;
        };
        type SerializedPlan = {
          id: string;
          content: { groups: Array<{ questions: SerializedQuestion[] }> };
          words: SerializedPlanWord[];
        };

        const ownerPlans = (await service.listPlans(users[0].id)) as unknown as SerializedPlan[];
        const partialPlans = (await service.listPlans(users[1].id)) as unknown as SerializedPlan[];
        expect(ownerPlans.map((plan) => plan.id)).toContain(ownerPlan.id);
        expect(ownerPlans.map((plan) => plan.id)).not.toContain(partialPlan.id);
        const openOwnerPlan = ownerPlans.find((plan) => plan.id === ownerPlan.id)!;
        expect(openOwnerPlan.words[0].source).toBe('NEW');
        expect(openOwnerPlan.words[0].nextReviewAt).toBeNull();
        expect(openOwnerPlan.words[0].activeWeaknesses).toEqual([]);
        expect(partialPlans.map((plan) => plan.id)).toContain(partialPlan.id);
        const partialPlanSummary = partialPlans.find((plan) => plan.id === partialPlan.id)!;
        expect(partialPlanSummary.content!.groups[0].questions[0]).not.toHaveProperty(
          'correctAnswers',
        );
        expect(partialPlanSummary.words[0].question).not.toHaveProperty('correctAnswers');
        expect(partialPlanSummary.words[0]).not.toHaveProperty('selectedAnswer');
        expect(partialPlanSummary.words[0].nextReviewAt).toBeNull();
        expect(partialPlanSummary.words[0].activeWeaknesses).toEqual([]);
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

        let readyLockCalls = 0;
        let releaseLockCalls!: () => void;
        const bothLockCallsReady = new Promise<void>((resolve) => {
          releaseLockCalls = resolve;
        });
        const startLockRequest = (userId: string, ids: string[]) =>
          prisma.$transaction(async (tx) => {
            const gatedTx = new Proxy(tx, {
              get(target, property) {
                const value = Reflect.get(target, property, target);
                if (property !== '$queryRaw')
                  return typeof value === 'function' ? value.bind(target) : value;
                return async (...args: any[]) => {
                  readyLockCalls++;
                  if (readyLockCalls === 2) releaseLockCalls();
                  await bothLockCallsReady;
                  return value.apply(target, args);
                };
              },
            });
            await lockUserWordProgress(gatedTx as never, userId, ids);
          });
        const oppositeOrderLocks = await Promise.all([
          startLockRequest(users[0].id, [bookWords[0].id, bookWords[1].id]),
          startLockRequest(users[0].id, [bookWords[1].id, bookWords[0].id]),
        ]);
        expect(oppositeOrderLocks).toHaveLength(2);

        let firstUserRowsLocked!: () => void;
        let releaseFirstUserLocks!: () => void;
        const firstUserRowsLockedPromise = new Promise<void>((resolve) => {
          firstUserRowsLocked = resolve;
        });
        const firstUserLocksReleased = new Promise<void>((resolve) => {
          releaseFirstUserLocks = resolve;
        });
        const firstUserLockTransaction = prisma.$transaction(async (tx) => {
          await lockUserWordProgress(tx, users[0].id, [bookWords[0].id, bookWords[1].id]);
          firstUserRowsLocked();
          await firstUserLocksReleased;
        });
        await firstUserRowsLockedPromise;
        const otherUserLockTransaction = prisma.$transaction((tx) =>
          lockUserWordProgress(tx, users[1].id, [bookWords[1].id, bookWords[0].id]),
        );
        let otherUserLockTimeout: ReturnType<typeof setTimeout> | undefined;
        const otherUserLocksWhileHeld = await Promise.race([
          otherUserLockTransaction.then(() => true),
          new Promise<boolean>((resolve) => {
            otherUserLockTimeout = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
        if (otherUserLockTimeout) clearTimeout(otherUserLockTimeout);
        releaseFirstUserLocks();
        await Promise.all([firstUserLockTransaction, otherUserLockTransaction]);
        expect(otherUserLocksWhileHeld).toBe(true);

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
              nextReviewAt: true,
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

        const concurrentContent = {
          groups: [
            {
              index: 0,
              title: 'A bright idea',
              wordOccurrences: { bright: 1 },
              sentences: [],
              questions: [questions[0]],
            },
          ],
        };
        const createConcurrentPlan = () =>
          prisma.studyPlan.create({
            data: {
              userId: users[0].id,
              mode: 'GROUP',
              purpose: 'NORMAL',
              status: 'ACTIVE',
              generatedContent: concurrentContent,
              generatedAt: createdAt,
              items: {
                create: {
                  bookWordId: bookWords[0].id,
                  source: 'REVIEW',
                  groupIndex: 0,
                  question: questions[0],
                },
              },
            },
            select: { id: true },
          });
        const [concurrentWrongPlan, concurrentCorrectPlan] = await Promise.all([
          createConcurrentPlan(),
          createConcurrentPlan(),
        ]);
        const beforeSharedWordConcurrency = await prisma.userWordProgress.findUniqueOrThrow({
          where: { userId_bookWordId: { userId: users[0].id, bookWordId: bookWords[0].id } },
        });

        let firstProgressRead!: () => void;
        let firstProgressLock!: () => void;
        let releaseProgressReads!: () => void;
        let markWrongCommitted!: () => void;
        const firstProgressReadReached = new Promise<void>((resolve) => {
          firstProgressRead = resolve;
        });
        const firstProgressLockReached = new Promise<void>((resolve) => {
          firstProgressLock = resolve;
        });
        const bothProgressReadsReached = new Promise<void>((resolve) => {
          releaseProgressReads = resolve;
        });
        const wrongTransactionCommitted = new Promise<void>((resolve) => {
          markWrongCommitted = resolve;
        });
        let transactionCount = 0;
        let progressReadCount = 0;
        const concurrencyProbePrisma = new Proxy(prisma, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== '$transaction')
              return typeof value === 'function' ? value.bind(target) : value;
            return (callback: (...args: any[]) => unknown, ...options: any[]) => {
              const transactionIndex = ++transactionCount;
              const transaction = value.call(
                target,
                (tx: any) => {
                  let progressRowLocked = false;
                  const progressDelegate = new Proxy(tx.userWordProgress, {
                    get(delegate, method) {
                      const methodValue = Reflect.get(delegate, method, delegate);
                      if (method === 'findUniqueOrThrow')
                        return async (...args: any[]) => {
                          const row = await methodValue.apply(delegate, args);
                          if (!progressRowLocked) {
                            progressReadCount++;
                            if (transactionIndex === 1) firstProgressRead();
                            if (progressReadCount === 2) releaseProgressReads();
                            await bothProgressReadsReached;
                          }
                          return row;
                        };
                      if (method === 'update' && transactionIndex === 2)
                        return async (...args: any[]) => {
                          await wrongTransactionCommitted;
                          return methodValue.apply(delegate, args);
                        };
                      return typeof methodValue === 'function'
                        ? methodValue.bind(delegate)
                        : methodValue;
                    },
                  });
                  const transactionClient = new Proxy(tx, {
                    get(transactionTarget, method) {
                      if (method === 'userWordProgress') return progressDelegate;
                      const methodValue = Reflect.get(transactionTarget, method, transactionTarget);
                      if (method === '$queryRaw')
                        return async (...args: any[]) => {
                          const rows = await methodValue.apply(transactionTarget, args);
                          progressRowLocked = true;
                          if (transactionIndex === 1) firstProgressLock();
                          return rows;
                        };
                      return typeof methodValue === 'function'
                        ? methodValue.bind(transactionTarget)
                        : methodValue;
                    },
                  });
                  return callback(transactionClient);
                },
                ...options,
              );
              if (transactionIndex === 1)
                return transaction.then((result: unknown) => {
                  markWrongCommitted();
                  return result;
                });
              return transaction;
            };
          },
        });
        const progressSerializationService = new StudyService(
          concurrencyProbePrisma as never,
          {} as never,
          {} as never,
          { recordAttempt: async () => undefined } as never,
        );
        const sharedProgressStartedAt = performance.now();
        const wrongSubmission = progressSerializationService.completeGroup(
          users[0].id,
          concurrentWrongPlan.id,
          0,
          [{ bookWordId: bookWords[0].id, selectedAnswer: ['暗的'] }],
        );
        let firstProgressGateTimeout: ReturnType<typeof setTimeout> | undefined;
        const firstProgressGate = await Promise.race([
          firstProgressLockReached.then(() => 'locked' as const),
          firstProgressReadReached.then(() => 'read' as const),
          new Promise<'timeout'>((resolve) => {
            firstProgressGateTimeout = setTimeout(() => resolve('timeout'), 5_000);
          }),
        ]);
        if (firstProgressGateTimeout) clearTimeout(firstProgressGateTimeout);
        const correctSubmission = progressSerializationService.completeGroup(
          users[0].id,
          concurrentCorrectPlan.id,
          0,
          [{ bookWordId: bookWords[0].id, selectedAnswer: ['明亮的'] }],
        );
        const [wrongResult, correctResult] = await Promise.all([
          wrongSubmission,
          correctSubmission,
        ]);
        const sharedProgressElapsedMs = performance.now() - sharedProgressStartedAt;
        console.info(
          `same learner-word concurrent submissions: 2 serialized in ${sharedProgressElapsedMs.toFixed(1)} ms`,
        );
        expect(firstProgressGate).not.toBe('timeout');
        expect(sharedProgressElapsedMs).toBeLessThan(5_000);
        expect([wrongResult.status, correctResult.status]).toEqual(['COMPLETED', 'COMPLETED']);
        expect(await attemptsFor(concurrentWrongPlan.id)).toHaveLength(1);
        expect(await attemptsFor(concurrentCorrectPlan.id)).toHaveLength(1);
        const serializedProgress = await prisma.userWordProgress.findUniqueOrThrow({
          where: { userId_bookWordId: { userId: users[0].id, bookWordId: bookWords[0].id } },
        });
        expect(serializedProgress.totalAttempts).toBe(
          beforeSharedWordConcurrency.totalAttempts + 2,
        );
        expect(serializedProgress.correctAttempts).toBe(
          beforeSharedWordConcurrency.correctAttempts + 1,
        );
        expect(serializedProgress.reviewCount).toBe(beforeSharedWordConcurrency.reviewCount + 2);
        expect(serializedProgress.consecutiveCorrect).toBe(1);
        expect(serializedProgress.lastIntervalDays).toBe(1);
        expect(
          serializedProgress.nextReviewAt!.getTime() - serializedProgress.lastReviewedAt!.getTime(),
        ).toBe(86_400_000);

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
        const ownerRecap = identicalSubmissions[0] as unknown as SerializedPlan;
        const brightRecap = ownerRecap.words.find((word) => word.id === bookWords[0].id)!;
        const brightProgress = await prisma.userWordProgress.findUniqueOrThrow({
          where: { userId_bookWordId: { userId: users[0].id, bookWordId: bookWords[0].id } },
          select: { nextReviewAt: true },
        });
        expect(brightRecap.result).toBe(true);
        expect(brightRecap.nextReviewAt).not.toBeNull();
        expect(new Date(brightRecap.nextReviewAt!).toISOString()).toBe(
          brightProgress.nextReviewAt!.toISOString(),
        );
        expect(brightRecap.activeWeaknesses).toEqual([
          {
            questionType: 'MEANING_RECOGNITION',
            wrongCount: 1,
            consecutiveCorrect: 1,
            remainingCorrect: 1,
          },
        ]);
        const firstProgress = await progressFor(users[0].id);
        expect(firstProgress).toHaveLength(2);
        expect(
          firstProgress.every((row) => {
            const sharedWord = row.bookWordId === bookWords[0].id;
            return (
              row.totalAttempts === (sharedWord ? 3 : 1) &&
              row.correctAttempts === (sharedWord ? 2 : 1) &&
              row.consecutiveCorrect === (sharedWord ? 2 : 1) &&
              row.reviewCount === (sharedWord ? 3 : 1)
            );
          }),
        ).toBe(true);
        const weakness = await prisma.weaknessSignal.findFirstOrThrow({
          where: { userId: users[0].id, bookWordId: bookWords[0].id },
        });
        expect(weakness).toMatchObject({ status: 'ACTIVE', consecutiveCorrect: 1, wrongCount: 1 });

        const mistakesService = new MistakesService(prisma as never);
        const readState = async () => ({
          attempts: await prisma.wordReviewAttempt.count({
            where: { userId: users[0].id, item: { planId: ownerPlan.id } },
          }),
          progress: await prisma.userWordProgress.findMany({
            where: { userId: users[0].id },
            orderBy: { bookWordId: 'asc' },
            select: {
              bookWordId: true,
              nextReviewAt: true,
              totalAttempts: true,
              correctAttempts: true,
              consecutiveCorrect: true,
            },
          }),
          weaknesses: await prisma.weaknessSignal.findMany({
            where: { userId: users[0].id },
            orderBy: [{ bookWordId: 'asc' }, { questionType: 'asc' }],
            select: {
              bookWordId: true,
              questionType: true,
              status: true,
              wrongCount: true,
              consecutiveCorrect: true,
            },
          }),
        });
        const beforeSummaryReads = await readState();
        const [summaryReads, wrongBookReads] = await Promise.all([
          Promise.all([
            serviceWithMistakes.listPlans(users[0].id),
            serviceWithMistakes.listPlans(users[0].id),
          ]),
          Promise.all([
            mistakesService.list(users[0].id, {}),
            mistakesService.list(users[1].id, {}),
          ]),
        ]);
        expect(summaryReads[0].map((plan) => plan.id)).toContain(ownerPlan.id);
        expect(summaryReads[1].map((plan) => plan.id)).toContain(ownerPlan.id);
        expect(wrongBookReads[0].items.map((item) => item.bookWordId)).toContain(bookWords[0].id);
        expect(wrongBookReads[1].total).toBe(0);
        expect(await readState()).toEqual(beforeSummaryReads);

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
          afterCompetingAnswers.every((row) => {
            const sharedWord = row.bookWordId === bookWords[0].id;
            const previousCorrect = sharedWord ? 2 : 1;
            const previousStreak = sharedWord ? 2 : 1;
            const previousAttempts = sharedWord ? 3 : 1;
            const previousReviews = sharedWord ? 3 : 1;
            return (
              row.totalAttempts === previousAttempts + 1 &&
              row.reviewCount === previousReviews + 1 &&
              row.correctAttempts === previousCorrect + (allCorrectWon ? 1 : 0) &&
              row.consecutiveCorrect === (allCorrectWon ? previousStreak + 1 : 0)
            );
          }),
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
          independentResults[1].words.find((word) => word.id === bookWords[0].id)?.activeWeaknesses,
        ).toEqual([]);
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

        const reviewPlan = await createPlan(users[0].id, 'ACTIVE', []);
        await serviceWithMistakes.completeGroup(users[0].id, reviewPlan.id, 0, answersFor(false));
        const attemptsBeforeReview = await attemptsFor(reviewPlan.id);
        const progressBeforeReview = await progressFor(users[0].id);
        const summaryStateBeforeReview = await readState();
        const [review, repeatedReview] = await Promise.all([
          serviceWithMistakes.getCompletedPlanReview(users[0].id, reviewPlan.id),
          serviceWithMistakes.getCompletedPlanReview(users[0].id, reviewPlan.id),
        ]);
        const reviewWords = review.words as unknown as SerializedPlanWord[];
        const repeatedReviewWords = repeatedReview.words as unknown as SerializedPlanWord[];
        expect(
          reviewWords.map(({ id, result, selectedAnswer, question }) => ({
            id,
            result,
            selectedAnswer,
            correctAnswers: question.correctAnswers,
            explanation: question.explanation,
          })),
        ).toEqual([
          {
            id: bookWords[0].id,
            result: false,
            selectedAnswer: ['暗的'],
            correctAnswers: ['明亮的'],
            explanation: 'bright 描述光线充足或颜色鲜明。',
          },
          {
            id: bookWords[1].id,
            result: false,
            selectedAnswer: ['拒绝'],
            correctAnswers: ['帮助'],
            explanation: 'help 表示提供帮助。',
          },
        ]);
        expect(repeatedReviewWords.map(({ selectedAnswer }) => selectedAnswer)).toEqual(
          reviewWords.map(({ selectedAnswer }) => selectedAnswer),
        );
        const defaultPlanRead = (await serviceWithMistakes.listPlans(
          users[0].id,
        )) as unknown as SerializedPlan[];
        expect(
          defaultPlanRead.find((plan) => plan.id === reviewPlan.id)!.words[0],
        ).not.toHaveProperty('selectedAnswer');
        await expect(
          serviceWithMistakes.getCompletedPlanReview(users[1].id, reviewPlan.id),
        ).rejects.toThrow('已完成学习记录不存在');
        await expect(
          serviceWithMistakes.getCompletedPlanReview(users[1].id, partialPlan.id),
        ).rejects.toThrow('已完成学习记录不存在');
        expect(await attemptsFor(reviewPlan.id)).toEqual(attemptsBeforeReview);
        expect(await progressFor(users[0].id)).toEqual(progressBeforeReview);
        expect(await readState()).toEqual(summaryStateBeforeReview);

        const lapsePlan = await createPlan(users[1].id, 'ACTIVE', []);
        const matureReviewAt = new Date(Date.now() - 180 * 86_400_000);
        await prisma.userWordProgress.updateMany({
          where: { userId: users[1].id, bookWordId: { in: bookWords.map((word) => word.id) } },
          data: {
            state: 'REVIEWING',
            reviewCount: 6,
            totalAttempts: 6,
            correctAttempts: 6,
            consecutiveCorrect: 6,
            lastIntervalDays: 180,
            lastReviewedAt: matureReviewAt,
            nextReviewAt: new Date(matureReviewAt.getTime() + 180 * 86_400_000),
          },
        });
        const lapseResult = await serviceWithMistakes.completeGroup(
          users[1].id,
          lapsePlan.id,
          0,
          answersFor(false),
        );
        expect(lapseResult.words.map((word) => word.result)).toEqual([false, false]);
        const lapseProgress = await prisma.userWordProgress.findMany({
          where: { userId: users[1].id, bookWordId: { in: bookWords.map((word) => word.id) } },
          orderBy: { bookWordId: 'asc' },
          select: {
            bookWordId: true,
            totalAttempts: true,
            correctAttempts: true,
            consecutiveCorrect: true,
            reviewCount: true,
            lastIntervalDays: true,
            lastReviewedAt: true,
            nextReviewAt: true,
          },
        });
        expect(
          lapseProgress.every(
            (progress) =>
              progress.totalAttempts === 7 &&
              progress.correctAttempts === 6 &&
              progress.consecutiveCorrect === 0 &&
              progress.reviewCount === 7 &&
              progress.lastIntervalDays === 1 &&
              progress.lastReviewedAt &&
              progress.nextReviewAt &&
              progress.nextReviewAt.getTime() - progress.lastReviewedAt.getTime() === 86_400_000,
          ),
        ).toBe(true);
        const lapseAttempts = await attemptsFor(lapsePlan.id);
        expect(lapseAttempts).toHaveLength(2);
        expect(lapseAttempts.every((attempt) => !attempt.isCorrect)).toBe(true);
        const lapseWeaknesses = await prisma.weaknessSignal.findMany({
          where: { userId: users[1].id },
          orderBy: [{ bookWordId: 'asc' }, { questionType: 'asc' }],
          select: {
            bookWordId: true,
            questionType: true,
            status: true,
            wrongCount: true,
            consecutiveCorrect: true,
          },
        });

        const lateCorrectedAnswer = await serviceWithMistakes.completeGroup(
          users[1].id,
          lapsePlan.id,
          0,
          answersFor(true),
        );
        expect(lateCorrectedAnswer.words.map((word) => word.result)).toEqual([false, false]);
        expect(await attemptsFor(lapsePlan.id)).toEqual(lapseAttempts);
        expect(
          await prisma.userWordProgress.findMany({
            where: { userId: users[1].id, bookWordId: { in: bookWords.map((word) => word.id) } },
            orderBy: { bookWordId: 'asc' },
            select: {
              bookWordId: true,
              totalAttempts: true,
              correctAttempts: true,
              consecutiveCorrect: true,
              reviewCount: true,
              lastIntervalDays: true,
              lastReviewedAt: true,
              nextReviewAt: true,
            },
          }),
        ).toEqual(lapseProgress);
        expect(
          await prisma.weaknessSignal.findMany({
            where: { userId: users[1].id },
            orderBy: [{ bookWordId: 'asc' }, { questionType: 'asc' }],
            select: {
              bookWordId: true,
              questionType: true,
              status: true,
              wrongCount: true,
              consecutiveCorrect: true,
            },
          }),
        ).toEqual(lapseWeaknesses);
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
