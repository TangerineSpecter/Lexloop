import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { expect, it } from 'vitest';
import {
  DAILY_USAGE_NOTES_BATCH,
  DAILY_USAGE_NOTES,
} from '../src/modules/vocabulary/daily-usage-notes';
import { reviewedExistingMeaning } from '../src/modules/vocabulary/existing-pos-corrections';
import {
  correctionBatch,
  DAILY_USAGE_NOTES_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';

it('adds licensed senses without removing original meanings or matching unreviewed sources and edits', async () => {
  const root = join(process.cwd(), '../../data/vocabulary-corrections/2026-11-03-usage-notes');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  expect(manifest.entries).toEqual(DAILY_USAGE_NOTES);
  expect(correctionBatch(DAILY_USAGE_NOTES_BATCH)).toBe(DAILY_USAGE_NOTES_CORRECTION_BATCH);
  const attribution = await readFile(
    join(process.cwd(), '../web/app/vocabulary-sources/page.tsx'),
    'utf8',
  );
  const books = new Map<string, Record<string, string>[]>();
  for (const entry of DAILY_USAGE_NOTES) {
    expect(entry.meaning.startsWith(entry.expectedMeaning + '\n')).toBe(true);
    const sourceFile = manifest.sources.find(
      (s: { file: string }) => s.file === `sources/${entry.word}.json`,
    );
    const data = await readFile(join(root, sourceFile.file));
    expect(createHash('sha256').update(data).digest('hex')).toBe(sourceFile.sha256);
    const source = JSON.parse(data.toString());
    expect(source.license.selected).toBe('CC-BY-SA-4.0');
    expect(source.license.attribution).toBe('Wiktionary contributors');
    expect(entry.meaning).toBe(entry.expectedMeaning + '\n' + source.addedMeaning);
    expect(attribution).toContain(`title=${source.entryTitle}&amp;oldid=${source.revision}`);
    for (const key of entry.sourceKeys) {
      if (!books.has(key)) {
        const wb = XLSX.read(await readFile(join(process.cwd(), 'assets/vocabulary', key)), {
          type: 'buffer',
        });
        books.set(
          key,
          XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]),
        );
      }
      expect(
        books
          .get(key)!
          .some(
            (row) =>
              row['单词'].trim().toLowerCase() === entry.word &&
              row['释义'].trim() === entry.expectedMeaning,
          ),
      ).toBe(true);
      expect(reviewedExistingMeaning(entry.word, key, entry.expectedMeaning)).toBe(entry.meaning);
      for (const value of [
        null,
        '',
        '个人释义',
        entry.meaning,
        entry.expectedMeaning + '\n个人补充',
      ])
        expect(reviewedExistingMeaning(entry.word, key, value)).toBe(value);
    }
    expect(reviewedExistingMeaning(entry.word, 'unknown.xlsx', entry.expectedMeaning)).toBe(
      entry.expectedMeaning,
    );
  }
  const review = JSON.parse(await readFile(join(root, 'review.json'), 'utf8'));
  const prior = JSON.parse(await readFile(join(root, '../2026-11-03-context/review.json'), 'utf8'));
  expect(review.rows.map((r: { word: string }) => r.word)).toEqual(
    prior.rows
      .filter(
        (r: { status: string; remainingConcern?: string }) =>
          ['pending-evidence', 'enrichment-candidate'].includes(r.status) ||
          Boolean(r.remainingConcern),
      )
      .map((r: { word: string }) => r.word),
  );
  expect(
    review.rows
      .filter((r: { status: string }) => r.status === 'reviewed-usage-note')
      .map((r: { word: string }) => r.word)
      .sort(),
  ).toEqual(DAILY_USAGE_NOTES.map((e) => e.word).sort());
}, 20000);
