import { PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
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
  },
);
