import { reviewedSupplementMeaning } from '../src/modules/vocabulary/supplement-meanings';
import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { importVersionedVocabularyBook } from '../src/modules/vocabulary/versioned-vocabulary-import';
import { normalizePhonetic } from '../src/modules/vocabulary/lexical';
import { describe, expect, it } from 'vitest';
import { withVocabularyCorrectionFixture } from './helpers/vocabulary-correction-fixture';
import {
  DAILY_SOURCE_KEY,
  DAILY_BOUNDARY_REVISION,
  DAILY_BOUNDARY_REPAIRS,
} from '../src/modules/vocabulary/daily-vocabulary-boundaries';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'versioned daily vocabulary boundary imports',
  () => {
    it('preserves the actual v1 position map and progress when v2 is installed, and v1 leaves a new v2 book intact', async () => {
      await withVocabularyCorrectionFixture(async ({ db, root, target, importer }) => {
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyBook.deleteMany();
        await db.vocabularyWord.deleteMany();
        await copyFile(join(process.cwd(), 'assets/vocabulary/通用/日常生活单词.xlsx'), target);
        const source = XLSX.readFile(target);
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
          source.Sheets[source.SheetNames[0]],
        );
        const originalRepairRows = new Set([7, 8, 12, 18, 24]);
        const missingToNull = (value: string) => (value === '无' ? null : value);
        const words = rows.flatMap((row, index) => {
          const repair = originalRepairRows.has(index + 2)
            ? DAILY_BOUNDARY_REPAIRS.find((entry) => entry.row === index + 2)
            : undefined;
          return (repair?.entries ?? [row['单词']]).map((text) => ({
            text,
            normalized: text.toLowerCase().replace(/\s+/g, ' '),
            meaning: missingToNull(row['释义']),
            ukPhonetic: normalizePhonetic(missingToNull(row['英音'])),
            usPhonetic: normalizePhonetic(missingToNull(row['美音'])),
          }));
        });
        expect(words).toHaveLength(1189);
        const prior = {
          sourceKey: DAILY_SOURCE_KEY,
          sourcePath: DAILY_SOURCE_KEY,
          sourceRevision: 'daily-boundaries-2026-11-03-v1',
          title: '日常生活单词',
          category: 'GENERAL' as const,
          publisher: null,
          grade: null,
          words,
        };
        await importVersionedVocabularyBook(db, prior);
        const association = await db.vocabularyBookWord.findFirstOrThrow({
          where: { word: { normalized: 'surname nickname' } },
        });
        await db.$executeRaw`INSERT INTO "UserWordProgress" ("id","userId","bookWordId","state","familiarity","nextReviewAt") VALUES ('v1-progress','test-owner',${association.id},'LEARNING',7,'2026-12-01')`;
        const snapshot = async () => ({
          books: await db.vocabularyBook.findMany({ orderBy: { id: 'asc' } }),
          words: await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } }),
          associations: await db.vocabularyBookWord.findMany({ orderBy: { position: 'asc' } }),
          progress: await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p ORDER BY id`,
        });
        const before = await snapshot();
        await Promise.all([importer.importVocabulary(root), importer.importVocabulary(root)]);
        expect(await snapshot()).toEqual(before);
        await db.$executeRaw`DELETE FROM "UserWordProgress"`;
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyBook.deleteMany();
        await db.vocabularyWord.deleteMany();
        await importer.importVocabulary(root);
        const current = await snapshot();
        expect(current.associations).toHaveLength(1245);
        expect(await importVersionedVocabularyBook(db, prior)).toBe('preserved');
        expect(await snapshot()).toEqual(current);
      });
    }, 30000);
    it('migrates the old schema but preserves legacy and personal books, associations and learning progress', async () => {
      await withVocabularyCorrectionFixture(async ({ db, importer, root }) => {
        // Exercise the actual additive migration with already imported legacy data.
        await db.$executeRawUnsafe('ALTER TABLE "VocabularyBook" DROP COLUMN "sourceRevision"');
        const sql = await readFile(
          join(
            process.cwd(),
            'prisma/migrations/20261103163000_vocabulary_source_revision/migration.sql',
          ),
          'utf8',
        );
        await db.$executeRawUnsafe(sql);
        const personal = await db.vocabularyBook.create({
          data: {
            sourceKey: 'personal-boundary-test',
            sourcePath: 'personal',
            kind: 'PERSONAL',
            ownerId: 'test-owner',
            category: 'GENERAL',
            title: '个人词书',
          },
        });
        const word = await db.vocabularyWord.create({
          data: {
            normalized: 'personal-boundary-test:born birth age sex',
            text: 'born birth age sex',
            meaning: '个人内容',
          },
        });
        const personalAssociation = await db.vocabularyBookWord.create({
          data: { bookId: personal.id, wordId: word.id, position: 1 },
        });
        const legacyAssociation = await db.vocabularyBookWord.findFirstOrThrow({
          where: { book: { sourceKey: DAILY_SOURCE_KEY } },
        });
        for (const a of [personalAssociation, legacyAssociation])
          await db.$executeRaw`INSERT INTO "UserWordProgress" ("id","userId","bookWordId","state","familiarity","nextReviewAt") VALUES (${a.id},'test-owner',${a.id},'LEARNING',3,'2026-12-01')`;
        const snapshot = async () => ({
          books: await db.vocabularyBook.findMany({ orderBy: { id: 'asc' } }),
          words: await db.vocabularyWord.findMany({ orderBy: { id: 'asc' } }),
          associations: await db.vocabularyBookWord.findMany({ orderBy: { id: 'asc' } }),
          progress: await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p ORDER BY id`,
        });
        const before = await snapshot();
        await Promise.all([importer.importVocabulary(root), importer.importVocabulary(root)]);
        expect(await snapshot()).toEqual(before);
        expect(
          (await db.vocabularyBook.findUniqueOrThrow({ where: { sourceKey: DAILY_SOURCE_KEY } }))
            .sourceRevision,
        ).toBeNull();
      });
    }, 30000);
    it('preserves cross-book field merging while keeping versioned associations atomic', async () => {
      await withVocabularyCorrectionFixture(async ({ db, root, target, importer }) => {
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyBook.deleteMany();
        await db.vocabularyWord.deleteMany();
        await copyFile(join(process.cwd(), 'assets/vocabulary/通用/日常生活单词.xlsx'), target);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
          workbook,
          XLSX.utils.aoa_to_sheet([
            ['单词', '英音', '美音', '释义'],
            ['spell', '无', '无', '无'],
          ]),
          'Sheet1',
        );
        XLSX.writeFile(workbook, join(root, '通用/另一本.xlsx'));
        await importer.importVocabulary(root);
        const source = XLSX.readFile(target);
        const expected = XLSX.utils.sheet_to_json<Record<string, string>>(
          source.Sheets[source.SheetNames[0]],
        )[0]['释义'];
        expect(
          (await db.vocabularyWord.findUniqueOrThrow({ where: { normalized: 'spell' } })).meaning,
        ).toBe(expected);
        expect(
          await db.vocabularyBookWord.count({ where: { book: { sourceKey: DAILY_SOURCE_KEY } } }),
        ).toBe(1245);
      });
    }, 30000);
    it('creates 1245 stable associations for a new book, preserves phrases and repeats concurrent imports without duplicates', async () => {
      await withVocabularyCorrectionFixture(async ({ db, root, target, importer }) => {
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyBook.deleteMany();
        await db.vocabularyWord.deleteMany();
        await copyFile(join(process.cwd(), 'assets/vocabulary/通用/日常生活单词.xlsx'), target);
        const bytes = await readFile(target);
        await Promise.all([importer.importVocabulary(root), importer.importVocabulary(root)]);
        const book = await db.vocabularyBook.findUniqueOrThrow({
          where: { sourceKey: DAILY_SOURCE_KEY },
        });
        expect(book.sourceRevision).toBe(DAILY_BOUNDARY_REVISION);
        const associations = await db.vocabularyBookWord.findMany({
          where: { bookId: book.id },
          orderBy: { position: 'asc' },
          include: { word: true },
        });
        expect(associations).toHaveLength(1245);
        expect(associations.map((a) => a.position)).toEqual(
          Array.from({ length: 1245 }, (_, i) => i + 1),
        );
        for (const r of DAILY_BOUNDARY_REPAIRS) {
          expect(associations.some((a) => a.word.text === r.original)).toBe(false);
          for (const word of r.entries)
            expect(associations.find((a) => a.word.text === word)?.word).toMatchObject({
              meaning: reviewedSupplementMeaning(word),
              ukPhonetic: null,
              usPhonetic: null,
            });
        }
        expect(associations.some((a) => a.word.text === 'human body')).toBe(true);
        await importer.importVocabulary(root);
        expect(
          await db.vocabularyBookWord.findMany({
            where: { bookId: book.id },
            orderBy: { position: 'asc' },
            include: { word: true },
          }),
        ).toEqual(associations);
        expect(await readFile(target)).toEqual(bytes);
        // An exposed incomplete revision from an older candidate is no longer resumed.
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyWord.deleteMany();
        await expect(importer.importVocabulary(root)).rejects.toThrow('association conflict');
        expect(await db.vocabularyBookWord.count({ where: { bookId: book.id } })).toBe(0);
        expect(await db.vocabularyWord.count()).toBe(0);
      });
    }, 30000);
  },
);
