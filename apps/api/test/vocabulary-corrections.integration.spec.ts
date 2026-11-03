import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { VocabularyCorrectionsService } from '../src/modules/vocabulary/vocabulary-corrections.service';
import { VocabularySeedService } from '../src/modules/vocabulary/vocabulary-seed.service';
import {
  VOCABULARY_CORRECTION_BATCH,
  VOCABULARY_CORRECTIONS,
} from '../src/modules/vocabulary/vocabulary-corrections.batch';

// A private schema containing the exact pre-upgrade tables, populated from the old
// XLSX before the new audit migration runs. No shared fixture names or production URLs.
describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'controlled vocabulary database upgrade',
  () => {
    it('previews, fills only untouched nulls, rolls back failures, restores safely, and keeps fresh installs idempotent', async () => {
      const admin = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const schema = 'vocab_correction_' + randomUUID().replaceAll('-', '');
      const url = new URL(process.env.LAB_TEST_DATABASE_URL!);
      url.searchParams.set('schema', schema);
      const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      const root = await mkdtemp(join(tmpdir(), 'lexloop-correction-'));
      try {
        await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        for (const type of [
          'LexicalItemType',
          'CefrLevel',
          'VocabularyCategory',
          'VocabularyBookKind',
        ]) {
          const labels = await admin.$queryRaw<
            Array<{ enumlabel: string }>
          >`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=${type} ORDER BY e.enumsortorder`;
          await admin.$executeRawUnsafe(
            `CREATE TYPE "${schema}"."${type}" AS ENUM (${labels.map((l) => "'" + l.enumlabel.replaceAll("'", "''") + "'").join(',')})`,
          );
        }
        for (const table of [
          'VocabularyWord',
          'VocabularyBook',
          'VocabularyBookWord',
          'UserWordProgress',
        ])
          await admin.$executeRawUnsafe(
            `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
          );
        for (const [table, column, type, defaultValue] of [
          ['VocabularyWord', 'itemType', 'LexicalItemType', 'WORD'],
          ['VocabularyWord', 'cefrLevel', 'CefrLevel', null],
          ['VocabularyBook', 'category', 'VocabularyCategory', null],
          ['VocabularyBook', 'kind', 'VocabularyBookKind', 'SYSTEM'],
        ]) {
          await admin.$executeRawUnsafe(
            `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${column}" DROP DEFAULT`,
          );
          await admin.$executeRawUnsafe(
            `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${column}" TYPE "${schema}"."${type}" USING "${column}"::text::"${schema}"."${type}"`,
          );
          if (defaultValue)
            await admin.$executeRawUnsafe(
              `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${column}" SET DEFAULT '${defaultValue}'`,
            );
        }
        await mkdir(join(root, '通用'));
        const target = join(root, '通用/日常生活单词.xlsx');
        await copyFile(
          join(process.cwd(), '../../data/vocabulary-candidates/2026-11-03/source-workbook.xlsx'),
          target,
        );
        const importer = new VocabularySeedService(db as never) as unknown as {
          importVocabulary: (root: string) => Promise<void>;
        };
        await importer.importVocabulary(root);
        const old = await db.vocabularyWord.findMany({
          where: { normalized: { in: VOCABULARY_CORRECTIONS.map((c) => c.word) } },
        });
        expect(old).toHaveLength(6);
        expect(old.every((w) => w.meaning === null)).toBe(true);
        // The actual shipped migration runs against an existing populated vocabulary schema.
        const migration = await readFile(
          join(
            process.cwd(),
            'prisma/migrations/20261103160000_vocabulary_correction_audit/migration.sql',
          ),
          'utf8',
        );
        await db.$transaction(async (tx) => {
          for (const sql of migration.split(';').filter((s) => s.trim()))
            await tx.$executeRawUnsafe(sql);
        });
        const service = new VocabularyCorrectionsService(db);
        const association = await db.vocabularyBookWord.findFirstOrThrow({
          where: { word: { normalized: 'moped' } },
        });
        await db.$executeRaw`INSERT INTO "UserWordProgress" ("id","userId","bookWordId","state","familiarity","reviewCount","nextReviewAt") VALUES ('fixture-progress','fixture-user',${association.id},'LEARNING',3,7,'2026-12-01T10:00:00Z')`;
        const progressBefore = await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`;
        const sourceBook = await db.vocabularyBook.findFirstOrThrow();
        await db.vocabularyBook.update({
          where: { id: sourceBook.id },
          data: { kind: 'PERSONAL', ownerId: 'fixture-user' },
        });
        expect((await service.preview()).actions.every((a) => a.reason === 'source-mismatch')).toBe(
          true,
        );
        await db.vocabularyBook.update({
          where: { id: sourceBook.id },
          data: { kind: 'SYSTEM', ownerId: null },
        });

        const before = await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } });
        const plan = await service.preview();
        expect(plan.fieldsToChange).toBe(12);
        const command = await promisify(execFile)(
          process.execPath,
          ['-r', 'ts-node/register', 'src/vocabulary-corrections.ts', 'preview'],
          {
            cwd: process.cwd(),
            env: { PATH: process.env.PATH, DATABASE_URL: url.toString() },
            timeout: 20000,
          },
        );
        expect(JSON.parse(command.stdout)).toMatchObject({ fieldsToChange: 12, token: plan.token });
        expect(await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
        expect(await db.vocabularyCorrectionAudit.count()).toBe(0);
        // Fail after earlier word updates/audits have begun: the entire batch must roll back.
        await db.$executeRawUnsafe(
          `ALTER TABLE "VocabularyCorrectionAudit" ADD CONSTRAINT "injected_failure" CHECK ("wordId" <> '${old.find((w) => w.text === 'crate')!.id}')`,
        );
        await expect(service.execute('apply', plan.token)).rejects.toThrow();
        expect(await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
        expect(await db.vocabularyCorrectionAudit.count()).toBe(0);
        await db.$executeRawUnsafe(
          'ALTER TABLE "VocabularyCorrectionAudit" DROP CONSTRAINT "injected_failure"',
        );
        // Preserve a user edit, an intentional empty-string value and a later explicit clearing.
        const edited = old.find((w) => w.text === 'backache')!;
        await db.vocabularyWord.update({
          where: { id: edited.id },
          data: { meaning: '用户释义', updatedAt: new Date(edited.updatedAt.getTime() + 1000) },
        });
        await expect(service.execute('apply', plan.token)).rejects.toThrow('stale');
        await db.vocabularyWord.update({
          where: { id: edited.id },
          data: { meaning: null, updatedAt: new Date(edited.updatedAt.getTime() + 2000) },
        });
        const brownie = old.find((w) => w.text === 'brownie')!;
        await db.vocabularyWord.update({
          where: { id: brownie.id },
          data: { meaning: '', updatedAt: brownie.createdAt },
        });
        const revised = await service.preview();
        expect(revised.actions.find((a) => a.word === 'backache')?.reason).toBe('edited-word');
        expect(revised.actions.find((a) => a.word === 'brownie')?.changes).toEqual({
          ukPhonetic: 'ˈbɹaʊni',
          usPhonetic: 'ˈbɹaʊni',
        });
        const concurrent = await Promise.allSettled([
          service.execute('apply', revised.token),
          service.execute('apply', revised.token),
        ]);
        expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(concurrent.find((r) => r.status === 'fulfilled')).toMatchObject({
          value: { changedWords: 5, changedFields: 10 },
        });
        expect(await db.vocabularyCorrectionAudit.count()).toBe(5);
        const replay = await service.preview();
        expect(replay.fieldsToChange).toBe(0);
        expect(await service.execute('apply', replay.token)).toMatchObject({ changedWords: 0 });
        // A user's post-apply edit prevents restoration of the whole word, even other fields.
        const moped = await db.vocabularyWord.findUniqueOrThrow({ where: { normalized: 'moped' } });
        await db.vocabularyWord.update({
          where: { id: moped.id },
          data: { meaning: '用户后来修改', updatedAt: new Date(moped.updatedAt.getTime() + 1000) },
        });
        const restore = await service.preview('restore');
        const beforeRestore = await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } });
        await db.$executeRawUnsafe(
          `ALTER TABLE "VocabularyCorrectionAudit" ADD CONSTRAINT "restore_failure" CHECK ("state" <> 'RESTORED')`,
        );
        await expect(service.execute('restore', restore.token)).rejects.toThrow();
        expect(await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } })).toEqual(beforeRestore);
        expect(await db.vocabularyCorrectionAudit.count({ where: { state: 'RESTORED' } })).toBe(0);
        await db.$executeRawUnsafe(
          'ALTER TABLE "VocabularyCorrectionAudit" DROP CONSTRAINT "restore_failure"',
        );
        expect(restore.actions.find((a) => a.word === 'moped')?.reason).toBe('edited-after-apply');
        expect(await service.execute('restore', restore.token)).toMatchObject({
          changedWords: 4,
          changedFields: 7,
        });
        expect(
          (await db.vocabularyWord.findUniqueOrThrow({ where: { id: moped.id } })).meaning,
        ).toBe('用户后来修改');
        expect((await service.preview()).fieldsToChange).toBe(0); // restored tombstones prevent refill
        const secondRestore = await service.preview('restore');
        expect(await service.execute('restore', secondRestore.token)).toMatchObject({
          changedWords: 0,
        });
        // Other 1171 entries and all book associations remain byte-for-byte equivalent.
        const otherIds = before.filter((w) => !old.some((o) => o.id === w.id)).map((w) => w.id);
        expect(
          await db.vocabularyWord.findMany({
            where: { id: { in: otherIds } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(before.filter((w) => otherIds.includes(w.id)));
        expect(await db.vocabularyBookWord.count()).toBe(1177);
        expect(await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`).toEqual(
          progressBefore,
        );
        // Fresh installation imports the corrected XLSX directly; no backfill audit required.
        await db.vocabularyCorrectionAudit.deleteMany();
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyBook.deleteMany();
        await db.vocabularyWord.deleteMany();
        await copyFile(join(process.cwd(), 'assets/vocabulary/通用/日常生活单词.xlsx'), target);
        await importer.importVocabulary(root);
        const fresh = await service.preview();
        expect(fresh.fieldsToChange).toBe(0);
        expect(fresh.actions.every((a) => a.reason === 'no-empty-fields')).toBe(true);
        expect(await service.execute('apply', fresh.token)).toMatchObject({ changedWords: 0 });
        await importer.importVocabulary(root);
        expect((await service.preview()).fieldsToChange).toBe(0);
        expect(
          await db.vocabularyCorrectionAudit.count({
            where: { batchId: VOCABULARY_CORRECTION_BATCH },
          }),
        ).toBe(0);
      } finally {
        await db.$disconnect();
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.$disconnect();
        await rm(root, { recursive: true, force: true });
      }
    }, 60000);
  },
);
