import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { ReportsService } from '../src/modules/reports/reports.service';
import { StudyService } from '../src/modules/study/study.service';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'vocabulary progress summary in an isolated database',
  () => {
    it('counts mastery in each learner’s default book and returns real zero only when no book exists', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const sourceKeys = [`progress-summary-${fixtureId}-one`, `progress-summary-${fixtureId}-two`];
      const normalizedWords = [
        `progress-summary-${fixtureId}-one-a`,
        `progress-summary-${fixtureId}-one-b`,
        `progress-summary-${fixtureId}-two-a`,
      ];

      try {
        const users = await Promise.all(
          ['one', 'two', 'none'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `progress-summary-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));

        const books = await Promise.all(
          users.slice(0, 2).map((user, index) =>
            prisma.vocabularyBook.create({
              data: {
                ownerId: user.id,
                kind: 'PERSONAL',
                sourceKey: sourceKeys[index],
                title: 'Progress summary isolation test',
                sourcePath: 'test',
                category: 'GENERAL',
                bookWords: {
                  create:
                    index === 0
                      ? [
                          {
                            position: 0,
                            word: {
                              create: {
                                normalized: normalizedWords[0],
                                text: 'steady',
                                meaning: '稳定的',
                              },
                            },
                          },
                          {
                            position: 1,
                            word: {
                              create: {
                                normalized: normalizedWords[1],
                                text: 'patient',
                                meaning: '耐心的',
                              },
                            },
                          },
                        ]
                      : [
                          {
                            position: 0,
                            word: {
                              create: {
                                normalized: normalizedWords[2],
                                text: 'curious',
                                meaning: '好奇的',
                              },
                            },
                          },
                        ],
                },
              },
              select: { id: true, bookWords: { select: { wordId: true } } },
            }),
          ),
        );

        await Promise.all(
          books.map((book, index) =>
            prisma.userVocabularyBook.create({
              data: { userId: users[index].id, bookId: book.id, isDefault: true },
            }),
          ),
        );
        await prisma.userMasteredWord.create({
          data: { userId: users[0].id, wordId: books[0].bookWords[0].wordId },
        });
        await prisma.userMasteredWord.create({
          data: { userId: users[1].id, wordId: books[1].bookWords[0].wordId },
        });
        await prisma.userMasteredWord.create({
          data: { userId: users[1].id, wordId: books[0].bookWords[1].wordId },
        });

        const service = new VocabularyService(prisma as never);
        await expect(service.getProgressSummary(users[0].id)).resolves.toEqual({
          totalWords: 2,
          masteredWords: 1,
          progress: 50,
        });
        await expect(service.getProgressSummary(users[1].id)).resolves.toEqual({
          totalWords: 1,
          masteredWords: 1,
          progress: 100,
        });
        await expect(service.getProgressSummary(users[2].id)).resolves.toEqual({
          totalWords: 0,
          masteredWords: 0,
          progress: 0,
        });
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey: { in: sourceKeys } } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalizedWords } } });
        await prisma.$disconnect();
      }
    });

    it('keeps global mastery out of review counts and lets pending plans resume after undo', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const sourceKeys = [`mastery-${fixtureId}-one`, `mastery-${fixtureId}-two`];
      const normalized = `mastery-${fixtureId}-word`;

      try {
        const users = await Promise.all(
          ['one', 'two'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `mastery-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));

        const word = await prisma.vocabularyWord.create({
          data: { normalized, text: 'steady', meaning: '稳定的' },
          select: { id: true },
        });
        const books = await Promise.all(
          sourceKeys.map((sourceKey, index) =>
            prisma.vocabularyBook.create({
              data: {
                sourceKey,
                category: 'GENERAL',
                title: `Mastery copy ${index + 1}`,
                sourcePath: 'test',
                kind: 'SYSTEM',
                bookWords: { create: { wordId: word.id, position: 0 } },
              },
              select: { id: true, bookWords: { select: { id: true } } },
            }),
          ),
        );
        await prisma.userVocabularyBook.createMany({
          data: [
            { userId: users[0].id, bookId: books[0].id, isDefault: true },
            { userId: users[0].id, bookId: books[1].id },
            { userId: users[1].id, bookId: books[0].id, isDefault: true },
          ],
        });

        const dueAt = new Date(Date.now() - 2 * 86_400_000);
        const learnedAt = new Date(Date.now() - 86_400_000);
        const progressFixture = {
          state: 'REVIEWING' as const,
          reviewCount: 4,
          totalAttempts: 6,
          correctAttempts: 3,
          consecutiveCorrect: 1,
          lastIntervalDays: 2,
          firstLearnedAt: learnedAt,
          lastReviewedAt: learnedAt,
          nextReviewAt: dueAt,
        };
        await prisma.userWordProgress.createMany({
          data: [
            {
              userId: users[0].id,
              bookWordId: books[0].bookWords[0].id,
              ...progressFixture,
            },
            {
              userId: users[0].id,
              bookWordId: books[1].bookWords[0].id,
              ...progressFixture,
            },
            {
              userId: users[1].id,
              bookWordId: books[0].bookWords[0].id,
              ...progressFixture,
            },
          ],
        });

        const vocabulary = new VocabularyService(prisma as never);
        await vocabulary.markMastered(users[0].id, books[0].bookWords[0].id);

        expect(
          await prisma.userMasteredWord.findUnique({
            where: { userId_wordId: { userId: users[0].id, wordId: word.id } },
          }),
        ).not.toBeNull();
        const masteredProgress = await prisma.userWordProgress.findMany({
          where: { userId: users[0].id },
          orderBy: { bookWordId: 'asc' },
        });
        expect(masteredProgress).toHaveLength(2);
        expect(masteredProgress).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              bookWordId: books[0].bookWords[0].id,
              state: 'MASTERED',
              nextReviewAt: null,
              reviewCount: 4,
              totalAttempts: 6,
              correctAttempts: 3,
              consecutiveCorrect: 1,
              lastIntervalDays: 2,
            }),
            expect.objectContaining({
              bookWordId: books[1].bookWords[0].id,
              state: 'REVIEWING',
              nextReviewAt: dueAt,
              reviewCount: 4,
              totalAttempts: 6,
              correctAttempts: 3,
              consecutiveCorrect: 1,
              lastIntervalDays: 2,
            }),
          ]),
        );
        expect(await prisma.wordReviewAttempt.count({ where: { userId: users[0].id } })).toBe(0);

        await expect(vocabulary.getDashboardWords(users[0].id)).resolves.toMatchObject({
          reviewWords: [],
        });
        await expect(vocabulary.listLearningWords(users[0].id)).resolves.toEqual([]);
        await expect(vocabulary.getDashboardWords(users[1].id)).resolves.toMatchObject({
          reviewWords: [expect.objectContaining({ id: books[0].bookWords[0].id })],
        });
        await expect(vocabulary.listLearningWords(users[1].id)).resolves.toEqual([
          expect.objectContaining({ id: books[0].bookWords[0].id, state: 'REVIEWING' }),
        ]);

        const ai = { generateForUser: vi.fn() };
        const reports = new ReportsService(prisma as never, ai as never);
        const study = new StudyService(
          prisma as never,
          ai as never,
          {
            selectedProvider: vi.fn().mockResolvedValue({ id: 'isolated-fixture-model' }),
          } as never,
          new MistakesService(prisma as never),
        );
        await expect(study.createPlan(users[0].id, 1)).rejects.toThrow(
          '当前没有可加入学习计划的单词',
        );
        expect(
          await prisma.studyPlan.count({
            where: { userId: users[0].id, purpose: 'NORMAL' },
          }),
        ).toBe(0);
        expect(ai.generateForUser).not.toHaveBeenCalled();

        const question = {
          type: 'MEANING_RECOGNITION',
          prompt: 'Choose the meaning of steady.',
          options: ['稳定的', '急促的'],
          correctAnswers: ['稳定的'],
          explanation: 'steady describes something stable or regular.',
        };
        const planCreatedBeforeMastery = new Date(Date.now() - 60 * 60 * 1000);
        const createPendingPlan = (bookWordId: string) =>
          prisma.studyPlan.create({
            data: {
              userId: users[0].id,
              mode: 'GROUP',
              purpose: 'NORMAL',
              status: 'ACTIVE',
              createdAt: planCreatedBeforeMastery,
              startedAt: planCreatedBeforeMastery,
              generatedAt: planCreatedBeforeMastery,
              generatedContent: {
                groups: [
                  {
                    index: 0,
                    title: 'A steady pace',
                    wordOccurrences: { steady: 1 },
                    sentences: [],
                    questions: [{ ...question, bookWordId }],
                  },
                ],
              },
              items: {
                create: {
                  bookWordId,
                  source: 'REVIEW',
                  groupIndex: 0,
                  question,
                },
              },
            },
            select: { id: true },
          });
        const [planForFirstBook, planForSecondBook] = await Promise.all([
          createPendingPlan(books[0].bookWords[0].id),
          createPendingPlan(books[1].bookWords[0].id),
        ]);

        const masteredCareer = await reports.career(users[0].id);
        expect(masteredCareer.memory).toMatchObject({
          learningWords: 0,
          reviewingWords: 0,
          dueWords: 0,
          overdueWords: 0,
        });
        expect(masteredCareer.overview.learnedWords).toBe(2);

        const completedWhileMastered = await study.completeGroup(
          users[0].id,
          planForSecondBook.id,
          0,
          [{ bookWordId: books[1].bookWords[0].id, selectedAnswer: ['稳定的'] }],
        );
        expect(completedWhileMastered.status).toBe('COMPLETED');
        expect(
          await prisma.userMasteredWord.findUnique({
            where: { userId_wordId: { userId: users[0].id, wordId: word.id } },
          }),
        ).not.toBeNull();
        expect(
          await prisma.wordReviewAttempt.count({
            where: { userId: users[0].id, item: { planId: planForSecondBook.id } },
          }),
        ).toBe(1);
        await expect(vocabulary.getDashboardWords(users[0].id)).resolves.toMatchObject({
          reviewWords: [],
        });
        expect((await reports.career(users[0].id)).memory).toMatchObject({
          learningWords: 0,
          reviewingWords: 0,
          dueWords: 0,
          overdueWords: 0,
        });

        const otherLearnerCareer = await reports.career(users[1].id);
        expect(otherLearnerCareer.memory).toMatchObject({
          reviewingWords: 1,
          dueWords: 1,
          overdueWords: 1,
        });

        await vocabulary.removeMasteredWord(users[0].id, word.id);
        expect(
          await prisma.userMasteredWord.findUnique({
            where: { userId_wordId: { userId: users[0].id, wordId: word.id } },
          }),
        ).toBeNull();
        expect(
          await prisma.userWordProgress.findUnique({
            where: {
              userId_bookWordId: {
                userId: users[0].id,
                bookWordId: books[0].bookWords[0].id,
              },
            },
          }),
        ).toMatchObject({
          state: 'LEARNING',
          nextReviewAt: null,
          reviewCount: 4,
          totalAttempts: 6,
          correctAttempts: 3,
        });
        expect(
          await prisma.wordReviewAttempt.count({
            where: { userId: users[0].id, item: { planId: planForSecondBook.id } },
          }),
        ).toBe(1);
        await expect(vocabulary.getDashboardWords(users[0].id)).resolves.toMatchObject({
          reviewWords: [],
        });
        const resumableWords = await vocabulary.listLearningWords(users[0].id);
        expect(resumableWords).toHaveLength(2);
        expect(resumableWords).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: books[0].bookWords[0].id,
              state: 'LEARNING',
              reviewCount: 4,
              accuracy: 50,
            }),
            expect.objectContaining({
              id: books[1].bookWords[0].id,
              state: 'REVIEWING',
              reviewCount: 5,
              accuracy: 57,
            }),
          ]),
        );

        const resumedPlan = await study.completeGroup(users[0].id, planForFirstBook.id, 0, [
          { bookWordId: books[0].bookWords[0].id, selectedAnswer: ['稳定的'] },
        ]);
        expect(resumedPlan.status).toBe('COMPLETED');
        expect(
          await prisma.studyPlan.count({
            where: {
              id: { in: [planForFirstBook.id, planForSecondBook.id] },
              status: 'COMPLETED',
            },
          }),
        ).toBe(2);
        expect(
          await prisma.wordReviewAttempt.count({
            where: {
              userId: users[0].id,
              item: { planId: { in: [planForFirstBook.id, planForSecondBook.id] } },
            },
          }),
        ).toBe(2);
        expect(
          await prisma.userWordProgress.findUnique({
            where: {
              userId_bookWordId: {
                userId: users[0].id,
                bookWordId: books[0].bookWords[0].id,
              },
            },
          }),
        ).toMatchObject({
          state: 'REVIEWING',
          reviewCount: 5,
          totalAttempts: 7,
          correctAttempts: 4,
        });
        expect((await reports.career(users[0].id)).memory).toMatchObject({
          learningWords: 0,
          reviewingWords: 2,
          dueWords: 0,
          overdueWords: 0,
        });
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey: { in: sourceKeys } } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('does not reset a progress row changed after the pending-plan snapshot', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `mastery-race-${fixtureId}`;
      const normalized = `mastery-race-${fixtureId}`;
      let userId: string | undefined;
      try {
        const user = await prisma.user.create({
          data: {
            email: `mastery-race-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const word = await prisma.vocabularyWord.create({
          data: { normalized, text: 'steady', meaning: '稳定的' },
          select: { id: true },
        });
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Mastery race fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: { create: { wordId: word.id, position: 0 } },
          },
          select: { bookWords: { select: { id: true } } },
        });
        const bookWordId = book.bookWords[0].id;
        await prisma.userWordProgress.create({
          data: { userId: user.id, bookWordId, state: 'MASTERED', totalAttempts: 4 },
        });
        await prisma.userMasteredWord.create({ data: { userId: user.id, wordId: word.id } });
        const question = {
          type: 'MEANING_RECOGNITION',
          prompt: 'Choose the meaning of steady.',
          options: ['稳定的', '急促的'],
          correctAnswers: ['稳定的'],
          explanation: 'steady describes something stable or regular.',
        };
        await prisma.studyPlan.create({
          data: {
            userId: user.id,
            mode: 'GROUP',
            purpose: 'NORMAL',
            status: 'ACTIVE',
            generatedContent: {
              groups: [
                {
                  index: 0,
                  title: 'A steady pace',
                  wordOccurrences: { steady: 1 },
                  sentences: [],
                  questions: [{ ...question, bookWordId }],
                },
              ],
            },
            items: { create: { bookWordId, source: 'REVIEW', groupIndex: 0, question } },
          },
        });

        const racingPrisma = {
          $transaction: (callback: (tx: never) => Promise<unknown>) =>
            prisma.$transaction(async (tx) => {
              const userWordProgress = {
                findMany: async (...args: Parameters<typeof tx.userWordProgress.findMany>) => {
                  const rows = await tx.userWordProgress.findMany(...args);
                  if (rows.length) {
                    await prisma.userWordProgress.updateMany({
                      where: {
                        id: { in: rows.map((row) => row.id) },
                        state: 'MASTERED',
                      },
                      data: { state: 'REVIEWING', nextReviewAt: new Date(Date.now() + 86_400_000) },
                    });
                  }
                  return rows;
                },
                updateMany: tx.userWordProgress.updateMany.bind(tx.userWordProgress),
                deleteMany: tx.userWordProgress.deleteMany.bind(tx.userWordProgress),
              };
              return callback({ userMasteredWord: tx.userMasteredWord, userWordProgress } as never);
            }),
        };

        await new VocabularyService(racingPrisma as never).removeMasteredWord(user.id, word.id);
        await expect(
          prisma.userWordProgress.findUnique({
            where: { userId_bookWordId: { userId: user.id, bookWordId } },
          }),
        ).resolves.toMatchObject({ state: 'REVIEWING', totalAttempts: 4 });
        await expect(
          prisma.userMasteredWord.findUnique({
            where: { userId_wordId: { userId: user.id, wordId: word.id } },
          }),
        ).resolves.toBeNull();
        await expect(
          prisma.studyPlan.count({ where: { userId: user.id, status: 'ACTIVE' } }),
        ).resolves.toBe(1);
      } finally {
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized } });
        await prisma.$disconnect();
      }
    });
  },
);
