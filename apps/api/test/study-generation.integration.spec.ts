import { PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { ReportsService } from '../src/modules/reports/reports.service';
import { StudyService, contentSignature } from '../src/modules/study/study.service';

type PendingGeneration = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const generatedResponse = (bookWordId: string, word: string, title: string) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          groups: [
            {
              index: 0,
              title,
              wordOccurrences: { [word]: 1 },
              sentences: [
                {
                  english: `The ${word} path led to the quiet village.`,
                  chinese: '这条平稳的小路通向安静的村庄。',
                  simplified: '平稳的小路通向安静的村庄。',
                  grammar: `${word} 在句中作形容词。`,
                },
              ],
              questions: [
                {
                  bookWordId,
                  type: 'MEANING_RECOGNITION',
                  prompt: `What does ${word} describe in the sentence?`,
                  options: ['平稳的', '突然的', '狭窄的', '遥远的'],
                  correctAnswers: ['平稳的'],
                  explanation: '结合句中道路通向村庄的语境判断词义。',
                },
              ],
            },
          ],
        }),
      },
    },
  ],
});

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'study plan generation fencing in an isolated database',
  () => {
    it('keeps a newer generation when an expired request later fails or succeeds', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const pending: PendingGeneration[] = [];
      const user = await prisma.user.create({
        data: {
          email: `study-generation-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: user.id,
          kind: 'PERSONAL',
          sourceKey: fixtureId,
          title: 'Study generation fencing test',
          sourcePath: 'test',
          category: 'GENERAL',
        },
        select: { id: true },
      });
      const words = await Promise.all(
        ['steady', 'gentle'].map((text, position) =>
          prisma.vocabularyWord.create({
            data: {
              normalized: `study-generation-${fixtureId}-${text}`,
              text,
              meaning: '平稳的',
              cefrLevel: position === 0 ? 'A2' : null,
              bookWords: { create: { bookId: book.id, position } },
            },
            select: { id: true, bookWords: { select: { id: true } } },
          }),
        ),
      );
      const plans = await Promise.all(
        words.map((word) =>
          prisma.studyPlan.create({
            data: {
              userId: user.id,
              mode: StudyPlanMode.GROUP,
              purpose: StudyPlanPurpose.NORMAL,
              status: 'GENERATING',
              items: {
                create: {
                  bookWordId: word.bookWords[0].id,
                  source: 'NEW',
                  groupIndex: 0,
                },
              },
            },
            select: { id: true },
          }),
        ),
      );
      const ai = {
        generateForUser: vi.fn(
          (_input: { prompt: string }) =>
            new Promise((resolve, reject) => pending.push({ resolve, reject })),
        ),
      };
      const service = new StudyService(
        prisma as never,
        ai as never,
        { selectedProvider: async () => ({ model: 'isolated-fixture' }) } as never,
        {} as MistakesService,
      );
      const cacheSignatures = words.map((word) =>
        contentSignature(
          StudyPlanMode.GROUP,
          [
            {
              id: word.bookWords[0].id,
              word: word === words[0] ? 'steady' : 'gentle',
              part: '',
              meaning: '平稳的',
              cefrLevel: word === words[0] ? 'A2' : null,
            },
          ],
          StudyPlanPurpose.NORMAL,
        ),
      );

      const waitForCall = async (count: number) => {
        await vi.waitFor(() => expect(pending).toHaveLength(count));
      };
      const startSupersededPair = async (planId: string, callIndex: number) => {
        const first = service.generatePlan(user.id, planId);
        await waitForCall(callIndex + 1);
        await prisma.studyPlan.update({
          where: { id: planId },
          data: { generationStartedAt: new Date(Date.now() - 11 * 60_000) },
        });
        const second = service.generatePlan(user.id, planId);
        await waitForCall(callIndex + 2);
        return { first, second };
      };

      try {
        // An old request that fails after the replacement has committed must not
        // change the successful plan back to FAILED.
        const failRace = await startSupersededPair(plans[0].id, 0);
        pending[1].resolve(
          generatedResponse(words[0].bookWords[0].id, 'steady', 'newer successful lesson'),
        );
        const newerAfterFailure = await failRace.second;
        pending[0].reject(new Error('late transport timeout'));
        const olderAfterFailure = await failRace.first;
        expect(newerAfterFailure).toMatchObject({ id: plans[0].id, status: 'ACTIVE' });
        expect(olderAfterFailure).toMatchObject({ id: plans[0].id, status: 'ACTIVE' });
        expect(olderAfterFailure.content).toMatchObject({
          groups: [{ title: 'newer successful lesson' }],
        });

        // An old request that succeeds late must not replace the lesson or
        // question saved by the current generation claim.
        const successRace = await startSupersededPair(plans[1].id, 2);
        const prompts = ai.generateForUser.mock.calls.map(([input]) => input.prompt);
        expect(prompts.some((prompt) => prompt.includes('"cefrLevel":"A2"'))).toBe(true);
        expect(prompts.some((prompt) => prompt.includes('"cefrLevel":null'))).toBe(true);
        expect(prompts.every((prompt) => !prompt.includes('overallLevel'))).toBe(true);
        pending[3].resolve(generatedResponse(words[1].bookWords[0].id, 'gentle', 'current lesson'));
        const newerAfterSuccess = await successRace.second;
        pending[2].resolve(
          generatedResponse(words[1].bookWords[0].id, 'gentle', 'stale late lesson'),
        );
        const olderAfterSuccess = await successRace.first;
        expect(newerAfterSuccess).toMatchObject({ id: plans[1].id, status: 'ACTIVE' });
        expect(olderAfterSuccess).toMatchObject({ id: plans[1].id, status: 'ACTIVE' });
        expect(olderAfterSuccess.content).toMatchObject({
          groups: [{ title: 'current lesson' }],
        });

        const savedPlans = await prisma.studyPlan.findMany({
          where: { id: { in: plans.map((plan) => plan.id) }, userId: user.id },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, generationError: true, generatedContent: true },
        });
        expect(savedPlans).toHaveLength(2);
        expect(
          savedPlans.every((plan) => plan.status === 'ACTIVE' && plan.generationError === null),
        ).toBe(true);
        expect(
          await prisma.studyContentCache.count({ where: { signature: { in: cacheSignatures } } }),
        ).toBe(2);
        expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(2);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.studyContentCache.deleteMany({
          where: { signature: { in: cacheSignatures } },
        });
        await prisma.vocabularyWord.deleteMany({
          where: {
            id: { in: words.map((word) => word.id) },
            bookWords: { none: {} },
          },
        });
        await prisma.$disconnect();
      }
    }, 60_000);

    it('repairs duplicate cached choices without changing another learner’s saved answers', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const user = await prisma.user.create({
        data: {
          email: `study-duplicate-options-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      const historyUser = await prisma.user.create({
        data: {
          email: `study-duplicate-history-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      const book = await prisma.vocabularyBook.create({
        data: {
          kind: 'SYSTEM',
          sourceKey: fixtureId,
          title: 'Duplicate options test',
          sourcePath: 'test',
          category: 'GENERAL',
        },
        select: { id: true },
      });
      await prisma.userVocabularyBook.createMany({
        data: [user.id, historyUser.id].map((userId) => ({ userId, bookId: book.id })),
      });
      const word = await prisma.vocabularyWord.create({
        data: {
          normalized: `study-duplicate-options-${fixtureId}`,
          text: 'steady',
          meaning: '平稳的',
          bookWords: { create: { bookId: book.id, position: 0 } },
        },
        select: { id: true, bookWords: { select: { id: true } } },
      });
      const plan = await prisma.studyPlan.create({
        data: {
          userId: user.id,
          mode: StudyPlanMode.GROUP,
          purpose: StudyPlanPurpose.NORMAL,
          status: 'GENERATING',
          items: {
            create: {
              bookWordId: word.bookWords[0].id,
              source: 'NEW',
              groupIndex: 0,
            },
          },
        },
        select: { id: true },
      });
      const signature = contentSignature(
        StudyPlanMode.GROUP,
        [
          {
            id: word.bookWords[0].id,
            word: 'steady',
            part: '',
            meaning: '平稳的',
            cefrLevel: null,
          },
        ],
        StudyPlanPurpose.NORMAL,
      );
      const invalidContent = JSON.parse(
        generatedResponse(word.bookWords[0].id, 'steady', 'A steady path').choices[0].message
          .content,
      );
      invalidContent.groups[0].questions[0].options[2] = ' 平稳的　';
      const ai = {
        generateForUser: vi
          .fn()
          .mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify(invalidContent) } }],
          })
          .mockResolvedValueOnce(
            generatedResponse(word.bookWords[0].id, 'steady', 'A repaired steady path'),
          ),
      };
      let providerAvailable = true;
      const modelConfigs = {
        selectedProvider: vi.fn(async () =>
          providerAvailable ? { model: 'isolated-fixture' } : null,
        ),
      };
      const service = new StudyService(
        prisma as never,
        ai as never,
        modelConfigs as never,
        {} as MistakesService,
      );

      try {
        await expect(service.generatePlan(user.id, plan.id)).rejects.toThrow(
          '选项语言、数量或唯一性',
        );
        let savedPlan = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: plan.id },
          select: { status: true, generatedContent: true, generationError: true },
        });
        expect(savedPlan).toMatchObject({ status: 'FAILED', generatedContent: null });
        expect(savedPlan.generationError).toContain('选项语言、数量或唯一性');
        expect(await prisma.studyContentCache.count({ where: { signature } })).toBe(0);
        expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(0);

        const historicalGroup = JSON.parse(
          generatedResponse(word.bookWords[0].id, 'steady', 'Saved steady lesson').choices[0]
            .message.content,
        ).groups[0];
        const cacheEntry = await prisma.studyContentCache.create({
          data: {
            signature,
            mode: StudyPlanMode.GROUP,
            material: historicalGroup,
          },
          select: { id: true },
        });
        const completedAt = new Date('2026-10-27T12:00:00.000Z');
        const historicalPlan = await prisma.studyPlan.create({
          data: {
            userId: historyUser.id,
            mode: StudyPlanMode.GROUP,
            purpose: StudyPlanPurpose.NORMAL,
            status: 'COMPLETED',
            generatedContent: { groups: [historicalGroup] },
            generatedAt: completedAt,
            completedAt,
            items: {
              create: {
                bookWordId: word.bookWords[0].id,
                contentCacheId: cacheEntry.id,
                source: 'NEW',
                groupIndex: 0,
                question: historicalGroup.questions[0],
                completedAt,
              },
            },
          },
          select: { id: true },
        });
        await prisma.wordReviewAttempt.create({
          data: {
            userId: historyUser.id,
            bookWordId: word.bookWords[0].id,
            planItemId: (
              await prisma.studyPlanItem.findFirstOrThrow({
                where: { planId: historicalPlan.id },
                select: { id: true },
              })
            ).id,
            isCorrect: true,
            questionType: 'MEANING_RECOGNITION',
            selectedAnswer: ['平稳的'],
            responseTimeMs: 700,
            createdAt: completedAt,
          },
        });
        const historicalBefore = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: historicalPlan.id },
          select: {
            status: true,
            generatedContent: true,
            completedAt: true,
            items: {
              select: {
                question: true,
                completedAt: true,
                attempts: {
                  select: { isCorrect: true, selectedAnswer: true, responseTimeMs: true },
                },
              },
            },
          },
        });
        await prisma.studyContentCache.update({
          where: { id: cacheEntry.id },
          data: { material: invalidContent.groups[0] },
        });
        providerAvailable = false;
        await expect(service.generatePlan(user.id, plan.id)).rejects.toThrow(
          '缺失或未通过内容校验',
        );
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        expect(modelConfigs.selectedProvider).toHaveBeenCalledTimes(2);
        const waitingPlan = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: plan.id },
          select: { status: true, generatedContent: true, generationError: true },
        });
        expect(waitingPlan).toMatchObject({ status: 'FAILED', generatedContent: null });
        expect(waitingPlan.generationError).toContain('缺失或未通过内容校验');
        expect(
          await prisma.studyContentCache.findFirstOrThrow({ where: { signature } }),
        ).toMatchObject({ hitCount: 0 });
        expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(0);

        providerAvailable = true;
        const repairedPlan = await service.generatePlan(user.id, plan.id);
        expect(repairedPlan.status).toBe('ACTIVE');
        expect(ai.generateForUser).toHaveBeenCalledTimes(2);
        savedPlan = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: plan.id },
          select: { status: true, generatedContent: true, generationError: true },
        });
        expect(savedPlan).toMatchObject({ status: 'ACTIVE', generationError: null });
        const savedQuestion = (
          savedPlan.generatedContent as {
            groups: Array<{ questions: Array<{ options: string[] }> }>;
          }
        ).groups[0].questions[0];
        expect(
          new Set(
            savedQuestion.options.map((option) => option.normalize('NFKC').trim().toLowerCase()),
          ).size,
        ).toBe(4);
        const repairedCache = await prisma.studyContentCache.findFirstOrThrow({
          where: { signature },
        });
        expect(repairedCache.hitCount).toBe(1);
        expect(
          (repairedCache.material as { questions: Array<{ options: string[] }> }).questions[0]
            .options,
        ).toEqual(savedQuestion.options);
        expect(
          await prisma.studyPlanItem.findFirstOrThrow({ where: { planId: plan.id } }),
        ).toMatchObject({ contentCacheId: repairedCache.id });
        expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(1);
        const historicalAfter = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: historicalPlan.id },
          select: {
            status: true,
            generatedContent: true,
            completedAt: true,
            items: {
              select: {
                question: true,
                completedAt: true,
                attempts: {
                  select: { isCorrect: true, selectedAnswer: true, responseTimeMs: true },
                },
              },
            },
          },
        });
        expect(historicalAfter).toEqual(historicalBefore);
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: [user.id, historyUser.id] } } });
        await prisma.studyContentCache.deleteMany({ where: { signature } });
        await prisma.vocabularyBook.delete({ where: { id: book.id } });
        await prisma.vocabularyWord.deleteMany({
          where: { id: word.id, bookWords: { none: {} } },
        });
        await prisma.$disconnect();
      }
    }, 60_000);

    it('records when a new word becomes available and reports it on the learner local day', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const learner = await prisma.user.create({
        data: {
          email: `study-first-learned-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      const otherLearner = await prisma.user.create({
        data: {
          email: `study-first-learned-other-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: learner.id,
          kind: 'PERSONAL',
          sourceKey: fixtureId,
          title: 'First learned timestamp test',
          sourcePath: 'test',
          category: 'GENERAL',
        },
        select: { id: true },
      });
      const word = await prisma.vocabularyWord.create({
        data: {
          normalized: `study-first-learned-${fixtureId}`,
          text: 'steady',
          meaning: '平稳的',
          bookWords: { create: { bookId: book.id, position: 0 } },
        },
        select: { id: true, bookWords: { select: { id: true } } },
      });
      const plan = await prisma.studyPlan.create({
        data: {
          userId: learner.id,
          mode: StudyPlanMode.GROUP,
          purpose: StudyPlanPurpose.NORMAL,
          status: 'GENERATING',
          items: {
            create: { bookWordId: word.bookWords[0].id, source: 'NEW', groupIndex: 0 },
          },
        },
        select: { id: true },
      });
      const ai = {
        generateForUser: vi
          .fn()
          .mockResolvedValue(generatedResponse(word.bookWords[0].id, 'steady', 'A steady path')),
      };
      const service = new StudyService(
        prisma as never,
        ai as never,
        { selectedProvider: async () => ({ model: 'isolated-fixture' }) } as never,
        {} as MistakesService,
      );
      const previousTimezone = process.env.TZ;
      const introducedAt = new Date('2026-10-26T23:00:00.000Z');
      process.env.TZ = 'UTC';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(introducedAt);

      try {
        await service.generatePlan(learner.id, plan.id);
        const completedPlan = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: plan.id },
          select: { generatedAt: true },
        });
        const saved = await prisma.userWordProgress.findUniqueOrThrow({
          where: { userId_bookWordId: { userId: learner.id, bookWordId: word.bookWords[0].id } },
        });
        expect(completedPlan.generatedAt).toEqual(introducedAt);
        if (!saved.firstLearnedAt) throw new Error('Generated new word has no first learned time.');
        expect(saved.firstLearnedAt).toEqual(introducedAt);
        expect(
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(saved.firstLearnedAt),
        ).toBe('2026-10-27');

        const reports = new ReportsService(prisma as never, {} as never);
        await expect(reports.statistics(learner.id, 1, 'Asia/Shanghai')).resolves.toMatchObject({
          newWords: 1,
        });
        await expect(
          reports.statistics(otherLearner.id, 1, 'Asia/Shanghai'),
        ).resolves.toMatchObject({ newWords: 0 });

        await service.generatePlan(learner.id, plan.id);
        const replayed = await prisma.userWordProgress.findUniqueOrThrow({
          where: { userId_bookWordId: { userId: learner.id, bookWordId: word.bookWords[0].id } },
        });
        expect(replayed.firstLearnedAt).toEqual(introducedAt);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
        await prisma.user.deleteMany({ where: { id: { in: [learner.id, otherLearner.id] } } });
        const signature = contentSignature(
          StudyPlanMode.GROUP,
          [
            {
              id: word.bookWords[0].id,
              word: 'steady',
              part: '',
              meaning: '平稳的',
              cefrLevel: null,
            },
          ],
          StudyPlanPurpose.NORMAL,
        );
        await prisma.studyContentCache.deleteMany({ where: { signature } });
        await prisma.vocabularyWord.deleteMany({
          where: { id: word.id, bookWords: { none: {} } },
        });
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
