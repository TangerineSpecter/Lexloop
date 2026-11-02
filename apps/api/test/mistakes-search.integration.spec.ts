import { PrismaClient, WeaknessStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'mistake search in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('matches words, displayed meanings and book titles before paging, within the requesting user and filters', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const reader = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      clients.push(admin, reader);

      const fixtureId = randomUUID();
      const userIds: string[] = [];
      try {
        const createUser = async (name: string) => {
          const user = await admin.user.create({
            data: {
              email: `mistake-search-${fixtureId}-${name}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
            },
            select: { id: true },
          });
          userIds.push(user.id);
          return user;
        };
        const owner = await createUser('owner');
        const other = await createUser('other');
        const ownerBook = await admin.vocabularyBook.create({
          data: {
            ownerId: owner.id,
            kind: 'PERSONAL',
            sourceKey: `mistake-search-${fixtureId}-owner`,
            title: 'Everyday Stationery',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: Array.from({ length: 25 }, (_, index) => ({
                position: index,
                contextMeaning: index === 24 ? '文具盒' : null,
                word: {
                  create: {
                    normalized: `${fixtureId}-word-${index}`,
                    text: index === 24 ? 'pencil box' : `fixture-word-${index}`,
                    meaning: index === 24 ? '铅笔盒' : `示例释义 ${index}`,
                  },
                },
              })),
            },
          },
          select: { bookWords: { select: { id: true }, orderBy: { position: 'asc' } } },
        });
        const targetBookWordId = ownerBook.bookWords[24].id;
        const otherBook = await admin.vocabularyBook.create({
          data: {
            ownerId: other.id,
            kind: 'PERSONAL',
            sourceKey: `mistake-search-${fixtureId}-other`,
            title: 'Private phrase collection',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: {
                position: 0,
                word: {
                  create: {
                    normalized: `${fixtureId}-private`,
                    text: 'private phrase',
                    meaning: '仅供另一账号测试',
                  },
                },
              },
            },
          },
          select: { bookWords: { select: { id: true } } },
        });
        const now = new Date('2026-11-02T00:00:00.000Z');
        await admin.weaknessSignal.createMany({
          data: [
            ...ownerBook.bookWords.map((bookWord, index) => ({
              userId: owner.id,
              bookWordId: bookWord.id,
              questionType: 'MEANING_RECOGNITION',
              status: WeaknessStatus.ACTIVE,
              wrongCount: 2,
              consecutiveCorrect: index === 24 ? 5 : 0,
              lastWrongAt: now,
              lastAttemptAt: now,
            })),
            {
              userId: owner.id,
              bookWordId: targetBookWordId,
              questionType: 'WORD_MATCHING',
              status: WeaknessStatus.IGNORED,
              wrongCount: 1,
              consecutiveCorrect: 0,
              lastWrongAt: now,
              lastAttemptAt: now,
            },
            {
              userId: other.id,
              bookWordId: otherBook.bookWords[0].id,
              questionType: 'MEANING_RECOGNITION',
              status: WeaknessStatus.ACTIVE,
              wrongCount: 3,
              lastWrongAt: now,
              lastAttemptAt: now,
            },
          ],
        });

        const service = new MistakesService(reader as never);
        const wordMatch = await service.list(owner.id, {
          search: '  PENCIL   BOX  ',
          page: 1,
          pageSize: 20,
        });
        expect(wordMatch.total).toBe(1);
        expect(wordMatch.items.map((item) => item.bookWordId)).toEqual([targetBookWordId]);

        const chineseMeaningMatch = await service.list(owner.id, { search: '文具盒' });
        expect(chineseMeaningMatch.items.map((item) => item.bookWordId)).toEqual([
          targetBookWordId,
        ]);

        const fullSetMatch = await service.list(owner.id, {
          search: 'stationery',
          page: 1,
          pageSize: 20,
        });
        expect(fullSetMatch.total).toBe(25);
        expect(fullSetMatch.items).toHaveLength(20);
        const secondPage = await service.list(owner.id, {
          search: 'STATIONERY',
          page: 2,
          pageSize: 20,
        });
        expect(secondPage.total).toBe(25);
        expect(secondPage.items).toHaveLength(5);
        expect(secondPage.items.map((item) => item.bookWordId)).toContain(targetBookWordId);

        const filtered = await service.list(owner.id, {
          search: 'pencil box',
          questionType: 'WORD_MATCHING',
          status: 'ignored',
        });
        expect(filtered.total).toBe(1);
        expect(filtered.items[0].weaknesses.map((item) => item.questionType)).toEqual([
          'WORD_MATCHING',
        ]);

        const privateMatch = await service.list(owner.id, { search: 'private phrase' });
        expect(privateMatch.total).toBe(0);
        expect(privateMatch.items).toEqual([]);
      } finally {
        await admin.user.deleteMany({ where: { id: { in: userIds } } });
      }
    });
  },
);
