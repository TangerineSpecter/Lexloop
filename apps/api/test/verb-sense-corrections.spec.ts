import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { expect, it } from 'vitest';
import {
  VERB_SENSE_BATCH,
  VERB_SENSE_CORRECTIONS,
} from '../src/modules/vocabulary/verb-sense-corrections';
import { reviewedExistingMeaning } from '../src/modules/vocabulary/existing-pos-corrections';
import {
  correctionBatch,
  VERB_SENSE_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';

it('confines the new verb edits to exact audited originals without changing prior batches or unreviewed variants', async () => {
  const root = join(process.cwd(), '../../data/vocabulary-corrections');
  const manifest = JSON.parse(
    await readFile(join(root, '2026-11-03-verb-review/manifest.json'), 'utf8'),
  );
  const review = JSON.parse(
    await readFile(join(root, '2026-11-03-verb-review/review.json'), 'utf8'),
  );
  const prior = JSON.parse(await readFile(join(root, '2026-11-03-pos-review/review.json'), 'utf8'));
  expect(manifest.entries).toEqual(VERB_SENSE_CORRECTIONS);
  expect(manifest.batchId).toBe(VERB_SENSE_BATCH);
  expect(correctionBatch(VERB_SENSE_BATCH)).toBe(VERB_SENSE_CORRECTION_BATCH);
  expect(review.rows).toHaveLength(9);
  expect(new Set(review.rows.map((row: { word: string }) => row.word)).size).toBe(9);
  expect(
    review.rows.every(
      (row: { word: string }) => !prior.rows.some((p: { word: string }) => p.word === row.word),
    ),
  ).toBe(true);
  expect(review.counts.remainingWithoutFocusedSemanticReview).toBe(
    prior.counts.remainingWithoutFocusedSemanticReview - 9,
  );
  for (const entry of VERB_SENSE_CORRECTIONS) {
    expect(
      review.rows.find((row: { word: string }) => row.word === entry.word).classification,
    ).toBe('confirmed-pos-error');
    for (const source of entry.sourceKeys) {
      const wb = XLSX.read(await readFile(join(process.cwd(), 'assets/vocabulary', source)), {
        type: 'buffer',
      });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
      expect(
        rows.some(
          (row) =>
            row['单词'].trim().toLowerCase() === entry.word &&
            row['释义'].trim() === entry.expectedMeaning,
        ),
      ).toBe(true);
      expect(reviewedExistingMeaning(entry.word, source, entry.expectedMeaning)).toBe(
        entry.meaning,
      );
      for (const value of [
        null,
        '',
        '我的释义',
        entry.meaning,
        entry.expectedMeaning + '\n用户补充',
      ])
        expect(reviewedExistingMeaning(entry.word, source, value)).toBe(value);
    }
    expect(reviewedExistingMeaning(entry.word, 'unknown.xlsx', entry.expectedMeaning)).toBe(
      entry.expectedMeaning,
    );
  }
  expect(VERB_SENSE_CORRECTIONS[0].meaning).toBe('vt. 踢\nn. 踢；反冲，后座力\nvi. 踢；反冲');
  expect(VERB_SENSE_CORRECTIONS[1].meaning).toBe('n. 口哨；汽笛；呼啸声\nvi. 吹口哨；鸣汽笛');
});
