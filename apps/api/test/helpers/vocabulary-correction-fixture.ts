import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import * as XLSX from 'xlsx';
import { normalizePhonetic } from '../../src/modules/vocabulary/lexical';
import { VocabularySeedService } from '../../src/modules/vocabulary/vocabulary-seed.service';
import { VOCABULARY_CORRECTIONS } from '../../src/modules/vocabulary/vocabulary-corrections.batch';

export async function withVocabularyCorrectionFixture(
  run: (fixture: {
    db: PrismaClient;
    admin: PrismaClient;
    schema: string;
    url: URL;
    root: string;
    target: string;
    importer: { importVocabulary: (root: string) => Promise<void> };
    old: Awaited<ReturnType<PrismaClient['vocabularyWord']['findMany']>>;
  }) => Promise<void>,
) {
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
    // Preserve the production relationships involved in the lock/unlink tests.
    await db.$executeRawUnsafe(
      'ALTER TABLE "VocabularyBookWord" ADD FOREIGN KEY ("wordId") REFERENCES "VocabularyWord"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    await db.$executeRawUnsafe(
      'ALTER TABLE "VocabularyBookWord" ADD FOREIGN KEY ("bookId") REFERENCES "VocabularyBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    await db.$executeRawUnsafe(
      'ALTER TABLE "UserWordProgress" ADD FOREIGN KEY ("bookWordId") REFERENCES "VocabularyBookWord"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    await mkdir(join(root, '通用'));
    const target = join(root, '通用/日常生活单词.xlsx');
    await copyFile(
      join(process.cwd(), '../../data/vocabulary-candidates/2026-11-03/source-workbook.xlsx'),
      target,
    );
    const importer = new VocabularySeedService(db as never) as unknown as {
      importVocabulary: (root: string) => Promise<void>;
    };
    // Reproduce the legacy importer without running today's boundary repair.
    const legacyWorkbook = XLSX.readFile(target);
    const legacyRows = XLSX.utils.sheet_to_json<Record<string, string>>(
      legacyWorkbook.Sheets[legacyWorkbook.SheetNames[0]],
      { defval: '' },
    );
    const legacyBook = await db.vocabularyBook.create({
      data: {
        sourceKey: '通用/日常生活单词.xlsx',
        sourcePath: '通用/日常生活单词.xlsx',
        category: 'GENERAL',
        title: '日常生活单词',
      },
    });
    await db.vocabularyWord.createMany({
      data: legacyRows.map((r) => ({
        text: r['单词'],
        normalized: r['单词'].trim().toLowerCase().replace(/\s+/g, ' '),
        meaning: r['释义'] === '无' ? null : r['释义'],
        ukPhonetic: normalizePhonetic(r['英音']),
        usPhonetic: normalizePhonetic(r['美音']),
      })),
    });
    const legacyWords = await db.vocabularyWord.findMany();
    await db.vocabularyBookWord.createMany({
      data: legacyRows.map((r, i) => ({
        bookId: legacyBook.id,
        wordId: legacyWords.find((w) => w.text === r['单词'])!.id,
        position: i + 1,
      })),
    });
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
    await run({ db, admin, schema, url, root, target, importer, old });
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}
