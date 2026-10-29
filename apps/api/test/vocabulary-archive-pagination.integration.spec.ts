import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VocabularyController } from '../src/modules/vocabulary/vocabulary.controller';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';

const ROWS_PER_ARCHIVE = 5_000;
const PAGE_SIZE = 50;

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'personal vocabulary archive pagination in an isolated database',
  () => {
    it('pages large learning and mastered archives deterministically without mixing accounts or breaking legacy array clients', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const bookId = `archive-book-${fixtureId}`;
      const prefix = `archive-${fixtureId}`;
      const users: Array<{ id: string }> = [];
      const wordId = (kind: 'learning' | 'mastered', index: number) =>
        `${prefix}-word-${kind}-${String(index).padStart(5, '0')}`;
      const bookWordId = (index: number) => `${prefix}-book-word-${String(index).padStart(5, '0')}`;
      const masteredAt = new Date('2026-01-15T12:30:00.000Z');
      const reviewAt = new Date('2026-01-10T08:00:00.000Z');
      const chunks = <T>(items: T[], size: number) =>
        Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
          items.slice(index * size, (index + 1) * size),
        );

      try {
        users.push(
          ...(await Promise.all(
            ['owner', 'other'].map((suffix) =>
              prisma.user.create({
                data: {
                  email: `${prefix}-${suffix}@example.invalid`,
                  passwordHash: 'isolated-test-fixture',
                },
                select: { id: true },
              }),
            ),
          )),
        );
        userIds.push(...users.map((user) => user.id));
        await prisma.vocabularyBook.create({
          data: {
            id: bookId,
            sourceKey: `${prefix}-source`,
            category: 'GENERAL',
            title: 'Archive pagination fixture',
            sourcePath: 'isolated-test',
            kind: 'SYSTEM',
          },
        });
        await prisma.userVocabularyBook.create({
          data: { userId: users[0].id, bookId },
        });

        const wordRows = [
          ...Array.from({ length: ROWS_PER_ARCHIVE }, (_, index) => ({
            id: wordId('learning', index),
            normalized: `${prefix}-normalized-learning-${String(index).padStart(5, '0')}`,
            text: `learning${String(index).padStart(5, '0')}`,
            meaning: '学习档案测试词',
          })),
          ...Array.from({ length: ROWS_PER_ARCHIVE }, (_, index) => ({
            id: wordId('mastered', index),
            normalized: `${prefix}-normalized-mastered-${String(index).padStart(5, '0')}`,
            text: `mastered${String(index).padStart(5, '0')}`,
            meaning: '掌握档案测试词',
          })),
        ];
        for (const chunk of chunks(wordRows, 500)) {
          await prisma.vocabularyWord.createMany({ data: chunk });
        }
        for (const chunk of chunks(
          Array.from({ length: ROWS_PER_ARCHIVE * 2 }, (_, index) => {
            const mastered = index >= ROWS_PER_ARCHIVE;
            const rowIndex = mastered ? index - ROWS_PER_ARCHIVE : index;
            return {
              id: bookWordId(index),
              bookId,
              wordId: wordId(mastered ? 'mastered' : 'learning', rowIndex),
              position: index,
            };
          }),
          500,
        )) {
          await prisma.vocabularyBookWord.createMany({ data: chunk });
        }
        for (const chunk of chunks(
          Array.from({ length: ROWS_PER_ARCHIVE }, (_, index) => ({
            id: `${prefix}-progress-${String(index).padStart(5, '0')}`,
            userId: users[0].id,
            bookWordId: bookWordId(index),
            state: 'LEARNING' as const,
            nextReviewAt: index < ROWS_PER_ARCHIVE / 2 ? reviewAt : null,
          })),
          500,
        )) {
          await prisma.userWordProgress.createMany({ data: chunk });
        }
        for (const chunk of chunks(
          Array.from({ length: ROWS_PER_ARCHIVE }, (_, index) => ({
            id: `${prefix}-mastery-${String(index).padStart(5, '0')}`,
            userId: users[0].id,
            wordId: wordId('mastered', index),
            masteredAt,
          })),
          500,
        )) {
          await prisma.userMasteredWord.createMany({ data: chunk });
        }
        await prisma.userMasteredWord.create({
          data: { userId: users[1].id, wordId: wordId('mastered', 0), masteredAt },
        });

        const service = new VocabularyService(prisma as never);
        const controller = new VocabularyController(service);
        const startedAt = performance.now();
        const pageDurations: number[] = [];

        const collect = async <T extends { id: string }>(
          load: (cursor?: string) => Promise<{
            items: T[];
            total: number;
            nextCursor: string | null;
          }>,
          expectedCount: number,
        ) => {
          const ids: string[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          let pageCount = 0;
          let total = 0;
          do {
            const pageStartedAt = performance.now();
            const page = await load(cursor);
            pageDurations.push(performance.now() - pageStartedAt);
            pageCount += 1;
            total = page.total;
            expect(page.items.length).toBeLessThanOrEqual(PAGE_SIZE);
            ids.push(...page.items.map((item) => item.id));
            if (page.nextCursor) {
              expect(cursors.has(page.nextCursor)).toBe(false);
              cursors.add(page.nextCursor);
              cursor = page.nextCursor;
            } else {
              cursor = undefined;
            }
          } while (cursor);
          expect(total).toBe(expectedCount);
          expect(ids).toHaveLength(expectedCount);
          expect(new Set(ids).size).toBe(expectedCount);
          expect(pageCount).toBe(Math.ceil(expectedCount / PAGE_SIZE));
          return ids;
        };

        const learningIds = await collect(async (cursor) => {
          const page = await service.listLearningWords(users[0].id, {
            pageSize: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
          if (Array.isArray(page))
            throw new Error('Paginated learning request returned legacy array');
          return page;
        }, ROWS_PER_ARCHIVE);
        const expectedLearningIds = [
          ...Array.from({ length: ROWS_PER_ARCHIVE / 2 }, (_, index) => bookWordId(index)),
          ...Array.from({ length: ROWS_PER_ARCHIVE / 2 }, (_, index) =>
            bookWordId(ROWS_PER_ARCHIVE / 2 + index),
          ),
        ];
        expect(learningIds).toEqual(expectedLearningIds);

        const masteredIds = await collect(
          (cursor) =>
            service.listMasteredWordsPage(users[0].id, {
              pageSize: PAGE_SIZE,
              ...(cursor ? { cursor } : {}),
            }),
          ROWS_PER_ARCHIVE,
        );
        expect(masteredIds).toEqual(
          Array.from({ length: ROWS_PER_ARCHIVE }, (_, index) =>
            wordId('mastered', ROWS_PER_ARCHIVE - index - 1),
          ),
        );

        const firstMasteredPage = await service.listMasteredWordsPage(users[0].id, {
          pageSize: PAGE_SIZE,
        });
        await expect(
          service.listMasteredWordsPage(users[1].id, {
            pageSize: PAGE_SIZE,
            cursor: firstMasteredPage.nextCursor!,
          }),
        ).rejects.toThrow('词汇档案游标无效');
        await expect(
          service.listMasteredWordsPage(users[0].id, { pageSize: PAGE_SIZE, cursor: 'bad!' }),
        ).rejects.toThrow('词汇档案游标无效');
        await expect(
          service.listMasteredWordsPage(users[0].id, {
            pageSize: PAGE_SIZE,
            cursor: firstMasteredPage.nextCursor!.slice(0, -1),
          }),
        ).rejects.toThrow('词汇档案游标无效');
        const otherAccountPage = await service.listMasteredWordsPage(users[1].id, {
          pageSize: PAGE_SIZE,
        });
        expect(otherAccountPage).toMatchObject({
          total: 1,
          items: [{ id: wordId('mastered', 0) }],
          nextCursor: null,
        });
        await expect(
          controller.learningWords({ user: { sub: users[0].id } }, undefined, undefined),
        ).resolves.toHaveLength(ROWS_PER_ARCHIVE);
        await expect(
          controller.mastered({ user: { sub: users[0].id } }, undefined, undefined),
        ).resolves.toHaveLength(ROWS_PER_ARCHIVE);
        expect(() => controller.mastered({ user: { sub: users[0].id } }, '101')).toThrow(
          '每页数量必须是 1 到 100 的整数',
        );

        const elapsedMs = Math.round(performance.now() - startedAt);
        const averagePageMs = Math.round(
          pageDurations.reduce((sum, duration) => sum + duration, 0) / pageDurations.length,
        );
        const slowestPageMs = Math.round(Math.max(...pageDurations));
        process.stdout.write(
          `Vocabulary archive pages: ${ROWS_PER_ARCHIVE} learning + ${ROWS_PER_ARCHIVE} mastered records, ${PAGE_SIZE}-item pages, 200 page reads with count queries in ${elapsedMs}ms (average ${averagePageMs}ms, slowest ${slowestPageMs}ms); stable ties, NULLS LAST, cross-account cursor rejection, scoped counts, malformed cursor and legacy arrays verified.\n`,
        );
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { startsWith: prefix } } });
        await prisma.$disconnect();
      }
    }, 120_000);

    it('applies the exact added indexes without changing pre-existing archive rows', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const migration = await readFile(
        resolve(
          process.cwd(),
          'prisma/migrations/20261029140000_vocabulary_archive_cursor_indexes/migration.sql',
        ),
        'utf8',
      );
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE "UserWordProgress" ("userId" TEXT, "nextReviewAt" TIMESTAMP, "bookWordId" TEXT) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE "UserMasteredWord" ("userId" TEXT, "masteredAt" TIMESTAMP, "wordId" TEXT) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO \"UserWordProgress\" VALUES ('fixture-user', '2026-01-01T00:00:00Z', 'fixture-book-word')",
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO \"UserMasteredWord\" VALUES ('fixture-user', '2026-01-02T00:00:00Z', 'fixture-word')",
          );
          for (const statement of migration
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)) {
            await tx.$executeRawUnsafe(statement);
          }
          const [progressRows, masteredRows] = await Promise.all([
            tx.$queryRawUnsafe<Array<{ userId: string; bookWordId: string }>>(
              'SELECT "userId", "bookWordId" FROM "UserWordProgress"',
            ),
            tx.$queryRawUnsafe<Array<{ userId: string; wordId: string }>>(
              'SELECT "userId", "wordId" FROM "UserMasteredWord"',
            ),
          ]);
          const indexes = await tx.$queryRaw<Array<{ indexname: string }>>`
            SELECT c.relname AS indexname
            FROM pg_class c
            JOIN pg_index i ON i.indexrelid = c.oid
            JOIN pg_class t ON i.indrelid = t.oid
            WHERE c.relnamespace = pg_my_temp_schema()
              AND t.relname IN ('UserWordProgress', 'UserMasteredWord')
          `;
          expect(progressRows).toEqual([
            { userId: 'fixture-user', bookWordId: 'fixture-book-word' },
          ]);
          expect(masteredRows).toEqual([{ userId: 'fixture-user', wordId: 'fixture-word' }]);
          expect(indexes.map((index) => index.indexname)).toEqual(
            expect.arrayContaining([
              'UserWordProgress_userId_nextReviewAt_bookWordId_idx',
              'UserMasteredWord_userId_masteredAt_wordId_idx',
            ]),
          );
        });
      } finally {
        await prisma.$disconnect();
      }
    });
  },
);
