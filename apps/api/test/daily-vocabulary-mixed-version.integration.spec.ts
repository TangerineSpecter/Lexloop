import { Prisma, PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { VocabularySeedService } from '../src/modules/vocabulary/vocabulary-seed.service';
import { LegacyVocabularySeedService } from './fixtures/legacy-vocabulary-seed.service';
import { ReservedVocabularySeedService } from './fixtures/reserved-vocabulary-seed.service';
import { withVocabularyCorrectionFixture } from './helpers/vocabulary-correction-fixture';
import {
  DAILY_SOURCE_KEY,
  DAILY_BOUNDARY_REVISION,
} from '../src/modules/vocabulary/daily-vocabulary-boundaries';
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Importer = {
  importVocabulary: (root: string) => Promise<void>;
  readBook: (root: string, file: string) => { words: Array<{ normalized: string }> };
};
async function clear(db: PrismaClient) {
  await db.vocabularyBookWord.deleteMany();
  await db.vocabularyBook.deleteMany();
  await db.vocabularyWord.deleteMany();
}
const mappings = (db: PrismaClient) =>
  db.vocabularyBookWord.findMany({
    where: { book: { sourceKey: DAILY_SOURCE_KEY } },
    orderBy: { position: 'asc' },
    include: { word: true },
  });
async function waitLock(db: PrismaClient, pid: number) {
  for (let i = 0; i < 250; i++) {
    const rows = await db.$queryRaw<
      Array<{ wait_event_type: string | null }>
    >`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
    if (rows[0]?.wait_event_type === 'Lock') return;
    await delay(20);
  }
  throw new Error('Legacy writer did not wait for the real database lock');
}
// Used against both the frozen pre-fix top-level client and the fixed transaction client.
function pauseClient(
  db: PrismaClient,
  delegateKey: 'vocabularyBook' | 'vocabularyBookWord',
  methodKey: 'createMany' | 'upsert',
  hook: () => Promise<void>,
) {
  const wrap = (client: Prisma.TransactionClient) =>
    new Proxy(client, {
      get(target, key) {
        if (key === delegateKey)
          return new Proxy(Reflect.get(target, key), {
            get(delegate, method) {
              const value = Reflect.get(delegate, method);
              if (method === methodKey)
                return async (...args: unknown[]) => {
                  const result = await value.apply(delegate, args);
                  await hook();
                  return result;
                };
              return value;
            },
          });
        return Reflect.get(target, key);
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
        ) => db.$transaction((tx) => run(wrap(tx)), options);
      return Reflect.get(wrap(target), key);
    },
  });
}
describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('mixed-version daily imports', () => {
  it.each(['reservation', 'first-association-chunk'] as const)(
    'reproduces the pre-fix review candidate accepting a wrong map during %s',
    async (stage) => {
      await withVocabularyCorrectionFixture(async ({ db, root }) => {
        await clear(db);
        const reserved = latch(),
          release = latch();
        const candidate = new ReservedVocabularySeedService(
          pauseClient(
            db,
            stage === 'reservation' ? 'vocabularyBook' : 'vocabularyBookWord',
            'createMany',
            async () => {
              reserved.resolve();
              await release.promise;
            },
          ) as never,
        ) as unknown as Importer;
        const legacy = new LegacyVocabularySeedService(db as never) as unknown as Importer;
        const running = candidate.importVocabulary(root);
        try {
          await Promise.race([
            reserved.promise,
            running.then(() => {
              throw new Error('Import ended before barrier');
            }),
          ]);
          await legacy.importVocabulary(root);
          release.resolve();
          await running;
          const rows = await mappings(db);
          if (stage === 'reservation') {
            expect(rows).toHaveLength(1177);
            expect(rows[5].word.text).toBe('born birth age sex');
          } else {
            expect(rows[5].word.text).toBe('born');
            expect(rows.map((r) => r.word.normalized)).not.toEqual(
              candidate
                .readBook(root, root + '/通用/日常生活单词.xlsx')
                .words.map((w) => w.normalized),
            );
          }
          expect(
            (await db.vocabularyBook.findUniqueOrThrow({ where: { sourceKey: DAILY_SOURCE_KEY } }))
              .sourceRevision,
          ).toBe(DAILY_BOUNDARY_REVISION);
          console.log(
            `Pre-fix reproduction (${stage}): new revision + ${rows.length} wrong associations, importer reported success.`,
          );
        } finally {
          release.resolve();
          await Promise.allSettled([running]);
        }
      });
    },
    30000,
  );
  it.each(['reservation', 'first-association-chunk'] as const)(
    'publishes a complete map atomically when legacy overlaps %s',
    async (stage) => {
      await withVocabularyCorrectionFixture(async ({ db, admin, url, root, target }) => {
        await clear(db);
        const reached = latch(),
          release = latch();
        let calls = 0;
        const current = new VocabularySeedService(
          pauseClient(
            db,
            stage === 'reservation' ? 'vocabularyBook' : 'vocabularyBookWord',
            'createMany',
            async () => {
              if (calls++ === 0) {
                reached.resolve();
                await release.promise;
              }
            },
          ) as never,
        ) as unknown as Importer;
        const expected = current
          .readBook(root, target)
          .words.map((w, i) => ({ position: i + 1, normalized: w.normalized }));
        const legacyUrl = new URL(url);
        legacyUrl.searchParams.set('connection_limit', '1');
        const oldDb = new PrismaClient({ datasources: { db: { url: legacyUrl.toString() } } });
        const [{ pid }] = await oldDb.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        const legacy = new LegacyVocabularySeedService(oldDb as never) as unknown as Importer;
        const running = current.importVocabulary(root);
        let oldRun: Promise<void> | undefined;
        try {
          await Promise.race([
            reached.promise,
            running.then(() => {
              throw new Error('Import ended before barrier');
            }),
          ]);
          expect(await db.vocabularyBook.count({ where: { sourceKey: DAILY_SOURCE_KEY } })).toBe(0);
          expect(await db.vocabularyBookWord.count()).toBe(0);
          oldRun = legacy.importVocabulary(root);
          await waitLock(admin, pid);
          release.resolve();
          await running;
          await oldRun;
          expect(
            (await mappings(db)).map((r) => ({
              position: r.position,
              normalized: r.word.normalized,
            })),
          ).toEqual(expected);
          await legacy.importVocabulary(root);
          expect(
            (await mappings(db)).map((r) => ({
              position: r.position,
              normalized: r.word.normalized,
            })),
          ).toEqual(expected);
        } finally {
          release.resolve();
          await Promise.allSettled([running, ...(oldRun ? [oldRun] : [])]);
          await oldDb.$disconnect();
        }
      });
    },
    30000,
  );
  it('preserves a legacy book when the legacy upsert wins before its associations are written', async () => {
    await withVocabularyCorrectionFixture(async ({ db, root }) => {
      await clear(db);
      const reached = latch(),
        release = latch();
      const legacy = new LegacyVocabularySeedService(
        pauseClient(db, 'vocabularyBook', 'upsert', async () => {
          reached.resolve();
          await release.promise;
        }) as never,
      ) as unknown as Importer;
      const current = new VocabularySeedService(db as never) as unknown as Importer;
      const oldRun = legacy.importVocabulary(root);
      try {
        await Promise.race([
          reached.promise,
          oldRun.then(() => {
            throw new Error('Missing legacy barrier');
          }),
        ]);
        await current.importVocabulary(root);
        release.resolve();
        await oldRun;
        expect(await mappings(db)).toHaveLength(1177);
        expect(
          (await db.vocabularyBook.findUniqueOrThrow({ where: { sourceKey: DAILY_SOURCE_KEY } }))
            .sourceRevision,
        ).toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([oldRun]);
      }
    });
  }, 30000);
  it('rejects a pre-existing wrong map without deleting progress and rolls back an interrupted first import', async () => {
    await withVocabularyCorrectionFixture(async ({ db, root }) => {
      const book = await db.vocabularyBook.findUniqueOrThrow({
        where: { sourceKey: DAILY_SOURCE_KEY },
      });
      await db.vocabularyBook.update({
        where: { id: book.id },
        data: { sourceRevision: DAILY_BOUNDARY_REVISION },
      });
      const before = await mappings(db);
      const first = before[0];
      await db.$executeRaw`INSERT INTO "UserWordProgress" ("id","userId","bookWordId","familiarity") VALUES ('mixed-progress','test-user',${first.id},3)`;
      const current = new VocabularySeedService(db as never) as unknown as Importer;
      await expect(current.importVocabulary(root)).rejects.toThrow('association conflict');
      expect(await mappings(db)).toEqual(before);
      expect(
        await db.$queryRaw`SELECT familiarity FROM "UserWordProgress" WHERE id='mixed-progress'`,
      ).toEqual([{ familiarity: 3 }]);
      await clear(db);
      const interrupted = new VocabularySeedService(
        pauseClient(db, 'vocabularyBookWord', 'createMany', async () => {
          throw new Error('Injected import failure');
        }) as never,
      ) as unknown as Importer;
      await expect(interrupted.importVocabulary(root)).rejects.toThrow('Injected import failure');
      expect(await db.vocabularyBook.count()).toBe(0);
      expect(await db.vocabularyBookWord.count()).toBe(0);
      expect(await db.vocabularyWord.count()).toBe(0);
      await current.importVocabulary(root);
      expect(await mappings(db)).toHaveLength(1189);
    });
  }, 30000);
});
