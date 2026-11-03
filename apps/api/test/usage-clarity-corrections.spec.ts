import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { expect, it } from 'vitest';
import {
  USAGE_CLARITY_BATCH,
  USAGE_CLARITY_CORRECTIONS,
} from '../src/modules/vocabulary/usage-clarity-corrections';
import { reviewedExistingMeaning } from '../src/modules/vocabulary/existing-pos-corrections';
import {
  correctionBatch,
  USAGE_CLARITY_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';

it('applies the five reviewed clarifications only to exact audited source variants', async () => {
  const root = join(process.cwd(), '../../data/vocabulary-corrections');
  const manifest = JSON.parse(
    await readFile(join(root, '2026-11-03-followup/manifest.json'), 'utf8'),
  );
  expect(manifest.entries).toEqual(USAGE_CLARITY_CORRECTIONS);
  expect(manifest.batchId).toBe(USAGE_CLARITY_BATCH);
  expect(correctionBatch(USAGE_CLARITY_BATCH)).toBe(USAGE_CLARITY_CORRECTION_BATCH);
  for (const entry of USAGE_CLARITY_CORRECTIONS) {
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
      ]) {
        expect(reviewedExistingMeaning(entry.word, source, value)).toBe(value);
      }
    }
    expect(reviewedExistingMeaning(entry.word, 'unknown.xlsx', entry.expectedMeaning)).toBe(
      entry.expectedMeaning,
    );
  }
  const meanings = Object.fromEntries(
    USAGE_CLARITY_CORRECTIONS.map((entry) => [entry.word, entry.meaning]),
  );
  expect(meanings.wake).toContain('vt. 叫醒；激发\nvi. 醒来；警觉');
  expect(meanings.drag).toContain('vi. 拖曳；缓慢而吃力地行进');
  expect(meanings.drag).toContain('vt. 拖累；拖拉；使缓慢而吃力地行进');
  expect(meanings.nickname).toContain('〈古〉叫错名字');
  expect(meanings.breathe).toContain('使休息以恢复呼吸');
  expect(meanings.noisy).toBe('adj. 嘈杂的；喧闹的；聒噪的');
});

it('accounts for every queued concern without certifying unresolved senses or changing original workbooks', async () => {
  const root = join(process.cwd(), '../../data/vocabulary-corrections');
  const review = JSON.parse(await readFile(join(root, '2026-11-03-followup/review.json'), 'utf8'));
  const queue = JSON.parse(
    await readFile(join(root, '2026-11-03-remaining-review/review-queue.json'), 'utf8'),
  );
  expect(review.rows.map((r: { word: string }) => r.word)).toEqual(
    queue.rows.map((r: { word: string }) => r.word),
  );
  expect(new Set(review.rows.map((r: { word: string }) => r.word)).size).toBe(38);
  const counts: Record<string, number> = {};
  const sourceRows = new Map<string, Record<string, string>[]>();
  for (const row of review.rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    expect(row.references.length).toBeGreaterThan(0);
    for (const src of row.sourceRows) {
      if (!sourceRows.has(src.sourceKey)) {
        const wb = XLSX.read(
          await readFile(join(process.cwd(), 'assets/vocabulary', src.sourceKey)),
          { type: 'buffer' },
        );
        sourceRows.set(
          src.sourceKey,
          XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]),
        );
      }
      const original = sourceRows.get(src.sourceKey)![src.row - 2];
      expect(original['单词'].trim().toLowerCase()).toBe(row.word);
      expect(createHash('sha256').update(original['释义'].trim()).digest('hex')).toBe(
        row.reviewedVariantSha256,
      );
    }
  }
  expect(counts).toEqual(review.counts);
  expect(
    review.rows
      .filter((r: { decision: string }) => r.decision === 'exact-reviewed-batch-only')
      .map((r: { word: string }) => r.word)
      .sort(),
  ).toEqual(USAGE_CLARITY_CORRECTIONS.map((e) => e.word).sort());
  const baseline = JSON.parse(
    await readFile(join(root, '2026-11-03-supplement/quality-review.json'), 'utf8'),
  );
  for (const src of baseline.baselineSourceSnapshots) {
    expect(
      createHash('sha256')
        .update(await readFile(join(process.cwd(), 'assets/vocabulary', src.sourceKey)))
        .digest('hex'),
    ).toBe(src.sha256);
  }
}, 20000);
