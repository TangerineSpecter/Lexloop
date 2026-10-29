import { BadRequestException } from '@nestjs/common';
import { PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { StudyService, contentSignature } from '../src/modules/study/study.service';

const generatedGroup = (index: number, bookWordId: string, word: string, title: string) => ({
  index,
  title,
  wordOccurrences: { [word]: 1 },
  sentences: [
    {
      english: `The ${word} light guided us home.`,
      chinese: '稳定的光线引导我们回家。',
      simplified: '稳定的光线引导我们回家。',
      grammar: `${word} 在句中作形容词。`,
    },
  ],
  questions: [
    {
      bookWordId,
      type: 'MEANING_RECOGNITION',
      prompt: `What does ${word} describe in the sentence?`,
      options: ['稳定的', '急促的', '沉重的', '柔软的'],
      correctAnswers: ['稳定的'],
      explanation: '结合句中光线引导回家的语境判断词义。',
    },
  ],
});

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'study plan generation from shared cache without a selected model',
  () => {
    it('allows full cache hits and requires a model only for missing groups', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const users: string[] = [];
      let bookId: string | undefined;
      let wordIds: string[] = [];
      let signatures: string[] = [];
      let modelAvailable = false;
      const selectedProvider = vi.fn(async () =>
        modelAvailable ? { id: 'isolated-fixture-model' } : null,
      );
      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
          const line = prompt.match(/^输入分组：(.*)$/m)?.[1];
          if (!line) throw new Error('fixture did not receive group input');
          const groups = JSON.parse(line) as Array<{
            index: number;
            words: Array<{ id: string; word: string }>;
          }>;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    groups: groups.map((group) =>
                      generatedGroup(
                        group.index,
                        group.words[0].id,
                        group.words[0].word,
                        `Fresh context for ${group.words[0].word}`,
                      ),
                    ),
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
        { selectedProvider } as never,
        {} as never,
      );

      try {
        const learners = await Promise.all(
          ['cache-only', 'partial-cache'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `study-cache-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
                defaultNewWordCount: 2,
              },
              select: { id: true },
            }),
          ),
        );
        users.push(...learners.map((learner) => learner.id));
        const book = await prisma.vocabularyBook.create({
          data: {
            kind: 'SYSTEM',
            sourceKey: `study-cache-${fixtureId}`,
            title: 'Study cache-only generation fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: ['steady', 'gentle'].map((word, position) => ({
                position,
                word: {
                  create: {
                    normalized: `study-cache-${fixtureId}-${word}`,
                    text: word,
                    meaning: 'adj. 稳定的',
                  },
                },
              })),
            },
          },
          select: {
            id: true,
            bookWords: { include: { word: true }, orderBy: { position: 'asc' } },
          },
        });
        bookId = book.id;
        wordIds = book.bookWords.map((bookWord) => bookWord.wordId);
        await prisma.userVocabularyBook.createMany({
          data: users.map((userId) => ({ userId, bookId: book.id, isDefault: true })),
        });

        signatures = book.bookWords.map((bookWord) =>
          contentSignature(
            StudyPlanMode.INDIVIDUAL,
            [
              {
                id: bookWord.id,
                word: bookWord.word.text,
                part: 'adj.',
                meaning: '稳定的',
              },
            ],
            StudyPlanPurpose.NORMAL,
          ),
        );
        const invalidCachedGroup = generatedGroup(
          0,
          book.bookWords[0].id,
          book.bookWords[0].word.text,
          'Broken high-hit lesson',
        );
        invalidCachedGroup.questions[0].options[2] = invalidCachedGroup.questions[0].options[0];
        await prisma.studyContentCache.createMany({
          data: Array.from({ length: 19 }, (_, index) => ({
            signature: signatures[0],
            mode: StudyPlanMode.INDIVIDUAL,
            material: invalidCachedGroup,
            hitCount: 20 - index,
          })),
        });
        const validCache = await prisma.studyContentCache.create({
          data: {
            signature: signatures[0],
            mode: StudyPlanMode.INDIVIDUAL,
            material: generatedGroup(
              0,
              book.bookWords[0].id,
              book.bookWords[0].word.text,
              'Shared cached lesson',
            ),
          },
          select: { id: true },
        });

        const cachedPlan = await service.createPlan(users[0], 1, 'individual', 0, 'book');
        const cacheStartedAt = performance.now();
        const completedFromCache = await service.generatePlan(users[0], cachedPlan.id);
        const cacheResolutionMs = Math.round(performance.now() - cacheStartedAt);
        console.log(
          `shared cache resolution: 20 variants / 1 group, no model call, ${cacheResolutionMs} ms`,
        );
        expect(completedFromCache.status).toBe('ACTIVE');
        expect(completedFromCache.content).toMatchObject({
          groups: [{ title: 'Shared cached lesson' }],
        });
        expect(selectedProvider).not.toHaveBeenCalled();
        expect(ai.generateForUser).not.toHaveBeenCalled();

        const partialPlan = await service.createPlan(users[1], 2, 'individual', 0, 'book');
        await expect(service.generatePlan(users[1], partialPlan.id)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(selectedProvider).toHaveBeenCalledTimes(1);
        expect(selectedProvider).toHaveBeenCalledWith(users[1]);
        expect(ai.generateForUser).not.toHaveBeenCalled();
        const failedPlan = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: partialPlan.id },
          select: { status: true, generationStartedAt: true, generationError: true },
        });
        expect(failedPlan).toMatchObject({
          status: 'FAILED',
          generationStartedAt: null,
          generationError: expect.stringContaining('缺失或未通过内容校验'),
        });

        modelAvailable = true;
        const retriedPlan = await service.generatePlan(users[1], partialPlan.id);
        expect(retriedPlan.status).toBe('ACTIVE');
        expect(retriedPlan.content).toMatchObject({
          groups: [{ title: 'Shared cached lesson' }, { title: 'Fresh context for gentle' }],
        });
        expect(selectedProvider).toHaveBeenCalledTimes(2);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        const generatedPrompt = ai.generateForUser.mock.calls[0][0].prompt;
        expect(generatedPrompt).toContain('gentle');
        expect(generatedPrompt).not.toContain('steady');

        const cacheRows = await prisma.studyContentCache.findMany({
          where: { signature: { in: signatures } },
          orderBy: [{ signature: 'asc' }, { hitCount: 'desc' }],
          select: { id: true, signature: true, hitCount: true, material: true },
        });
        const steadyVariants = cacheRows.filter((row) => row.signature === signatures[0]);
        const repairedOrReused = steadyVariants.find((row) => row.id === validCache.id);
        const untouchedInvalidVariants = steadyVariants.filter((row) => row.id !== validCache.id);
        expect(steadyVariants).toHaveLength(20);
        expect(repairedOrReused?.hitCount).toBe(2);
        expect(untouchedInvalidVariants).toHaveLength(19);
        expect(untouchedInvalidVariants.map((row) => row.hitCount).sort((a, b) => b - a)).toEqual(
          Array.from({ length: 19 }, (_, index) => 20 - index),
        );
        expect(untouchedInvalidVariants.map((row) => row.material)).toEqual(
          Array.from({ length: 19 }, () => invalidCachedGroup),
        );
        expect(cacheRows.filter((row) => row.signature === signatures[1])).toEqual([
          expect.objectContaining({ signature: signatures[1], hitCount: 0 }),
        ]);
      } finally {
        if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
        if (signatures.length)
          await prisma.studyContentCache.deleteMany({ where: { signature: { in: signatures } } });
        if (bookId) await prisma.vocabularyBook.delete({ where: { id: bookId } });
        if (wordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
