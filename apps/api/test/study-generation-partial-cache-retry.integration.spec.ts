import { PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StudyService, contentSignature } from '../src/modules/study/study.service';

const generatedGroup = (index: number, bookWordId: string, word: string, title: string) => ({
  index,
  title,
  wordOccurrences: { [word]: 1 },
  sentences: [
    {
      english: `The ${word} path led to a quiet village.`,
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
      options: ['稳定的', '急促的', '沉重的', '柔软的'],
      correctAnswers: ['稳定的'],
      explanation: '结合句中的语境判断词义。',
    },
  ],
});

const responseForPrompt = (prompt: string, invalid = false) => {
  const input = prompt.match(/^输入分组：(.*)$/m)?.[1];
  if (!input) throw new Error('fixture did not receive generation groups');
  const specs = JSON.parse(input) as Array<{
    index: number;
    words: Array<{ id: string; word: string }>;
  }>;
  const groups = specs.map((spec) =>
    generatedGroup(
      spec.index,
      spec.words[0].id,
      spec.words[0].word,
      `Recovered ${spec.words[0].word} lesson`,
    ),
  );
  if (invalid) groups[0].questions[0].options[2] = groups[0].questions[0].options[0];
  return { choices: [{ message: { content: JSON.stringify({ groups }) } }] };
};

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'partial cached study-plan generation recovery in an isolated database',
  () => {
    it('keeps cache hits untouched after invalid missing content and retries only missing groups', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      let userId: string | undefined;
      let bookId: string | undefined;
      let planId: string | undefined;
      let wordIds: string[] = [];
      const signatures: string[] = [];
      const users = await prisma.user.create({
        data: {
          email: `study-partial-cache-retry-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      userId = users.id;

      try {
        const book = await prisma.vocabularyBook.create({
          data: {
            kind: 'SYSTEM',
            sourceKey: `study-partial-cache-retry-${fixtureId}`,
            title: 'Partial cache retry fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: ['steady', 'gentle'].map((text, position) => ({
                position,
                word: {
                  create: {
                    normalized: `study-partial-cache-retry-${fixtureId}-${text}`,
                    text,
                    meaning: 'adj. 稳定的',
                  },
                },
              })),
            },
          },
          select: {
            id: true,
            bookWords: {
              orderBy: { position: 'asc' },
              include: { word: true },
            },
          },
        });
        bookId = book.id;
        wordIds = book.bookWords.map((bookWord) => bookWord.wordId);
        await prisma.userVocabularyBook.create({
          data: { userId: users.id, bookId: book.id, isDefault: true },
        });

        const groupSpecs = book.bookWords.map((bookWord) => ({
          id: bookWord.id,
          word: bookWord.word.text,
          part: 'adj.',
          meaning: '稳定的',
        }));
        signatures.push(
          ...groupSpecs.map((word) =>
            contentSignature(StudyPlanMode.INDIVIDUAL, [word], StudyPlanPurpose.NORMAL),
          ),
        );
        const cachedGroup = generatedGroup(
          0,
          book.bookWords[0].id,
          book.bookWords[0].word.text,
          'Already available steady lesson',
        );
        const cacheEntry = await prisma.studyContentCache.create({
          data: {
            signature: signatures[0],
            mode: StudyPlanMode.INDIVIDUAL,
            material: cachedGroup,
          },
          select: { id: true },
        });
        const plan = await prisma.studyPlan.create({
          data: {
            userId: users.id,
            mode: StudyPlanMode.INDIVIDUAL,
            purpose: StudyPlanPurpose.NORMAL,
            status: 'GENERATING',
            items: {
              create: book.bookWords.map((bookWord, groupIndex) => ({
                bookWordId: bookWord.id,
                source: 'NEW',
                groupIndex,
              })),
            },
          },
          select: { id: true },
        });
        planId = plan.id;

        const ai = {
          generateForUser: vi
            .fn()
            .mockImplementationOnce(async ({ prompt }: { prompt: string }) =>
              responseForPrompt(prompt, true),
            )
            .mockImplementationOnce(async ({ prompt }: { prompt: string }) =>
              responseForPrompt(prompt),
            ),
        };
        const selectedProvider = vi.fn(async () => ({ id: 'isolated-fixture-model' }));
        const service = new StudyService(
          prisma as never,
          ai as never,
          { selectedProvider } as never,
          {} as never,
        );

        await expect(service.generatePlan(users.id, plan.id)).rejects.toThrow(
          '选项语言、数量或唯一性',
        );
        const failedPlan = await prisma.studyPlan.findUniqueOrThrow({
          where: { id: plan.id },
          select: { status: true, generatedContent: true, generationError: true },
        });
        expect(failedPlan).toMatchObject({ status: 'FAILED', generatedContent: null });
        expect(failedPlan.generationError).toContain('选项语言、数量或唯一性');
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        const failedPrompt = ai.generateForUser.mock.calls[0][0].prompt;
        expect(failedPrompt).toContain('gentle');
        expect(failedPrompt).not.toContain('steady');

        const cacheAfterFailure = await prisma.studyContentCache.findUniqueOrThrow({
          where: { id: cacheEntry.id },
          select: { hitCount: true, material: true },
        });
        expect(cacheAfterFailure).toEqual({ hitCount: 0, material: cachedGroup });
        const itemsAfterFailure = await prisma.studyPlanItem.findMany({
          where: { planId: plan.id },
          select: { contentCacheId: true, question: true, completedAt: true },
        });
        expect(itemsAfterFailure).toHaveLength(2);
        expect(itemsAfterFailure.every((item) => item.contentCacheId === null)).toBe(true);
        expect(itemsAfterFailure.every((item) => item.question === null)).toBe(true);
        expect(itemsAfterFailure.every((item) => item.completedAt === null)).toBe(true);
        expect(await prisma.userWordProgress.count({ where: { userId: users.id } })).toBe(0);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: users.id } })).toBe(0);

        const recovered = await service.generatePlan(users.id, plan.id);
        expect(recovered.status).toBe('ACTIVE');
        expect(recovered.content).toMatchObject({
          groups: [
            { title: 'Already available steady lesson' },
            { title: 'Recovered gentle lesson' },
          ],
        });
        expect(selectedProvider).toHaveBeenCalledTimes(2);
        expect(ai.generateForUser).toHaveBeenCalledTimes(2);
        const retryPrompt = ai.generateForUser.mock.calls[1][0].prompt;
        expect(retryPrompt).toContain('gentle');
        expect(retryPrompt).not.toContain('steady');

        const caches = await prisma.studyContentCache.findMany({
          where: { signature: { in: signatures } },
          orderBy: { signature: 'asc' },
          select: { id: true, signature: true, hitCount: true, material: true },
        });
        expect(caches).toHaveLength(2);
        expect(caches.find((cache) => cache.id === cacheEntry.id)).toMatchObject({
          hitCount: 1,
          material: cachedGroup,
        });
        expect(caches.find((cache) => cache.signature === signatures[1])).toMatchObject({
          hitCount: 0,
          material: expect.objectContaining({ title: 'Recovered gentle lesson' }),
        });
        const recoveredItems = await prisma.studyPlanItem.findMany({
          where: { planId: plan.id },
          orderBy: { groupIndex: 'asc' },
          select: { bookWordId: true, contentCacheId: true },
        });
        const recoveredSteadyCache = caches.find((cache) => cache.signature === signatures[0]);
        const recoveredGentleCache = caches.find((cache) => cache.signature === signatures[1]);
        expect(recoveredItems.map((item) => item.contentCacheId)).toEqual([
          recoveredSteadyCache?.id,
          recoveredGentleCache?.id,
        ]);
        expect(await prisma.userWordProgress.count({ where: { userId: users.id } })).toBe(2);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: users.id } })).toBe(0);
      } finally {
        if (signatures.length) {
          await prisma.studyContentCache.deleteMany({ where: { signature: { in: signatures } } });
        }
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        if (wordIds.length) {
          await prisma.vocabularyWord.deleteMany({
            where: { id: { in: wordIds }, bookWords: { none: {} } },
          });
        }
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
