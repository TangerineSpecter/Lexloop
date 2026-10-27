import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
  },
);
