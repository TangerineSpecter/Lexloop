import { PrismaClient, StudyPlanPurpose, StudyPlanStatus, WeaknessStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'weakness practice-plan selection in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('keeps concurrent selections distinct, reuses identical requests, and scopes plans by user', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const serviceClients = [
        new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
        new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
      ];
      clients.push(admin, ...serviceClients);

      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const createdPlans: string[] = [];
      try {
        const createLearner = async (suffix: string, words: string[]) => {
          const user = await admin.user.create({
            data: {
              email: `mistake-plan-${fixtureId}-${suffix}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
            },
            select: { id: true },
          });
          userIds.push(user.id);

          const book = await admin.vocabularyBook.create({
            data: {
              ownerId: user.id,
              kind: 'PERSONAL',
              sourceKey: `mistake-plan-${fixtureId}-${suffix}`,
              title: 'Mistake plan selection test',
              sourcePath: 'test',
              category: 'GENERAL',
              bookWords: {
                create: words.map((text, position) => ({
                  position,
                  word: {
                    create: {
                      normalized: `${fixtureId}-${suffix}-${text}`,
                      text,
                      meaning: '隔离测试词',
                    },
                  },
                })),
              },
            },
            select: { bookWords: { select: { id: true } } },
          });
          const bookWordIds = book.bookWords.map((item) => item.id);
          const now = new Date();
          await admin.weaknessSignal.createMany({
            data: bookWordIds.map((bookWordId) => ({
              userId: user.id,
              bookWordId,
              questionType: 'MEANING_RECOGNITION',
              status: WeaknessStatus.ACTIVE,
              wrongCount: 2,
              lastWrongAt: now,
              lastAttemptAt: now,
            })),
          });
          return { id: user.id, bookWordIds };
        };

        const firstLearner = await createLearner('one', ['steady', 'rescue']);
        const secondLearner = await createLearner(
          'two',
          Array.from({ length: 20 }, (_, index) => `curious-${index}`),
        );
        const services = serviceClients.map((client) => new MistakesService(client as never));

        const outcomes = await Promise.allSettled([
          services[0].createPracticePlan(firstLearner.id, [firstLearner.bookWordIds[0]]),
          services[1].createPracticePlan(firstLearner.id, [firstLearner.bookWordIds[1]]),
          services[0].createPracticePlan(secondLearner.id, secondLearner.bookWordIds),
          services[1].createPracticePlan(secondLearner.id, secondLearner.bookWordIds),
        ]);

        const firstLearnerSuccesses = outcomes
          .slice(0, 2)
          .filter((outcome) => outcome.status === 'fulfilled');
        const firstLearnerFailures = outcomes
          .slice(0, 2)
          .filter((outcome) => outcome.status === 'rejected');
        expect(firstLearnerSuccesses).toHaveLength(1);
        expect(firstLearnerFailures).toHaveLength(1);
        if (firstLearnerFailures[0].status !== 'rejected') throw new Error('expected conflict');
        expect(firstLearnerFailures[0].reason.message).toContain('本次选择未应用');

        const secondLearnerPlans = outcomes.slice(2).map((outcome) => {
          if (outcome.status !== 'fulfilled') throw outcome.reason;
          return outcome.value;
        });
        expect(secondLearnerPlans[0].id).toBe(secondLearnerPlans[1].id);
        expect(secondLearnerPlans[0].wordCount).toBe(20);
        const duplicateStartedAt = performance.now();
        const secondLearnerDuplicateRequests = await Promise.all([
          services[0].createPracticePlan(secondLearner.id, secondLearner.bookWordIds),
          services[1].createPracticePlan(secondLearner.id, secondLearner.bookWordIds),
        ]);
        const duplicateElapsedMs = performance.now() - duplicateStartedAt;
        expect(secondLearnerDuplicateRequests.map((plan) => plan.id)).toEqual([
          secondLearnerPlans[0].id,
          secondLearnerPlans[0].id,
        ]);
        console.log(
          `weakness plan duplicate selection: 20 words / 2 concurrent requests in ${duplicateElapsedMs.toFixed(1)} ms`,
        );

        if (firstLearnerSuccesses[0].status !== 'fulfilled') throw new Error('expected plan');
        const firstPlan = firstLearnerSuccesses[0].value;
        createdPlans.push(firstPlan.id, secondLearnerPlans[0].id);
        expect(firstPlan.id).not.toBe(secondLearnerPlans[0].id);
        expect(
          await admin.studyPlan.findUnique({
            where: { id: firstPlan.id },
            select: { userId: true },
          }),
        ).toEqual({ userId: firstLearner.id });
        expect(
          await admin.studyPlan.findUnique({
            where: { id: secondLearnerPlans[0].id },
            select: { userId: true },
          }),
        ).toEqual({ userId: secondLearner.id });
        const firstPlanItems = await admin.studyPlanItem.findMany({
          where: { planId: firstPlan.id },
          select: { bookWordId: true },
        });
        expect(firstPlanItems).toHaveLength(1);
        const winningWordId = firstPlanItems[0].bookWordId;
        const unselectedWordId = firstLearner.bookWordIds.find((id) => id !== winningWordId)!;
        const duplicateRequests = await Promise.all([
          services[0].createPracticePlan(firstLearner.id, [winningWordId]),
          services[1].createPracticePlan(firstLearner.id, [winningWordId]),
        ]);
        expect(duplicateRequests.map((plan) => plan.id)).toEqual([firstPlan.id, firstPlan.id]);

        await expect(
          services[1].createPracticePlan(firstLearner.id, [unselectedWordId]),
        ).rejects.toThrow('本次选择未应用');
        expect(
          await admin.studyPlan.count({
            where: { userId: firstLearner.id, purpose: StudyPlanPurpose.WEAKNESS },
          }),
        ).toBe(1);
        expect(
          await admin.weaknessSignal.count({
            where: {
              userId: firstLearner.id,
              bookWordId: unselectedWordId,
              status: WeaknessStatus.ACTIVE,
              consecutiveCorrect: 0,
            },
          }),
        ).toBe(1);
        expect(await admin.wordReviewAttempt.count({ where: { userId: firstLearner.id } })).toBe(0);
        expect(await admin.userWordProgress.count({ where: { userId: firstLearner.id } })).toBe(0);

        await admin.studyPlan.update({
          where: { id: firstPlan.id },
          data: { status: StudyPlanStatus.COMPLETED, completedAt: new Date() },
        });
        const nextPlan = await services[1].createPracticePlan(firstLearner.id, [unselectedWordId]);
        createdPlans.push(nextPlan.id);
        expect(nextPlan.id).not.toBe(firstPlan.id);
        expect(
          await admin.studyPlanItem.findMany({
            where: { planId: nextPlan.id },
            select: { bookWordId: true },
          }),
        ).toEqual([{ bookWordId: unselectedWordId }]);
      } finally {
        if (createdPlans.length)
          await admin.studyPlan.deleteMany({ where: { id: { in: createdPlans } } });
        if (userIds.length) await admin.user.deleteMany({ where: { id: { in: userIds } } });
      }
    });
  },
);
