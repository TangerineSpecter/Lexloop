import { Prisma, PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { VocabularyCorrectionsService } from '../src/modules/vocabulary/vocabulary-corrections.service';
import { withVocabularyCorrectionFixture } from './helpers/vocabulary-correction-fixture';

function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function waitForLock(admin: PrismaClient, pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await admin.$queryRaw<
      Array<{ wait_event_type: string | null }>
    >`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
    if (rows[0]?.wait_event_type === 'Lock') return;
    await delay(20);
  }
  throw new Error('Expected a database lock wait at the barrier');
}
// Instrument only the client boundary. All reads, row locks, updates, constraints and
// commits remain real PostgreSQL operations; production code needs no test hook.
function checkpointClient(
  db: PrismaClient,
  checkpoint: { afterRead?: () => Promise<void>; beforeLock?: (pid: number) => void },
) {
  return {
    $transaction: <T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
    ) =>
      db.$transaction(async (tx) => {
        const wrapped = new Proxy(tx, {
          get(target, key) {
            if (key === 'vocabularyCorrectionAudit' && checkpoint.afterRead)
              return new Proxy(target.vocabularyCorrectionAudit, {
                get(delegate, method) {
                  if (method === 'findMany')
                    return async (args: Prisma.VocabularyCorrectionAuditFindManyArgs) => {
                      const rows = await delegate.findMany(args);
                      await checkpoint.afterRead!();
                      return rows;
                    };
                  return Reflect.get(delegate, method);
                },
              });
            if (key === '$queryRaw' && checkpoint.beforeLock)
              return async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
                const [{ pid }] = await target.$queryRaw<
                  Array<{ pid: number }>
                >`SELECT pg_backend_pid() AS pid`;
                checkpoint.beforeLock!(pid);
                return target.$queryRaw(query, ...values);
              };
            return Reflect.get(target, key);
          },
        });
        return run(wrapped);
      }, options),
  } as unknown as PrismaClient;
}

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'vocabulary backfill concurrency barriers',
  () => {
    it('lets an edit waiting behind backfill commit afterwards and prevents restore from overwriting it', async () => {
      await withVocabularyCorrectionFixture(async ({ db, admin, old }) => {
        const service = new VocabularyCorrectionsService(db);
        const plan = await service.preview();
        const read = latch(),
          release = latch(),
          writerPid = latch<number>();
        const paused = new VocabularyCorrectionsService(
          checkpointClient(db, {
            afterRead: async () => {
              read.resolve();
              await release.promise;
            },
          }),
        );
        const applying = paused.execute('apply', plan.token);
        let writing: Promise<unknown> | undefined;
        try {
          await read.promise; // final plan read, with all target word locks held
          writing = db.$transaction(
            async (tx) => {
              const [{ pid }] = await tx.$queryRaw<
                Array<{ pid: number }>
              >`SELECT pg_backend_pid() AS pid`;
              writerPid.resolve(pid);
              return tx.vocabularyWord.update({
                where: { id: old.find((w) => w.text === 'moped')!.id },
                data: { meaning: '并发用户修改' },
              });
            },
            { timeout: 15000 },
          );
          await waitForLock(admin, await writerPid.promise);
          release.resolve();
          expect(await applying).toMatchObject({ changedWords: 6, changedFields: 12 });
          await writing;
          expect(
            (await db.vocabularyWord.findUniqueOrThrow({ where: { normalized: 'moped' } })).meaning,
          ).toBe('并发用户修改');
          expect(
            (await service.preview('restore')).actions.find((a) => a.word === 'moped')?.reason,
          ).toBe('edited-after-apply');
          expect(await db.vocabularyCorrectionAudit.count()).toBe(6);
        } finally {
          release.resolve();
          await Promise.allSettled([applying, ...(writing ? [writing] : [])]);
        }
      });
    }, 30000);

    it('rejects backfill if an earlier uncommitted user edit wins the word lock', async () => {
      await withVocabularyCorrectionFixture(async ({ db, admin, old }) => {
        const service = new VocabularyCorrectionsService(db);
        const plan = await service.preview();
        const edited = latch(),
          release = latch(),
          backfillPid = latch<number>();
        const writing = db.$transaction(
          async (tx) => {
            await tx.vocabularyWord.update({
              where: { id: old.find((w) => w.text === 'moped')!.id },
              data: { meaning: '先取得锁的用户修改' },
            });
            edited.resolve();
            await release.promise;
          },
          { timeout: 15000 },
        );
        let applying: Promise<unknown> | undefined;
        try {
          await edited.promise;
          const paused = new VocabularyCorrectionsService(
            checkpointClient(db, { beforeLock: (pid) => backfillPid.resolve(pid) }),
          );
          applying = paused.execute('apply', plan.token);
          const result = applying.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
          await waitForLock(admin, await backfillPid.promise);
          release.resolve();
          await writing;
          const outcome = await result;
          expect(outcome.ok).toBe(false);
          if (!outcome.ok)
            expect(outcome.error).toMatchObject({ code: 'P2010', meta: { code: '40001' } });
          expect(
            (await db.vocabularyWord.findUniqueOrThrow({ where: { normalized: 'moped' } })).meaning,
          ).toBe('先取得锁的用户修改');
          expect(await db.vocabularyCorrectionAudit.count()).toBe(0);
          const next = await service.preview();
          expect(next.actions.find((a) => a.word === 'moped')?.reason).toBe('edited-word');
        } finally {
          release.resolve();
          await Promise.allSettled([writing, ...(applying ? [applying] : [])]);
        }
      });
    }, 30000);

    it('allows a source unlink after the backfill snapshot to serialize after backfill instead of promising rejection', async () => {
      await withVocabularyCorrectionFixture(async ({ db }) => {
        const service = new VocabularyCorrectionsService(db);
        const plan = await service.preview();
        const read = latch(),
          release = latch();
        const paused = new VocabularyCorrectionsService(
          checkpointClient(db, {
            afterRead: async () => {
              read.resolve();
              await release.promise;
            },
          }),
        );
        const applying = paused.execute('apply', plan.token);
        try {
          await read.promise;
          const association = await db.vocabularyBookWord.findFirstOrThrow({
            where: { word: { normalized: 'moped' } },
          });
          // This transaction writes only the association, not the locked word. There is no
          // dependency cycle: both SERIALIZABLE transactions may commit, ordered backfill -> unlink.
          await db.$transaction(
            (tx) => tx.vocabularyBookWord.delete({ where: { id: association.id } }),
            { isolationLevel: 'Serializable' },
          );
          expect(await db.vocabularyBookWord.count({ where: { id: association.id } })).toBe(0);
          release.resolve();
          expect(await applying).toMatchObject({ changedWords: 6, changedFields: 12 });
          expect(
            (await db.vocabularyWord.findUniqueOrThrow({ where: { normalized: 'moped' } })).meaning,
          ).toBe('n. 摩托自行车');
          expect(await db.vocabularyCorrectionAudit.count()).toBe(6);
          expect(await db.vocabularyBookWord.count({ where: { id: association.id } })).toBe(0);
        } finally {
          release.resolve();
          await Promise.allSettled([applying]);
        }
      });
    }, 30000);
  },
);
