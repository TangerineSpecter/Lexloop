import { DAILY_USAGE_NOTES } from '../src/modules/vocabulary/daily-usage-notes';
import { DAILY_CONTEXT_ADDITIONS } from '../src/modules/vocabulary/daily-context';
import { DAILY_ENRICHMENTS } from '../src/modules/vocabulary/daily-enrichment';
import { USAGE_CLARITY_CORRECTIONS } from '../src/modules/vocabulary/usage-clarity-corrections';
import { VERB_SENSE_CORRECTIONS } from '../src/modules/vocabulary/verb-sense-corrections';
import { EXISTING_POS_CORRECTIONS } from '../src/modules/vocabulary/existing-pos-corrections';
import type { VocabularyWord } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SUPPLEMENT_MEANINGS,
  SUPPLEMENT_MEANING_BATCH,
} from '../src/modules/vocabulary/supplement-meanings';
import { DAILY_SUPPLEMENT_WORDS } from '../src/modules/vocabulary/supplement-eligibility';
import {
  VocabularyCorrectionsService,
  SUPPLEMENT_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';
import { withVocabularyCorrectionFixture } from './helpers/vocabulary-correction-fixture';

const assets = join(process.cwd(), 'assets/vocabulary');
describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'reviewed supplemental meanings on real PostgreSQL',
  () => {
    it('seeds all shipped books into a fresh isolated schema with 91 of 92 non-placeholder candidate meanings', async () => {
      await withVocabularyCorrectionFixture(async ({ db, schema, importer }) => {
        expect(schema.startsWith('vocab_correction_')).toBe(true);
        // Only the synthetic fixture schema is reset; public test tables and all real data are untouched.
        await db.vocabularyBookWord.deleteMany();
        await db.vocabularyBook.deleteMany();
        await db.vocabularyWord.deleteMany();
        await importer.importVocabulary(assets);
        const words = await db.vocabularyWord.findMany({
          where: { normalized: { in: DAILY_SUPPLEMENT_WORDS } },
        });
        expect(words).toHaveLength(92);
        expect(
          words.filter((word) => word.meaning && !['无', '暂无释义'].includes(word.meaning)),
        ).toHaveLength(91);
        expect(words.filter((word) => !word.meaning).map((word) => word.normalized)).toEqual([
          'sexuality',
        ]);
        for (const entry of SUPPLEMENT_MEANINGS)
          expect(words.find((word) => word.normalized === entry.word)?.meaning).toBe(entry.meaning);
        for (const entry of [
          ...EXISTING_POS_CORRECTIONS,
          ...VERB_SENSE_CORRECTIONS,
          ...USAGE_CLARITY_CORRECTIONS,
          ...DAILY_ENRICHMENTS,
          ...DAILY_CONTEXT_ADDITIONS,
          ...DAILY_USAGE_NOTES,
        ])
          expect(words.find((word) => word.normalized === entry.word)?.meaning).toBe(entry.meaning);
        const daily = await db.vocabularyBook.findUniqueOrThrow({
          where: { sourceKey: '通用/日常生活单词.xlsx' },
        });
        expect(await db.vocabularyBookWord.count({ where: { bookId: daily.id } })).toBe(1245);
        const surname = words.find((word) => word.normalized === 'surname')!;
        await db.vocabularyWord.update({
          where: { id: surname.id },
          data: { meaning: '用户自己的释义' },
        });
        await importer.importVocabulary(assets);
        expect(
          (await db.vocabularyWord.findUniqueOrThrow({ where: { id: surname.id } })).meaning,
        ).toBe('用户自己的释义');
        expect(await db.vocabularyBookWord.count({ where: { bookId: daily.id } })).toBe(1245);
        console.log(
          'Fresh complete 113-book seed: 92 candidate words, 91 non-placeholder meanings, 7 reviewed additions, 1 deferred (sexuality); existing values preserved on rerun.',
        );
      });
    }, 90000);

    it('keeps the legacy daily book intact and explicitly backfills only untouched nulls with isolated audit/restore tokens', async () => {
      await withVocabularyCorrectionFixture(async ({ db, url, importer }) => {
        const daily = await db.vocabularyBook.findUniqueOrThrow({
          where: { sourceKey: '通用/日常生活单词.xlsx' },
        });
        const oldMap = await db.vocabularyBookWord.findMany({
          where: { bookId: daily.id },
          orderBy: { position: 'asc' },
        });
        // The four words already existed in other baseline system books; reproduce those null rows.
        const oldWords: Array<VocabularyWord & { bookWordId: string }> = [];
        for (const entry of SUPPLEMENT_MEANINGS.filter((entry) => entry.sourceKeys.length > 1)) {
          const key = entry.sourceKeys.find((key) => key !== '通用/日常生活单词.xlsx')!;
          const source = await db.vocabularyBook.upsert({
            where: { sourceKey: key },
            create: {
              sourceKey: key,
              sourcePath: key,
              title: 'Existing system source',
              category: 'GENERAL',
            },
            update: {},
          });
          const word = await db.vocabularyWord.create({
            data: { text: entry.word, normalized: entry.word, meaning: null },
          });
          const link = await db.vocabularyBookWord.create({
            data: { bookId: source.id, wordId: word.id, position: 10000 + oldWords.length },
          });
          oldWords.push({ ...word, bookWordId: link.id });
        }
        expect(oldWords).toHaveLength(4);
        await db.$executeRaw`INSERT INTO "UserWordProgress" ("id","userId","bookWordId","state","familiarity","reviewCount","nextReviewAt") VALUES ('supplement-fixture-progress','fixture-user',${oldWords[0].bookWordId},'REVIEWING',3,7,'2026-12-01T10:00:00Z')`;
        const progressBefore = await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`;
        await importer.importVocabulary(assets);
        expect(
          await db.vocabularyBookWord.findMany({
            where: { bookId: daily.id },
            orderBy: { position: 'asc' },
          }),
        ).toEqual(oldMap);
        expect(
          await db.vocabularyWord.count({ where: { normalized: { in: DAILY_SUPPLEMENT_WORDS } } }),
        ).toBe(89);
        const service = new VocabularyCorrectionsService(db, SUPPLEMENT_CORRECTION_BATCH);
        const plan = await service.preview();
        expect(plan.wordsToChange).toBe(4);
        expect(
          plan.actions
            .filter((action) => action.reason === 'missing-word')
            .map((action) => action.word),
        ).toEqual(['divorced', 'boyfriend', 'heterosexual']);
        const original = await db.vocabularyWord.findMany({
          where: { id: { in: oldWords.map((word) => word.id) } },
          orderBy: { id: 'asc' },
        });
        const command = await promisify(execFile)(
          process.execPath,
          [
            '-r',
            'ts-node/register',
            'src/vocabulary-corrections.ts',
            'preview',
            '--batch',
            SUPPLEMENT_MEANING_BATCH,
          ],
          {
            cwd: process.cwd(),
            env: { PATH: process.env.PATH, DATABASE_URL: url.toString() },
            timeout: 20000,
          },
        );
        expect(JSON.parse(command.stdout).token).toBe(plan.token);
        const legacyToken = (await new VocabularyCorrectionsService(db).preview()).token;
        await expect(service.execute('apply', legacyToken)).rejects.toThrow('stale');
        await expect(
          new VocabularyCorrectionsService(db).execute('apply', plan.token),
        ).rejects.toThrow('stale');
        await db.$executeRawUnsafe(
          `ALTER TABLE "VocabularyCorrectionAudit" ADD CONSTRAINT "injected_supplement_failure" CHECK ("wordId" <> '${oldWords[2].id}')`,
        );
        await expect(service.execute('apply', plan.token)).rejects.toThrow();
        expect(
          await db.vocabularyWord.findMany({
            where: { id: { in: oldWords.map((word) => word.id) } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(original);
        expect(await db.vocabularyCorrectionAudit.count()).toBe(0);
        await db.$executeRawUnsafe(
          'ALTER TABLE "VocabularyCorrectionAudit" DROP CONSTRAINT "injected_supplement_failure"',
        );
        // Intentional user clearing is protected even though the field is still null.
        await db.vocabularyWord.update({
          where: { id: oldWords[0].id },
          data: { meaning: null, updatedAt: new Date(oldWords[0].updatedAt.getTime() + 1000) },
        });
        await expect(service.execute('apply', plan.token)).rejects.toThrow('stale');
        const revised = await service.preview();
        expect(revised.wordsToChange).toBe(3);
        expect(revised.actions.find((action) => action.word === oldWords[0].text)?.reason).toBe(
          'edited-word',
        );
        const concurrent = await Promise.allSettled([
          service.execute('apply', revised.token),
          service.execute('apply', revised.token),
        ]);
        expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(
          await db.vocabularyCorrectionAudit.count({
            where: { batchId: SUPPLEMENT_MEANING_BATCH },
          }),
        ).toBe(3);
        expect(
          await db.vocabularyCorrectionAudit.count({
            where: { batchId: { not: SUPPLEMENT_MEANING_BATCH } },
          }),
        ).toBe(0);
        expect((await service.preview()).wordsToChange).toBe(0);
        expect(await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`).toEqual(
          progressBefore,
        );
        await db.vocabularyWord.update({
          where: { id: oldWords[1].id },
          data: { meaning: '回填后用户编辑' },
        });
        const restore = await service.preview('restore');
        expect(restore.wordsToChange).toBe(2);
        await service.execute('restore', restore.token);
        expect(
          (await db.vocabularyWord.findUniqueOrThrow({ where: { id: oldWords[1].id } })).meaning,
        ).toBe('回填后用户编辑');
        expect((await service.preview()).wordsToChange).toBe(0);
        expect(await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`).toEqual(
          progressBefore,
        );
        expect(
          await db.vocabularyBookWord.findMany({
            where: { bookId: daily.id },
            orderBy: { position: 'asc' },
          }),
        ).toEqual(oldMap);
        console.log(
          'Legacy complete seed: 89 candidates, 84 meanings unchanged; 4 nulls eligible, 3 applied after protecting 1 edited null; rollback, concurrency, 2 safe restores and preserved progress verified.',
        );
      });
    }, 90000);
  },
);
