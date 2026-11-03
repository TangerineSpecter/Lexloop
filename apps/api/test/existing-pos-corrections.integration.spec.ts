import { DAILY_USAGE_NOTES } from '../src/modules/vocabulary/daily-usage-notes';
import { DAILY_CONTEXT_ADDITIONS } from '../src/modules/vocabulary/daily-context';
import { DAILY_ENRICHMENTS } from '../src/modules/vocabulary/daily-enrichment';
import { USAGE_CLARITY_CORRECTIONS } from '../src/modules/vocabulary/usage-clarity-corrections';
import { VERB_SENSE_CORRECTIONS } from '../src/modules/vocabulary/verb-sense-corrections';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXISTING_POS_CORRECTIONS,
  EXISTING_POS_BATCH,
} from '../src/modules/vocabulary/existing-pos-corrections';
import {
  DAILY_ENRICHMENT_CORRECTION_BATCH,
  DAILY_CONTEXT_CORRECTION_BATCH,
  DAILY_USAGE_NOTES_CORRECTION_BATCH,
  VocabularyCorrectionsService,
  EXISTING_POS_CORRECTION_BATCH,
  SUPPLEMENT_CORRECTION_BATCH,
  VERB_SENSE_CORRECTION_BATCH,
  USAGE_CLARITY_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';
import { withVocabularyCorrectionFixture } from './helpers/vocabulary-correction-fixture';

describe.each([
  {
    name: 'daily-usage-notes',
    entries: DAILY_USAGE_NOTES,
    batch: DAILY_USAGE_NOTES_CORRECTION_BATCH,
  },
  {
    name: 'daily-context',
    entries: DAILY_CONTEXT_ADDITIONS,
    batch: DAILY_CONTEXT_CORRECTION_BATCH,
  },
  {
    name: 'daily-enrichment',
    entries: DAILY_ENRICHMENTS,
    batch: DAILY_ENRICHMENT_CORRECTION_BATCH,
  },
  { name: 'existing-pos', entries: EXISTING_POS_CORRECTIONS, batch: EXISTING_POS_CORRECTION_BATCH },
  { name: 'verb-senses', entries: VERB_SENSE_CORRECTIONS, batch: VERB_SENSE_CORRECTION_BATCH },
  {
    name: 'usage-clarity',
    entries: USAGE_CLARITY_CORRECTIONS,
    batch: USAGE_CLARITY_CORRECTION_BATCH,
  },
])('$name', ({ entries, batch }) => {
  describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
    'exact meaning repair on isolated PostgreSQL',
    () => {
      it('never auto-updates old values, atomically repairs exact originals, and restores with edit protection', async () => {
        await withVocabularyCorrectionFixture(async ({ db, importer }) => {
          const words = [];
          for (const [entryIndex, entry] of entries.entries()) {
            const book = await db.vocabularyBook.upsert({
              where: { sourceKey: entry.sourceKeys[0] },
              update: {},
              create: {
                title: 'audited source',
                sourceKey: entry.sourceKeys[0],
                sourcePath: entry.sourceKeys[0],
                category: 'GENERAL',
              },
            });
            const word = await db.vocabularyWord.create({
              data: { text: entry.word, normalized: entry.word, meaning: entry.expectedMeaning },
            });
            const link = await db.vocabularyBookWord.create({
              data: { bookId: book.id, wordId: word.id, position: entryIndex + 1 },
            });
            words.push({ ...word, bookWordId: link.id });
          }
          await db.$executeRaw`INSERT INTO "UserWordProgress" ("id","userId","bookWordId","state","familiarity","reviewCount","nextReviewAt") VALUES ('pos-progress','synthetic-user',${words[0].bookWordId},'REVIEWING',3,7,'2026-12-01T10:00:00Z')`;
          const progress = await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`;
          await importer.importVocabulary(join(process.cwd(), 'assets/vocabulary'));
          for (const word of words)
            expect(await db.vocabularyWord.findUnique({ where: { id: word.id } })).toEqual(
              wordWithoutLink(word),
            );
          const service = new VocabularyCorrectionsService(db, batch);
          const plan = await service.preview();
          expect(plan.wordsToChange).toBe(entries.length);
          for (const otherBatch of [
            undefined,
            SUPPLEMENT_CORRECTION_BATCH,
            ...[
              EXISTING_POS_CORRECTION_BATCH,
              VERB_SENSE_CORRECTION_BATCH,
              USAGE_CLARITY_CORRECTION_BATCH,
              DAILY_ENRICHMENT_CORRECTION_BATCH,
              DAILY_CONTEXT_CORRECTION_BATCH,
              DAILY_USAGE_NOTES_CORRECTION_BATCH,
            ].filter((other) => other.batchId !== batch.batchId),
          ]) {
            const other = new VocabularyCorrectionsService(db, otherBatch);
            await expect(other.execute('apply', plan.token)).rejects.toThrow('stale');
          }
          // A failing audit insert must undo both replacement values, not just the last one.
          await db.$executeRawUnsafe(
            `ALTER TABLE "VocabularyCorrectionAudit" ADD CONSTRAINT "pos_failure" CHECK ("wordId" <> '${words[1].id}')`,
          );
          await expect(service.execute('apply', plan.token)).rejects.toThrow();
          for (const word of words)
            expect(await db.vocabularyWord.findUnique({ where: { id: word.id } })).toEqual(
              wordWithoutLink(word),
            );
          expect(await db.vocabularyCorrectionAudit.count()).toBe(0);
          await db.$executeRawUnsafe(
            'ALTER TABLE "VocabularyCorrectionAudit" DROP CONSTRAINT "pos_failure"',
          );
          const outcomes = await Promise.allSettled([
            service.execute('apply', plan.token),
            service.execute('apply', plan.token),
          ]);
          expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          expect(
            await db.vocabularyCorrectionAudit.count({ where: { batchId: batch.batchId } }),
          ).toBe(entries.length);
          for (const entry of entries)
            expect(
              (await db.vocabularyWord.findUniqueOrThrow({ where: { normalized: entry.word } }))
                .meaning,
            ).toBe(entry.meaning);
          expect((await service.preview()).wordsToChange).toBe(0);
          // Exact original payloads are retained, including the erroneous labels, for restoration.
          const audits = await db.vocabularyCorrectionAudit.findMany({
            where: { batchId: batch.batchId },
          });
          for (const word of words)
            expect(
              (audits.find((a) => a.wordId === word.id)!.before as { meaning: string }).meaning,
            ).toBe(word.meaning);
          await db.vocabularyWord.update({
            where: { id: words[0].id },
            data: { meaning: '用户重新编辑' },
          });
          const restore = await service.preview('restore');
          expect(restore.wordsToChange).toBe(entries.length - 1);
          expect(restore.actions.find((a) => a.word === entries[0].word)?.reason).toBe(
            'edited-after-apply',
          );
          expect(await service.execute('restore', restore.token)).toEqual({
            batchId: batch.batchId,
            mode: 'restore',
            changedWords: entries.length - 1,
            changedFields: entries.length - 1,
          });
          for (const word of words.slice(1)) {
            expect(
              (await db.vocabularyWord.findUniqueOrThrow({ where: { id: word.id } })).meaning,
            ).toBe(word.meaning);
            expect(
              (
                await db.vocabularyCorrectionAudit.findFirstOrThrow({
                  where: { wordId: word.id, batchId: batch.batchId },
                })
              ).state,
            ).toBe('RESTORED');
          }
          expect(
            (
              await db.vocabularyCorrectionAudit.findFirstOrThrow({
                where: { wordId: words[0].id, batchId: batch.batchId },
              })
            ).state,
          ).toBe('APPLIED');
          expect(
            (await db.vocabularyWord.findUniqueOrThrow({ where: { id: words[0].id } })).meaning,
          ).toBe('用户重新编辑');
          expect((await service.preview()).wordsToChange).toBe(0);
          expect(await db.$queryRaw`SELECT to_jsonb(p) FROM "UserWordProgress" p`).toEqual(
            progress,
          );
        });
      }, 90000);

      it('rejects edited originals, nulls, alternative definitions and unqualified source membership', async () => {
        await withVocabularyCorrectionFixture(async ({ db }) => {
          const service = new VocabularyCorrectionsService(db, batch);
          const entry = entries[0];
          const book = await db.vocabularyBook.create({
            data: {
              title: 'source',
              sourceKey: entry.sourceKeys[0],
              sourcePath: entry.sourceKeys[0],
              category: 'GENERAL',
            },
          });
          const date = new Date('2026-01-01T00:00:00Z');
          const word = await db.vocabularyWord.create({
            data: {
              normalized: entry.word,
              text: entry.word,
              meaning: entry.expectedMeaning,
              createdAt: date,
              updatedAt: date,
            },
          });
          await db.vocabularyBookWord.create({
            data: { bookId: book.id, wordId: word.id, position: 1 },
          });
          const initial = await service.preview();
          expect(initial.wordsToChange).toBe(1);
          // Even an edit back to the identical original is protected by its timestamp.
          await db.vocabularyWord.update({
            where: { id: word.id },
            data: { meaning: entry.expectedMeaning, updatedAt: new Date(date.getTime() + 1000) },
          });
          expect((await service.preview()).actions[0].reason).toBe('edited-word');
          await expect(service.execute('apply', initial.token)).rejects.toThrow('stale');
          // Artificial fixture states simulate untouched imports with other valid/null values.
          for (const meaning of [null, '我的释义', 'adj. 美丽的', entry.meaning]) {
            await db.vocabularyWord.update({
              where: { id: word.id },
              data: { meaning, updatedAt: date },
            });
            expect((await service.preview()).actions[0].reason).toBe('original-meaning-mismatch');
          }
          await db.vocabularyWord.update({
            where: { id: word.id },
            data: { meaning: entry.expectedMeaning, updatedAt: date },
          });
          await db.vocabularyBook.update({
            where: { id: book.id },
            data: {
              sourceKey: entries[1].sourceKeys.find(
                (key) => !entry.sourceKeys.some((allowed) => allowed === key),
              )!,
            },
          });
          expect((await service.preview()).actions[0].reason).toBe('source-mismatch');
          expect(await db.vocabularyCorrectionAudit.count()).toBe(0);
        });
      });
    },
  );
});
function wordWithoutLink<T extends { bookWordId: string }>(word: T) {
  const { bookWordId, ...rest } = word;
  return rest;
}
