import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('progressive invalid-answer recovery', () => {
  it('preserves evidence, refuses bad grading, creates one remaining plan and recovers without extra SRS writes', async () => {
    const priorFlag = process.env.ENABLE_PROGRESSIVE_PLAN_RECOVERY;
    process.env.ENABLE_PROGRESSIVE_PLAN_RECOVERY = 'true';
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const suffix = randomUUID();
    let userId = '';
    let bookId = '';
    const wordIds: string[] = [];
    const question = (id: string, bad = false) => ({
      bookWordId: id,
      type: 'MEANING_RECOGNITION',
      prompt: 'What does repair mean here?',
      options: ['修理', '购买', '出售', '丢弃'],
      correctAnswers: bad ? ['修理', '购买'] : ['修理'],
      explanation: '原来坏了，修理后又能工作。',
    });
    const ai = {
      generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
        const input = JSON.parse(prompt.match(/^输入分组：(.*)$/m)![1]);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: input.map((group: { index: number; words: Array<{ id: string }> }) => ({
                    index: group.index,
                    title: 'The radio',
                    wordOccurrences: { repair: 1 },
                    sentences: [
                      {
                        english: 'They repair the broken radio today.',
                        chinese: '他们今天修理坏掉的收音机。',
                        simplified: '他们今天 repair 收音机。',
                        grammar: 'repair 为谓语。',
                      },
                      {
                        english: 'Now it works again.',
                        chinese: '现在它又能用了。',
                        simplified: '现在它又能用了。',
                        grammar: 'again 表示再次。',
                      },
                    ],
                    questions: [question(group.words[0].id)],
                  })),
                }),
              },
            },
          ],
        };
      }),
    };
    const service = new StudyService(
      prisma as never,
      ai as never,
      { selectedProvider: vi.fn(async () => ({ id: 'offline-fixture' })) } as never,
      new MistakesService(prisma as never),
    );
    try {
      userId = (
        await prisma.user.create({
          data: {
            email: `answer-recovery-${suffix}@example.invalid`,
            passwordHash: 'fixture-only',
          },
        })
      ).id;
      await prisma.progressivePracticeProgress.create({
        data: { userId, trackVersion: 1, highestUnlockedStage: 'FOUNDATION' },
      });
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: userId,
          kind: 'PERSONAL',
          sourceKey: suffix,
          sourcePath: 'fixture',
          title: 'Recovery fixture',
          category: 'GENERAL',
        },
      });
      bookId = book.id;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const word = await prisma.vocabularyWord.create({
          data: { normalized: `${suffix}-${i}`, text: 'repair', meaning: '修理' },
        });
        wordIds.push(word.id);
        const bw = await prisma.vocabularyBookWord.create({
          data: { bookId, wordId: word.id, position: i },
        });
        ids.push(bw.id);
        await prisma.userWordProgress.create({
          data: { userId, bookWordId: bw.id, state: 'LEARNING' },
        });
      }
      const makePlan = async (version = 1) =>
        prisma.studyPlan.create({
          data: {
            userId,
            mode: 'INDIVIDUAL',
            purpose: 'PROGRESSIVE',
            progressiveStage: 'FOUNDATION',
            progressiveVersion: version,
            status: 'ACTIVE',
            generatedContent: {
              groups: ids.map((id, index) => ({ index, questions: [question(id, index === 1)] })),
            },
            items: {
              create: ids.map((bookWordId, groupIndex) => ({
                bookWordId,
                groupIndex,
                source: 'NEW',
                targetQuestionType: 'MEANING_RECOGNITION',
                question: question(bookWordId, groupIndex === 1),
              })),
            },
          },
        });
      const old = await makePlan();
      await service.completeGroup(userId, old.id, 0, [
        { bookWordId: ids[0], selectedAnswer: ['修理'] },
      ]);
      const snapshot = async () => ({
        progress: await prisma.userWordProgress.findMany({
          where: { userId },
          orderBy: { bookWordId: 'asc' },
        }),
        attempts: await prisma.wordReviewAttempt.findMany({
          where: { userId },
          orderBy: { id: 'asc' },
        }),
        weaknesses: await prisma.weaknessSignal.findMany({ where: { userId } }),
        path: await prisma.progressivePracticeProgress.findMany({ where: { userId } }),
      });
      const before = await snapshot();
      await expect(
        service.completeGroup(userId, old.id, 1, [
          { bookWordId: ids[1], selectedAnswer: ['修理'] },
        ]),
      ).rejects.toThrow('参考答案结构无效');
      expect(await snapshot()).toEqual(before);
      expect(
        (await prisma.studyPlanItem.findFirstOrThrow({ where: { planId: old.id, groupIndex: 1 } }))
          .completedAt,
      ).toBeNull();
      expect((await service.getPlan(userId, old.id)).answerKeyRecoveryAvailable).toBe(true);
      await expect(
        service.replaceInvalidProgressivePlan('different-account', old.id),
      ).rejects.toThrow('学习计划不存在');
      const [replacement, duplicate] = await Promise.all([
        service.replaceInvalidProgressivePlan(userId, old.id),
        service.replaceInvalidProgressivePlan(userId, old.id),
      ]);
      expect(replacement.id).toBe(duplicate.id);
      expect(replacement.replacedPlanId).toBe(old.id);
      expect(replacement.words.map((w) => w.id)).toEqual(ids.slice(1));
      expect(replacement.words.map((w) => w.groupIndex)).toEqual([0, 1]);
      expect(await snapshot()).toEqual(before);
      expect((await service.getProgressivePath(userId)).highestUnlockedStage).toBe('foundation');
      const review = await service.getCompletedPlanReview(userId, old.id);
      expect(review.status).toBe('INVALIDATED');
      expect((review.words[0] as { selectedAnswer?: string[] }).selectedAnswer).toEqual(['修理']);
      expect(review.words[1].question).not.toHaveProperty('correctAnswers');
      await expect(service.getCompletedPlanReview('different-account', old.id)).rejects.toThrow();
      // A post-invalidation submission cannot add an attempt or unlock a stage.
      await expect(
        service.completeGroup(userId, old.id, 2, [
          { bookWordId: ids[2], selectedAnswer: ['修理'] },
        ]),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      ai.generateForUser.mockRejectedValueOnce(new Error('offline injected generation failure'));
      await expect(service.generatePlan(userId, replacement.id)).rejects.toThrow(
        '学习计划生成失败',
      );
      expect((await service.replaceInvalidProgressivePlan(userId, old.id)).id).toBe(replacement.id);
      expect((await service.getPlan(userId, replacement.id)).status).toBe('FAILED');
      await service.generatePlan(userId, replacement.id);
      expect((await service.getPlan(userId, replacement.id)).status).toBe('ACTIVE');
      for (const [groupIndex, bookWordId] of ids.slice(1).entries())
        await service.completeGroup(userId, replacement.id, groupIndex, [
          { bookWordId, selectedAnswer: ['修理'] },
        ]);
      expect(await prisma.wordReviewAttempt.count({ where: { userId } })).toBe(3);
      expect((await service.getProgressivePath(userId)).highestUnlockedStage).toBe('context');
      expect((await service.getCompletedPlanReview(userId, replacement.id)).replacedPlanId).toBe(
        old.id,
      );
      // Transaction rollback must remove the newly created replacement as well.
      const rollbackPlan = await makePlan();
      const stateBeforeFailure = await snapshot();
      const countBeforeFailure = await prisma.studyPlan.count({ where: { userId } });
      const faultyPrisma = new Proxy(prisma, {
        get(target, key) {
          if (key === '$transaction')
            return (callback: (tx: unknown) => unknown) =>
              prisma.$transaction(async (tx) =>
                callback(
                  new Proxy(tx, {
                    get(inner, method) {
                      if (method === 'studyPlan')
                        return new Proxy(tx.studyPlan, {
                          get(delegate, operation) {
                            if (operation === 'update')
                              return async () => {
                                throw new Error('injected transaction failure');
                              };
                            const value = Reflect.get(delegate, operation);
                            return typeof value === 'function' ? value.bind(delegate) : value;
                          },
                        });
                      const value = Reflect.get(inner, method);
                      return typeof value === 'function' ? value.bind(inner) : value;
                    },
                  }),
                ),
              );
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const faultyService = new StudyService(
        faultyPrisma as never,
        ai as never,
        {} as never,
        new MistakesService(prisma as never),
      );
      await expect(
        faultyService.replaceInvalidProgressivePlan(userId, rollbackPlan.id),
      ).rejects.toThrow('injected transaction failure');
      expect(await prisma.studyPlan.count({ where: { userId } })).toBe(countBeforeFailure);
      expect(await snapshot()).toEqual(stateBeforeFailure);
      expect(
        await prisma.studyPlan.findUniqueOrThrow({ where: { id: rollbackPlan.id } }),
      ).toMatchObject({ status: 'ACTIVE', replacementPlanId: null });

      // Pause the winning transaction after its real plan row lock, then issue
      // the competing transaction before releasing that barrier.
      const lockedService = () => {
        let signal!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
          signal = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let paused = false;
        const client = new Proxy(prisma, {
          get(target, key) {
            if (key === '$transaction')
              return (callback: (tx: unknown) => unknown) =>
                prisma.$transaction(async (tx) =>
                  callback(
                    new Proxy(tx, {
                      get(inner, method) {
                        if (method === '$queryRaw')
                          return async (...args: unknown[]) => {
                            const result = await (
                              tx.$queryRaw as (...values: unknown[]) => Promise<unknown>
                            )(...args);
                            if (
                              !paused &&
                              String((args[0] as { sql?: string }).sql ?? '').includes(
                                'FROM "StudyPlan"',
                              )
                            ) {
                              paused = true;
                              signal();
                              await gate;
                            }
                            return result;
                          };
                        const value = Reflect.get(inner, method);
                        return typeof value === 'function' ? value.bind(inner) : value;
                      },
                    }),
                  ),
                );
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return {
          service: new StudyService(
            client as never,
            ai as never,
            {} as never,
            new MistakesService(prisma as never),
          ),
          ready,
          release,
        };
      };
      const raceOne = await makePlan();
      const submitWinner = lockedService();
      const submitting = submitWinner.service.completeGroup(userId, raceOne.id, 0, [
        { bookWordId: ids[0], selectedAnswer: ['修理'] },
      ]);
      await submitWinner.ready;
      const replacingAfterSubmit = service.replaceInvalidProgressivePlan(userId, raceOne.id);
      submitWinner.release();
      await submitting;
      const afterSubmitReplacement = await replacingAfterSubmit;
      expect(afterSubmitReplacement.words.map((w) => w.id)).toEqual(ids.slice(1));
      expect(
        await prisma.wordReviewAttempt.count({ where: { item: { planId: raceOne.id } } }),
      ).toBe(1);
      const raceTwo = await makePlan();
      const beforeReplacementRace = await snapshot();
      const replacementWinner = lockedService();
      const replacing = replacementWinner.service.replaceInvalidProgressivePlan(userId, raceTwo.id);
      await replacementWinner.ready;
      const staleSubmission = service.completeGroup(userId, raceTwo.id, 0, [
        { bookWordId: ids[0], selectedAnswer: ['修理'] },
      ]);
      replacementWinner.release();
      await replacing;
      // It may read INVALIDATED before its preflight, or discover it under the lock.
      await staleSubmission.catch((error) => {
        expect(error.message).toContain('学习分组不存在');
      });
      expect(await snapshot()).toEqual(beforeReplacementRace);
      expect(
        await prisma.wordReviewAttempt.count({ where: { item: { planId: raceTwo.id } } }),
      ).toBe(0);
      expect((await prisma.studyPlan.findUniqueOrThrow({ where: { id: raceTwo.id } })).status).toBe(
        'INVALIDATED',
      );

      const legacy = await makePlan(0);
      expect((await service.getPlan(userId, legacy.id)).answerKeyRecoveryAvailable).toBe(false);
      await expect(service.replaceInvalidProgressivePlan(userId, legacy.id)).rejects.toThrow(
        '当前版本',
      );
      await service.completeGroup(userId, legacy.id, 1, [
        { bookWordId: ids[1], selectedAnswer: ['修理'] },
      ]);
      expect(await prisma.wordReviewAttempt.count({ where: { item: { planId: legacy.id } } })).toBe(
        1,
      );
      // The rollout gate blocks creation but does not hide saved read-only evidence.
      process.env.ENABLE_PROGRESSIVE_PLAN_RECOVERY = 'false';
      await expect(service.replaceInvalidProgressivePlan(userId, old.id)).rejects.toThrow(
        '尚未启用',
      );
      expect((await service.getCompletedPlanReview(userId, old.id)).status).toBe('INVALIDATED');
    } finally {
      if (userId) await prisma.user.delete({ where: { id: userId } });
      if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
      await prisma.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
      await prisma.$disconnect();
      if (priorFlag === undefined) delete process.env.ENABLE_PROGRESSIVE_PLAN_RECOVERY;
      else process.env.ENABLE_PROGRESSIVE_PLAN_RECOVERY = priorFlag;
    }
  });
});
