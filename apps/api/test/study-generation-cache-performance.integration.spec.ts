import { PrismaClient, WordProgressState } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

const REVIEW_WORDS = 40;
const NEW_WORDS = 100;
const MAX_INDIVIDUAL_GROUPS = REVIEW_WORDS + NEW_WORDS;

const generatedGroup = (index: number, bookWordId: string, word: string) => ({
  index,
  title: `A clear path with ${word}`,
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

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'study-plan generation cache lookup budget in an isolated database',
  () => {
    it('resolves a maximum individual plan with one batched cache query', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
        log: [{ emit: 'event', level: 'query' }],
      });
      const fixtureId = randomUUID();
      const cacheLookupDurations: number[] = [];
      let userId: string | undefined;
      let bookId: string | undefined;
      let planId: string | undefined;
      let wordIds: string[] = [];

      prisma.$on('query', (event) => {
        if (/SELECT[\s\S]*FROM\s+"public"\."StudyContentCache"/i.test(event.query)) {
          cacheLookupDurations.push(event.duration);
        }
      });

      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
          const input = prompt.match(/^输入分组：(.*)$/m)?.[1];
          if (!input) throw new Error('fixture did not receive generation groups');
          const groups = JSON.parse(input) as Array<{
            index: number;
            words: Array<{ id: string; word: string }>;
          }>;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    groups: groups.map((group) =>
                      generatedGroup(group.index, group.words[0].id, group.words[0].word),
                    ),
                  }),
                },
              },
            ],
          };
        }),
      };
      const selectedProvider = vi.fn(async () => ({ id: 'isolated-fixture-model' }));
      const service = new StudyService(
        prisma as never,
        ai as never,
        { selectedProvider } as never,
        {} as never,
      );

      try {
        const user = await prisma.user.create({
          data: {
            email: `study-cache-budget-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
            defaultNewWordCount: 40,
          },
          select: { id: true },
        });
        userId = user.id;

        const book = await prisma.vocabularyBook.create({
          data: {
            kind: 'SYSTEM',
            sourceKey: `study-cache-budget-${fixtureId}`,
            title: 'Study generation cache lookup budget fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: Array.from({ length: MAX_INDIVIDUAL_GROUPS }, (_, position) => ({
                position,
                word: {
                  create: {
                    normalized: `study-cache-budget-${fixtureId}-${position}`,
                    text: `steady${String(position).padStart(3, '0')}`,
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
              select: { id: true, wordId: true },
            },
          },
        });
        bookId = book.id;
        wordIds = book.bookWords.map((bookWord) => bookWord.wordId);
        await prisma.userVocabularyBook.create({
          data: { userId: user.id, bookId: book.id, isDefault: true },
        });
        await prisma.userWordProgress.createMany({
          data: book.bookWords.slice(0, REVIEW_WORDS).map((bookWord) => ({
            userId: user.id,
            bookWordId: bookWord.id,
            state: WordProgressState.REVIEWING,
            nextReviewAt: new Date(Date.now() - 60_000),
          })),
        });

        const plan = await service.createPlan(user.id, NEW_WORDS, 'individual', REVIEW_WORDS);
        planId = plan.id;
        expect(plan.words).toHaveLength(MAX_INDIVIDUAL_GROUPS);
        cacheLookupDurations.length = 0;

        const startedAt = performance.now();
        const generated = await service.generatePlan(user.id, plan.id);
        const generationMs = Math.round(performance.now() - startedAt);
        const lookupQueryCount = cacheLookupDurations.length;
        const cumulativeLookupMs = Math.round(
          cacheLookupDurations.reduce((sum, duration) => sum + duration, 0),
        );
        const generatedGroups = (generated.content as { groups: unknown[] }).groups;

        expect(generated.status).toBe('ACTIVE');
        expect(generatedGroups).toHaveLength(MAX_INDIVIDUAL_GROUPS);
        expect(lookupQueryCount).toBe(1);
        expect(selectedProvider).toHaveBeenCalledTimes(1);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        console.log(
          `study generation cache reads: ${MAX_INDIVIDUAL_GROUPS} individual groups / ${lookupQueryCount} SELECTs / ${cumulativeLookupMs} cumulative DB ms / ${generationMs} total ms (fixture model)`,
        );
      } finally {
        if (planId) {
          const linkedCaches = await prisma.studyContentCache.findMany({
            where: { planItems: { some: { planId } } },
            select: { id: true },
          });
          if (linkedCaches.length) {
            await prisma.studyContentCache.deleteMany({
              where: { id: { in: linkedCaches.map((cache) => cache.id) } },
            });
          }
          await prisma.studyPlan.deleteMany({ where: { id: planId } });
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
    }, 120_000);
  },
);
