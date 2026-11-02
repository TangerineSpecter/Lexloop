import { PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { StudyService } from '../src/modules/study/study.service';
import { AutomaticStudyPlanWorkerService } from '../src/modules/automatic-study-plan/automatic-study-plan.worker-service';

const NOW = new Date('2026-11-02T00:00:00.000Z'); // 08:00 in Asia/Shanghai.

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'automatic study plans in an isolated database',
  () => {
    async function createUser(prisma: PrismaClient, suffix: string) {
      return prisma.user.create({
        data: {
          email: `auto-study-${suffix}-${randomUUID()}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
    }

    async function createRun(prisma: PrismaClient, userId: string, dateKey = '2026-11-02') {
      return prisma.automaticStudyPlanRun.create({ data: { userId, dateKey } });
    }

    it('sweeps only after the configured Beijing time and deduplicates one run per user and date', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await createUser(prisma, 'sweep');
      const settings = {
        getConfig: vi.fn().mockResolvedValue({ enabled: true, scheduleTime: '06:30' }),
      };
      const service = new AutomaticStudyPlanWorkerService(
        prisma as never,
        settings as never,
        {} as never,
        {} as never,
      );
      const queue = { add: vi.fn().mockResolvedValue(undefined) };

      try {
        await expect(
          service.sweep(queue as never, new Date('2026-11-01T22:29:59.000Z')),
        ).resolves.toMatchObject({
          queued: 0,
          dateKey: '2026-11-02',
        });
        expect(await prisma.automaticStudyPlanRun.count({ where: { userId: user.id } })).toBe(0);

        await service.sweep(queue as never, new Date('2026-11-01T22:30:00.000Z'));
        await service.sweep(queue as never, new Date('2026-11-01T22:31:00.000Z'));
        expect(await prisma.automaticStudyPlanRun.count({ where: { userId: user.id } })).toBe(1);
        expect(queue.add).toHaveBeenCalledWith(
          'generate',
          { userId: user.id, dateKey: '2026-11-02' },
          expect.objectContaining({ jobId: `2026-11-02-${user.id}`, attempts: 1 }),
        );
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('skips a missing model or unfinished manual plan without creating an automatic plan', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const noModelUser = await createUser(prisma, 'no-model');
      const busyUser = await createUser(prisma, 'busy');
      const failedUser = await createUser(prisma, 'previous-failure');
      await createRun(prisma, noModelUser.id);
      await createRun(prisma, busyUser.id);
      await createRun(prisma, failedUser.id);
      const busyPlan = await prisma.studyPlan.create({
        data: {
          userId: busyUser.id,
          mode: StudyPlanMode.GROUP,
          purpose: StudyPlanPurpose.NORMAL,
          status: 'ACTIVE',
          generatedContent: { groups: [] },
        },
      });
      const previousFailedAutoPlan = await prisma.studyPlan.create({
        data: {
          userId: failedUser.id,
          mode: StudyPlanMode.GROUP,
          purpose: StudyPlanPurpose.NORMAL,
          status: 'FAILED',
          autoDateKey: '2026-11-01',
        },
        select: { id: true },
      });
      await prisma.automaticStudyPlanRun.create({
        data: {
          userId: failedUser.id,
          dateKey: '2026-11-01',
          status: 'FAILED',
          attempts: 1,
          planId: previousFailedAutoPlan.id,
        },
      });
      const settings = {
        getConfig: vi.fn().mockResolvedValue({ enabled: true, scheduleTime: '06:30' }),
      };
      const models = { selectedProvider: vi.fn(async () => null) };
      const study = { createPlan: vi.fn(), generatePlan: vi.fn() };
      const service = new AutomaticStudyPlanWorkerService(
        prisma as never,
        settings as never,
        models as never,
        study as never,
      );

      try {
        await service.process(noModelUser.id, '2026-11-02', NOW);
        expect(
          await prisma.automaticStudyPlanRun.findUniqueOrThrow({
            where: { userId_dateKey: { userId: noModelUser.id, dateKey: '2026-11-02' } },
          }),
        ).toMatchObject({ status: 'SKIPPED', reasonCode: 'MODEL_NOT_SELECTED' });

        models.selectedProvider.mockResolvedValue({ apiKey: 'fixture-only' } as never);
        await service.process(busyUser.id, '2026-11-02', NOW);
        expect(
          await prisma.automaticStudyPlanRun.findUniqueOrThrow({
            where: { userId_dateKey: { userId: busyUser.id, dateKey: '2026-11-02' } },
          }),
        ).toMatchObject({ status: 'SKIPPED', reasonCode: 'PLAN_IN_PROGRESS' });
        await service.process(failedUser.id, '2026-11-02', NOW);
        expect(
          await prisma.automaticStudyPlanRun.findUniqueOrThrow({
            where: { userId_dateKey: { userId: failedUser.id, dateKey: '2026-11-02' } },
          }),
        ).toMatchObject({ status: 'SKIPPED', reasonCode: 'PREVIOUS_AUTO_PLAN_FAILED' });
        expect(await prisma.studyPlan.count({ where: { userId: noModelUser.id } })).toBe(0);
        expect(await prisma.studyPlan.count({ where: { userId: busyUser.id } })).toBe(1);
        expect(await prisma.studyPlan.count({ where: { userId: failedUser.id } })).toBe(1);
        expect(study.createPlan).not.toHaveBeenCalled();
        expect(study.generatePlan).not.toHaveBeenCalled();
        expect(
          await prisma.wordReviewAttempt.count({
            where: { userId: { in: [noModelUser.id, busyUser.id, failedUser.id] } },
          }),
        ).toBe(0);
      } finally {
        await prisma.user.deleteMany({
          where: { id: { in: [noModelUser.id, busyUser.id, failedUser.id] } },
        });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('does not create learning progress until a learner answers an automatic plan', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const user = await prisma.user.create({
        data: {
          email: `auto-study-progress-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
          defaultNewWordCount: 1,
        },
        select: { id: true },
      });
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: user.id,
          kind: 'PERSONAL',
          sourceKey: fixtureId,
          title: 'Automatic progress fixture',
          sourcePath: 'test',
          category: 'GENERAL',
        },
        select: { id: true },
      });
      const word = await prisma.vocabularyWord.create({
        data: {
          normalized: `auto-study-progress-${fixtureId}`,
          text: 'steady',
          meaning: 'adj. 稳定的',
          bookWords: { create: { bookId: book.id, position: 0 } },
        },
        select: { bookWords: { select: { id: true } } },
      });
      await prisma.userVocabularyBook.create({
        data: { userId: user.id, bookId: book.id, isDefault: true },
      });
      const ai = {
        generateForUser: vi.fn(async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [
                    {
                      index: 0,
                      title: 'A steady pace',
                      wordOccurrences: { steady: 1 },
                      sentences: [
                        {
                          english: 'She kept a steady pace.',
                          chinese: '她保持着稳定的步伐。',
                          simplified: '她保持着稳定的步伐。',
                          grammar: 'steady 描述 pace。',
                        },
                      ],
                      questions: [
                        {
                          bookWordId: word.bookWords[0].id,
                          type: 'MEANING_RECOGNITION',
                          prompt: 'What does steady mean here?',
                          options: ['稳定的', '突然的', '遥远的', '狭窄的'],
                          correctAnswers: ['稳定的'],
                          explanation: 'steady 表示稳定的。',
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        })),
      };
      const service = new StudyService(
        prisma as never,
        ai as never,
        { selectedProvider: async () => ({ model: 'isolated-fixture' }) } as never,
        new MistakesService(prisma as never),
      );

      try {
        const draft = await service.createPlan(
          user.id,
          undefined,
          'group',
          undefined,
          undefined,
          undefined,
          '2026-11-02',
        );
        expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(0);
        const generated = await service.generatePlan(user.id, draft.id);
        expect(generated.status).toBe('ACTIVE');
        expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);

        await service.completeGroup(user.id, draft.id, 0, [
          { bookWordId: word.bookWords[0].id, selectedAnswer: ['稳定的'] },
        ]);
        const progress = await prisma.userWordProgress.findUniqueOrThrow({
          where: {
            userId_bookWordId: { userId: user.id, bookWordId: word.bookWords[0].id },
          },
        });
        expect(progress.firstLearnedAt).not.toBeNull();
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(1);
        expect(await prisma.learningEvent.count({ where: { userId: user.id } })).toBe(0);
        await service.completeGroup(user.id, draft.id, 0, [
          { bookWordId: word.bookWords[0].id, selectedAnswer: ['稳定的'] },
        ]);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(1);
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('retries a failed generation once against the same plan id and never creates learning credit', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await createUser(prisma, 'retry');
      await createRun(prisma, user.id);
      const settings = {
        getConfig: vi.fn().mockResolvedValue({ enabled: true, scheduleTime: '06:30' }),
      };
      const models = { selectedProvider: vi.fn(async () => ({ apiKey: 'fixture-only' })) };
      const generatedPlanIds: string[] = [];
      const study = {
        createPlan: vi.fn(
          async (
            userId: string,
            _a: unknown,
            _b: unknown,
            _c: unknown,
            _d: unknown,
            _e: unknown,
            autoDateKey: string,
          ) => {
            return prisma.studyPlan.create({
              data: {
                userId,
                mode: StudyPlanMode.GROUP,
                purpose: StudyPlanPurpose.NORMAL,
                status: 'GENERATING',
                autoDateKey,
              },
              select: { id: true },
            });
          },
        ),
        generatePlan: vi.fn(async (_userId: string, planId: string) => {
          generatedPlanIds.push(planId);
          if (generatedPlanIds.length === 1) {
            await prisma.studyPlan.update({ where: { id: planId }, data: { status: 'FAILED' } });
            return { id: planId, status: 'FAILED' };
          }
          await prisma.studyPlan.update({
            where: { id: planId },
            data: { status: 'ACTIVE', generatedContent: { groups: [] }, generatedAt: new Date() },
          });
          return { id: planId, status: 'ACTIVE' };
        }),
      };
      const service = new AutomaticStudyPlanWorkerService(
        prisma as never,
        settings as never,
        models as never,
        study as never,
      );

      try {
        await service.process(user.id, '2026-11-02', NOW);
        const firstRun = await prisma.automaticStudyPlanRun.findUniqueOrThrow({
          where: { userId_dateKey: { userId: user.id, dateKey: '2026-11-02' } },
        });
        expect(firstRun).toMatchObject({
          status: 'FAILED',
          attempts: 1,
          reasonCode: 'GENERATION_FAILED',
        });
        expect(firstRun.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 5 * 60_000);

        await service.process(user.id, '2026-11-02', new Date(NOW.getTime() + 6 * 60_000));
        const finalRun = await prisma.automaticStudyPlanRun.findUniqueOrThrow({
          where: { userId_dateKey: { userId: user.id, dateKey: '2026-11-02' } },
        });
        expect(finalRun).toMatchObject({
          status: 'GENERATED',
          attempts: 2,
          planId: firstRun.planId,
        });
        expect(study.createPlan).toHaveBeenCalledTimes(1);
        expect(generatedPlanIds).toEqual([firstRun.planId, firstRun.planId]);
        expect(await prisma.studyPlan.count({ where: { userId: user.id } })).toBe(1);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.learningEvent.count({ where: { userId: user.id } })).toBe(0);
        await service.process(user.id, '2026-11-02', new Date(NOW.getTime() + 7 * 60_000));
        expect(study.generatePlan).toHaveBeenCalledTimes(2);
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('rechecks the global switch before starting generation after claiming and creating a plan', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await createUser(prisma, 'disabled-before-generation');
      await createRun(prisma, user.id);
      const settings = {
        getConfig: vi
          .fn()
          .mockResolvedValueOnce({ enabled: true, scheduleTime: '06:30' })
          .mockResolvedValueOnce({ enabled: false, scheduleTime: '06:30' })
          .mockResolvedValue({ enabled: true, scheduleTime: '06:30' }),
      };
      const models = { selectedProvider: vi.fn(async () => ({ apiKey: 'fixture-only' })) };
      const study = {
        createPlan: vi.fn(async (userId: string, ...args: unknown[]) => {
          const autoDateKey = args[5] as string;
          return prisma.studyPlan.create({
            data: {
              userId,
              mode: StudyPlanMode.GROUP,
              purpose: StudyPlanPurpose.NORMAL,
              status: 'GENERATING',
              autoDateKey,
            },
            select: { id: true },
          });
        }),
        generatePlan: vi.fn(async (_userId: string, planId: string) => {
          await prisma.studyPlan.update({
            where: { id: planId },
            data: { status: 'ACTIVE', generatedContent: { groups: [] } },
          });
          return { id: planId, status: 'ACTIVE' };
        }),
      };
      const service = new AutomaticStudyPlanWorkerService(
        prisma as never,
        settings as never,
        models as never,
        study as never,
      );

      try {
        await service.process(user.id, '2026-11-02', NOW);
        const plan = await prisma.studyPlan.findFirstOrThrow({ where: { userId: user.id } });
        const run = await prisma.automaticStudyPlanRun.findUniqueOrThrow({
          where: { userId_dateKey: { userId: user.id, dateKey: '2026-11-02' } },
        });
        expect(settings.getConfig).toHaveBeenCalledTimes(2);
        expect(study.generatePlan).not.toHaveBeenCalled();
        expect(plan).toMatchObject({
          status: 'FAILED',
          generationStartedAt: null,
          generationError: '自动计划已关闭，尚未开始生成；可按现有手动流程继续。',
        });
        expect(run).toMatchObject({ status: 'SKIPPED', reasonCode: 'DISABLED', attempts: 0 });
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.learningEvent.count({ where: { userId: user.id } })).toBe(0);

        await createRun(prisma, user.id, '2026-11-03');
        await service.process(user.id, '2026-11-03', new Date('2026-11-03T00:00:00.000Z'));
        expect(study.createPlan).toHaveBeenCalledTimes(2);
        expect(study.generatePlan).toHaveBeenCalledTimes(1);
        expect(
          await prisma.automaticStudyPlanRun.findUniqueOrThrow({
            where: { userId_dateKey: { userId: user.id, dateKey: '2026-11-03' } },
          }),
        ).toMatchObject({ status: 'GENERATED', attempts: 1 });
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('serializes concurrent workers for a user/date and treats an old queued date as missed', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await createUser(prisma, 'race');
      const missedUser = await createUser(prisma, 'missed');
      await createRun(prisma, user.id);
      await createRun(prisma, missedUser.id, '2026-11-01');
      const settings = {
        getConfig: vi.fn().mockResolvedValue({ enabled: true, scheduleTime: '06:30' }),
      };
      const models = { selectedProvider: vi.fn(async () => ({ apiKey: 'fixture-only' })) };
      let resolvePlan!: (plan: { id: string }) => void;
      const deferredPlan = new Promise<{ id: string }>((resolve) => (resolvePlan = resolve));
      const study = {
        createPlan: vi.fn(() => deferredPlan),
        generatePlan: vi.fn(async (_userId: string, planId: string) => {
          await prisma.studyPlan.update({ where: { id: planId }, data: { status: 'ACTIVE' } });
          return { id: planId, status: 'ACTIVE' };
        }),
      };
      const service = new AutomaticStudyPlanWorkerService(
        prisma as never,
        settings as never,
        models as never,
        study as never,
      );

      try {
        const first = service.process(user.id, '2026-11-02', NOW);
        await vi.waitFor(() => expect(study.createPlan).toHaveBeenCalledTimes(1));
        await service.process(user.id, '2026-11-02', NOW);
        const plan = await prisma.studyPlan.create({
          data: {
            userId: user.id,
            mode: StudyPlanMode.GROUP,
            purpose: StudyPlanPurpose.NORMAL,
            status: 'GENERATING',
            autoDateKey: '2026-11-02',
          },
          select: { id: true },
        });
        resolvePlan(plan);
        await first;
        expect(study.createPlan).toHaveBeenCalledTimes(1);
        expect(study.generatePlan).toHaveBeenCalledTimes(1);
        expect(
          await prisma.automaticStudyPlanRun.findUniqueOrThrow({
            where: { userId_dateKey: { userId: user.id, dateKey: '2026-11-02' } },
          }),
        ).toMatchObject({ status: 'GENERATED', attempts: 1, planId: plan.id });

        await service.process(missedUser.id, '2026-11-01', NOW);
        expect(
          await prisma.automaticStudyPlanRun.findUniqueOrThrow({
            where: { userId_dateKey: { userId: missedUser.id, dateKey: '2026-11-01' } },
          }),
        ).toMatchObject({ status: 'SKIPPED', reasonCode: 'MISSED_DATE' });
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: [user.id, missedUser.id] } } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('reuses the existing per-user creation lock against a manual/automatic create race', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const user = await prisma.user.create({
        data: {
          email: `auto-study-lock-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
          defaultNewWordCount: 1,
        },
        select: { id: true },
      });
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: user.id,
          kind: 'PERSONAL',
          sourceKey: fixtureId,
          title: 'Automatic plan lock fixture',
          sourcePath: 'test',
          category: 'GENERAL',
        },
        select: { id: true },
      });
      const word = await prisma.vocabularyWord.create({
        data: {
          normalized: `auto-study-${fixtureId}`,
          text: 'steady',
          meaning: 'adj. 稳定的',
          bookWords: { create: { bookId: book.id, position: 0 } },
        },
        select: { bookWords: { select: { id: true } } },
      });
      await prisma.userVocabularyBook.create({
        data: { userId: user.id, bookId: book.id, isDefault: true },
      });
      const service = new StudyService(
        prisma as never,
        { generateForUser: vi.fn() } as never,
        { selectedProvider: vi.fn() } as never,
        new MistakesService(prisma as never),
      );

      try {
        const plans = await Promise.all([
          service.createPlan(user.id, 1, 'group'),
          service.createPlan(
            user.id,
            undefined,
            'group',
            undefined,
            undefined,
            undefined,
            '2026-11-02',
          ),
        ]);
        expect(plans[0].id).toBe(plans[1].id);
        expect(
          await prisma.studyPlan.count({
            where: { userId: user.id, purpose: StudyPlanPurpose.NORMAL },
          }),
        ).toBe(1);
        expect(
          await prisma.studyPlanItem.count({
            where: { planId: plans[0].id, bookWordId: word.bookWords[0].id },
          }),
        ).toBe(1);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.vocabularyWord.deleteMany({
          where: { normalized: `auto-study-${fixtureId}`, bookWords: { none: {} } },
        });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
