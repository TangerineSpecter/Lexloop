import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'system vocabulary catalog content completeness in an isolated database',
  () => {
    it('counts effective meanings per visible book in bounded queries without exposing personal books', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
        log: [{ emit: 'event', level: 'query' }],
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const sourceKeys = [
        `catalog-${fixtureId}-main`,
        `catalog-${fixtureId}-empty`,
        `catalog-${fixtureId}-started`,
        `catalog-${fixtureId}-personal`,
        ...Array.from({ length: 110 }, (_, index) => `catalog-${fixtureId}-bulk-${index}`),
      ];
      const normalizedWords = [
        ...Array.from({ length: 9 }, (_, index) => `catalog-${fixtureId}-edge-${index}`),
        ...Array.from({ length: 100 }, (_, index) => `catalog-${fixtureId}-bulk-word-${index}`),
      ];
      const systemFixtureKeys = sourceKeys.filter((sourceKey) => !sourceKey.endsWith('-personal'));
      let personalBookId: string | undefined;

      try {
        const users = await Promise.all(
          ['started', 'other'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `catalog-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map(({ id }) => id));

        const wordData = [
          {
            normalized: normalizedWords[0],
            text: 'known',
            meaning: '明确释义',
            ukPhonetic: 'nəʊn',
            usPhonetic: 'noʊn',
          },
          {
            normalized: normalizedWords[1],
            text: 'missing',
            meaning: null,
            ukPhonetic: null,
            usPhonetic: null,
          },
          {
            normalized: normalizedWords[2],
            text: 'contextual',
            meaning: null,
            ukPhonetic: 'kənˈtekstʃuəl',
            usPhonetic: 'kənˈtekstʃuəl',
          },
          {
            normalized: normalizedWords[3],
            text: 'blank',
            meaning: '',
            ukPhonetic: null,
            usPhonetic: 'blæŋk',
          },
          {
            normalized: normalizedWords[4],
            text: 'placeholder',
            meaning: '无',
            ukPhonetic: null,
            usPhonetic: null,
          },
          {
            normalized: normalizedWords[5],
            text: 'overridden',
            meaning: '有效的全局释义',
            ukPhonetic: 'ˌəʊvəˈrɪdn',
            usPhonetic: 'ˌoʊvərˈrɪdn',
          },
          {
            normalized: normalizedWords[6],
            text: 'empty-context',
            meaning: '有效的全局释义',
            ukPhonetic: 'ˈempti',
            usPhonetic: 'ˈempti',
          },
          {
            normalized: normalizedWords[7],
            text: 'whitespace-only',
            meaning: ' \n\t ',
            ukPhonetic: null,
            usPhonetic: null,
          },
          {
            normalized: normalizedWords[8],
            text: 'prefixed-placeholder',
            meaning: 'n. 无\nadj. 暂无释义',
            ukPhonetic: null,
            usPhonetic: null,
          },
          ...Array.from({ length: 100 }, (_, index) => ({
            normalized: normalizedWords[index + 9],
            text: `bulk-${index}`,
            meaning: index < 20 ? null : `测试释义${index}`,
            ukPhonetic: index < 20 ? null : `uk-${index}`,
            usPhonetic: index < 20 ? null : `us-${index}`,
          })),
        ];
        await prisma.vocabularyWord.createMany({ data: wordData });
        const words = await prisma.vocabularyWord.findMany({
          where: { normalized: { in: normalizedWords } },
          select: { id: true, normalized: true },
        });
        const wordIds = new Map(words.map(({ id, normalized }) => [normalized, id]));
        const bookRows = sourceKeys
          .filter((sourceKey) => !sourceKey.endsWith('-personal'))
          .map((sourceKey, index) => ({
            sourceKey,
            title:
              index === 0
                ? '内容统计边界词书'
                : index === 1
                  ? '空词书'
                  : index === 2
                    ? '已加入词书'
                    : `性能夹具词书 ${String(index - 2).padStart(3, '0')}`,
            sourcePath: 'isolated-catalog-fixture',
            category: 'GENERAL' as const,
            kind: 'SYSTEM' as const,
          }));
        await prisma.vocabularyBook.createMany({ data: bookRows });
        const createdBooks = await prisma.vocabularyBook.findMany({
          where: { sourceKey: { in: sourceKeys } },
          select: { id: true, sourceKey: true },
        });
        const bookIds = new Map(createdBooks.map(({ id, sourceKey }) => [sourceKey, id]));
        const associations = [];
        const mainBookId = bookIds.get(sourceKeys[0])!;
        const startedBookId = bookIds.get(sourceKeys[2])!;
        for (let index = 0; index < 9; index += 1) {
          associations.push({
            bookId: mainBookId,
            wordId: wordIds.get(normalizedWords[index])!,
            position: index,
            ...(index === 2 ? { contextMeaning: '本词书提供的语境释义' } : {}),
            ...(index === 5 ? { contextMeaning: '无' } : {}),
            ...(index === 6 ? { contextMeaning: '' } : {}),
          });
        }
        associations.push({
          bookId: startedBookId,
          wordId: wordIds.get(normalizedWords[1])!,
          position: 0,
        });
        for (let bookIndex = 0; bookIndex < 110; bookIndex += 1) {
          const bookId = bookIds.get(sourceKeys[bookIndex + 4])!;
          for (let wordIndex = 0; wordIndex < 100; wordIndex += 1) {
            associations.push({
              bookId,
              wordId: wordIds.get(normalizedWords[wordIndex + 9])!,
              position: wordIndex,
            });
          }
        }
        for (let index = 0; index < associations.length; index += 2_000) {
          await prisma.vocabularyBookWord.createMany({
            data: associations.slice(index, index + 2_000),
          });
        }

        await prisma.userVocabularyBook.create({
          data: { userId: users[0].id, bookId: startedBookId, isDefault: true },
        });
        const personalBook = await prisma.vocabularyBook.create({
          data: {
            sourceKey: sourceKeys[3],
            sourcePath: 'isolated-personal-catalog-fixture',
            title: '私有词书不应出现在系统目录',
            category: 'GENERAL',
            kind: 'PERSONAL',
            ownerId: users[0].id,
            bookWords: {
              create: {
                position: 0,
                word: { connect: { id: wordIds.get(normalizedWords[1])! } },
              },
            },
          },
        });
        personalBookId = personalBook.id;

        const queries: string[] = [];
        prisma.$on('query', (event) => queries.push(event.query));
        const service = new VocabularyService(prisma as never);

        const firstPageQueryStart = queries.length;
        const firstMissingPage = await service.listMissingMeaningSystemBookWords(mainBookId, 3);
        expect(queries.length - firstPageQueryStart).toBe(2);
        expect(firstMissingPage.book).toEqual({ id: mainBookId, title: '内容统计边界词书' });
        expect(firstMissingPage.items).toEqual([
          { position: 1, word: 'missing' },
          { position: 3, word: 'blank' },
          { position: 4, word: 'placeholder' },
        ]);
        expect(firstMissingPage.hasMore).toBe(true);
        expect(firstMissingPage.nextCursor).toBeTruthy();

        const secondMissingPage = await service.listMissingMeaningSystemBookWords(
          mainBookId,
          3,
          firstMissingPage.nextCursor!,
        );
        expect(secondMissingPage.items).toEqual([
          { position: 5, word: 'overridden' },
          { position: 6, word: 'empty-context' },
          { position: 7, word: 'whitespace-only' },
        ]);
        expect(secondMissingPage.hasMore).toBe(true);
        const lastMissingPage = await service.listMissingMeaningSystemBookWords(
          mainBookId,
          3,
          secondMissingPage.nextCursor!,
        );
        expect(lastMissingPage.items).toEqual([{ position: 8, word: 'prefixed-placeholder' }]);
        expect(lastMissingPage.hasMore).toBe(false);
        expect(lastMissingPage.nextCursor).toBeNull();
        await expect(
          service.listMissingMeaningSystemBookWords(startedBookId, 3, firstMissingPage.nextCursor!),
        ).rejects.toThrow('缺释义词列表游标无效');
        await expect(service.listMissingMeaningSystemBookWords(personalBookId!, 3)).rejects.toThrow(
          '系统词书不存在',
        );

        const learningBooksBefore = await prisma.userWordProgress.count({
          where: { userId: users[0].id },
        });
        const startedBooks = await service.listLearningBooks(users[0].id);
        expect(startedBooks.find((book) => book.id === startedBookId)).toMatchObject({
          isSystemBook: true,
          missingMeaningCount: 1,
        });
        expect(await prisma.userWordProgress.count({ where: { userId: users[0].id } })).toBe(
          learningBooksBefore,
        );

        const queryStart = queries.length;
        const startedAt = performance.now();
        const otherUserCatalog = await service.listSystemBooks(users[1].id);
        const durationMs = performance.now() - startedAt;
        const catalogQueries = queries.length - queryStart;
        expect(catalogQueries).toBe(4);
        expect(
          otherUserCatalog.books.filter((book) =>
            systemFixtureKeys.some((sourceKey) => book.id === bookIds.get(sourceKey)),
          ),
        ).toHaveLength(113);

        const main = otherUserCatalog.books.find((book) => book.id === mainBookId);
        expect(main).toMatchObject({
          isSystemBook: true,
          totalWords: 9,
          missingMeaningCount: 7,
        });
        const empty = otherUserCatalog.books.find((book) => book.id === bookIds.get(sourceKeys[1]));
        expect(empty).toMatchObject({ totalWords: 0, missingMeaningCount: 0 });
        const started = otherUserCatalog.books.find((book) => book.id === startedBookId);
        expect(started).toMatchObject({
          isSystemBook: true,
          totalWords: 1,
          missingMeaningCount: 1,
        });
        expect(
          otherUserCatalog.books.some(
            (book) => book.id === personalBookId || book.title.includes('私有词书'),
          ),
        ).toBe(false);
        const benchmark = otherUserCatalog.books.find(
          (book) => book.id === bookIds.get(sourceKeys[4]),
        );
        expect(benchmark).toMatchObject({ totalWords: 100, missingMeaningCount: 20 });
        console.info(
          `system vocabulary catalog: 113 books/11,010 associations, ${catalogQueries} database queries in ${durationMs.toFixed(1)} ms`,
        );

        const startedUserQueryStart = queries.length;
        const startedUserCatalog = await service.listSystemBooks(users[0].id, 'GENERAL');
        expect(queries.length - startedUserQueryStart).toBe(catalogQueries);
        expect(
          startedUserCatalog.books.filter((book) =>
            systemFixtureKeys.some((sourceKey) => book.id === bookIds.get(sourceKey)),
          ),
        ).toHaveLength(112);
        expect(startedUserCatalog.books.some((book) => book.id === startedBookId)).toBe(false);
        expect(startedUserCatalog.books.find((book) => book.id === mainBookId)).toMatchObject({
          totalWords: 9,
          missingMeaningCount: 7,
          isLearning: false,
          isDefault: false,
        });
      } finally {
        await prisma.userVocabularyBook.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey: { in: sourceKeys } } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalizedWords } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
