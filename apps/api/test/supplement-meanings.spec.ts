import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  SUPPLEMENT_MEANINGS,
  SUPPLEMENT_MEANING_BATCH,
} from '../src/modules/vocabulary/supplement-meanings';
import {
  correctionBatch,
  DEFAULT_CORRECTION_BATCH,
} from '../src/modules/vocabulary/vocabulary-corrections.service';

it('ships only the seven reviewed selected senses with exact attribution, source hashes and system source scopes', () => {
  const base = join(process.cwd(), '../../data/vocabulary-corrections/2026-11-03-supplement');
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'));
  expect(manifest.batchId).toBe(SUPPLEMENT_MEANING_BATCH);
  expect(manifest.license).toBe('CC-BY-SA-4.0');
  expect(SUPPLEMENT_MEANINGS).toEqual(
    manifest.entries.map(
      ({ word, meaning, sourceKeys }: { word: string; meaning: string; sourceKeys: string[] }) => ({
        word,
        meaning,
        sourceKeys,
      }),
    ),
  );
  expect(SUPPLEMENT_MEANINGS).toHaveLength(7);
  for (const item of SUPPLEMENT_MEANINGS) {
    const ref = manifest.sources.find((source: { word: string }) => source.word === item.word);
    const bytes = readFileSync(join(base, ref.file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
    const source = JSON.parse(bytes.toString());
    expect(source.word).toBe(item.word);
    expect(source.license.selected).toBe(manifest.license);
    expect(source.entry).toBe(`https://en.wiktionary.org/wiki/${item.word}`);
    expect(source.history).toContain(`title=${item.word}&action=history`);
    expect(source.snapshot).toMatchObject({
      dump: 'enwiktionary-2026-10-01',
      extractedAt: '2026-10-30',
      retrievedAt: '2026-11-03',
    });
    expect(source.license.attribution).toContain('Wiktionary contributors');
    expect(source.sounds).toBeUndefined();
    expect(item.meaning.startsWith(source.pos === 'noun' ? 'n. ' : 'adj. ')).toBe(true);
    const translations =
      item.word === 'hairdo' ? source.secondarySource.chinese : source.sense.chinese;
    if (item.word === 'hairdo') {
      expect(source.sense.label).toBe('A hairstyle.');
      expect(source.secondarySource.word).toBe('hairstyle');
      expect(source.secondarySource.pos).toBe('noun');
    }
    const selected = item.meaning.replace(/^(n|adj)\. /, '').split('；');
    for (const term of selected)
      expect(translations.flatMap((t: string) => t.split('/').map((p) => p.trim()))).toContain(
        term,
      );
    for (const key of item.sourceKeys) {
      if (key === '通用/日常生活单词.xlsx') continue;
      const book = XLSX.readFile(join(process.cwd(), 'assets/vocabulary', key));
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
        book.Sheets[book.SheetNames[0]],
        { defval: '' },
      );
      const found = rows.filter((row) => row['单词'].trim().toLowerCase() === item.word);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((row) => ['', '无', '暂无释义'].includes(row['释义'].trim()))).toBe(true);
    }
  }
  expect(correctionBatch()).toBe(DEFAULT_CORRECTION_BATCH);
  expect(correctionBatch(SUPPLEMENT_MEANING_BATCH).corrections).toBe(SUPPLEMENT_MEANINGS);
  expect(() => correctionBatch('unreviewed')).toThrow('Unknown');
});
