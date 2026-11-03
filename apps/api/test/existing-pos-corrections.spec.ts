import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { expect, it } from 'vitest';
import {
  EXISTING_POS_CORRECTIONS,
  EXISTING_POS_BATCH,
  reviewedExistingMeaning,
} from '../src/modules/vocabulary/existing-pos-corrections';
import {
  correctionBatch,
  DEFAULT_CORRECTION_BATCH,
  EXISTING_POS_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';

it('limits the two editorial changes to the exact reviewed source values and preserves every original workbook', async () => {
  const root = join(process.cwd(), '../../data/vocabulary-corrections/2026-11-03-pos-review');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const review = JSON.parse(await readFile(join(root, 'review.json'), 'utf8'));
  expect(manifest.entries).toEqual(EXISTING_POS_CORRECTIONS);
  expect(manifest.batchId).toBe(EXISTING_POS_BATCH);
  expect(correctionBatch(EXISTING_POS_BATCH)).toBe(EXISTING_POS_CORRECTION_BATCH);
  expect(correctionBatch()).toBe(DEFAULT_CORRECTION_BATCH);
  expect(review.rows).toHaveLength(10);
  expect(
    review.rows.filter(
      (row: { classification: string }) => row.classification === 'confirmed-pos-error',
    ),
  ).toHaveLength(2);
  for (const entry of EXISTING_POS_CORRECTIONS) {
    for (const source of entry.sourceKeys) {
      const workbook = XLSX.read(await readFile(join(process.cwd(), 'assets/vocabulary', source)), {
        type: 'buffer',
      });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
        workbook.Sheets[workbook.SheetNames[0]],
      );
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
    expect(reviewedExistingMeaning(entry.word, 'unreviewed.xlsx', entry.expectedMeaning)).toBe(
      entry.expectedMeaning,
    );
  }
  expect(EXISTING_POS_CORRECTIONS[0].meaning).toBe('adj. 美丽的\n出色的\n迷人的');
  expect(EXISTING_POS_CORRECTIONS[1].meaning).toBe(
    EXISTING_POS_CORRECTIONS[1].expectedMeaning.replace(/^n\./, 'vt.'),
  );
  const prior = JSON.parse(
    await readFile(join(root, '../2026-11-03-supplement/quality-review.json'), 'utf8'),
  );
  for (const source of prior.baselineSourceSnapshots) {
    const bytes = await readFile(join(process.cwd(), 'assets/vocabulary', source.sourceKey));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
  }
});
