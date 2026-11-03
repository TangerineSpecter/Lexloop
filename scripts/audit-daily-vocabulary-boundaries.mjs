#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const XLSX = require('../apps/api/node_modules/xlsx');
const base = new URL('../apps/api/src/modules/vocabulary/', import.meta.url);
export function auditDailyBoundaries() {
  const manifest = JSON.parse(readFileSync(new URL('daily-vocabulary-boundaries.json', base)));
  const review = JSON.parse(readFileSync(new URL('daily-vocabulary-boundary-review.json', base)));
  const bytes = readFileSync(
    new URL('../apps/api/assets/vocabulary/通用/日常生活单词.xlsx', import.meta.url),
  );
  const workbook = XLSX.read(bytes);
  const source = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  const digest = createHash('sha256')
    .update(JSON.stringify(source.map((row) => row['单词'])))
    .digest('hex');
  if (digest !== manifest.sourceWordSequenceSha256 || digest !== review.sourceWordSequenceSha256)
    throw new Error('Source word/order drift: review required');
  const reviewed = new Map();
  for (const entry of review.reviewed) {
    if (
      reviewed.has(entry.row) ||
      source[entry.row - 2]?.['单词'] !== entry.original ||
      !['phrase', 'word-list', 'ambiguous'].includes(entry.classification) ||
      !entry.reason
    )
      throw new Error('Invalid review ledger');
    reviewed.set(entry.row, entry);
  }
  const repairs = new Map(manifest.repairs.map((entry) => [entry.row, entry]));
  if (repairs.size !== manifest.repairs.length) throw new Error('Duplicate repair row');
  for (const repair of repairs.values()) {
    const row = source[repair.row - 2];
    if (
      row?.['单词'] !== repair.original ||
      repair.entries.length < 2 ||
      repair.entries.join(' ') !== repair.original ||
      !['释义', '英音', '美音'].every(
        (field) => row[field] === '' || row[field] === '无' || row[field] == null,
      )
    )
      throw new Error('Repair would guess spelling or discard existing content');
  }
  for (const entry of reviewed.values()) {
    const repair = repairs.get(entry.row);
    if (
      entry.classification === 'word-list'
        ? JSON.stringify(entry.entries) !== JSON.stringify(repair?.entries)
        : repair !== undefined
    )
      throw new Error('Review and executable repair disagree');
  }
  // Published v1 only split these five rows. Retain this explicit baseline for
  // upgrade impact review; never infer existing database positions from v2.
  const v1Rows = new Set([7, 8, 12, 18, 24]);
  for (const repair of repairs.values()) {
    if (!v1Rows.has(repair.row) && reviewed.get(repair.row)?.classification !== 'word-list')
      throw new Error('Unreviewed executable repair');
  }
  if ([...v1Rows].some((row) => !repairs.has(row)))
    throw new Error('Published v1 baseline changed');
  let v1Position = 1;
  let v2Position = 1;
  const rows = source.map((item, index) => {
    const row = index + 2;
    const repair = repairs.get(row);
    const v1Entries = repair && v1Rows.has(row) ? repair.entries : [item['单词']];
    const v2Entries = repair?.entries ?? [item['单词']];
    const record = {
      row,
      original: item['单词'],
      classification:
        reviewed.get(row)?.classification ??
        (repair
          ? 'previously-repaired'
          : /\s/.test(item['单词'])
            ? 'unreviewed'
            : 'single-cell-entry'),
      reason: reviewed.get(row)?.reason ?? null,
      context: {
        previous: source[index - 1]?.['单词'] ?? null,
        next: source[index + 1]?.['单词'] ?? null,
      },
      legacy: [{ position: index + 1, word: item['单词'] }],
      v1: v1Entries.map((word, offset) => ({ position: v1Position + offset, word })),
      v2: v2Entries.map((word, offset) => ({ position: v2Position + offset, word })),
    };
    v1Position += v1Entries.length;
    v2Position += v2Entries.length;
    return record;
  });
  const normalized = rows.flatMap((row) =>
    row.v2.map((entry) => entry.word.toLowerCase().replace(/\s+/g, ' ').trim()),
  );
  if (new Set(normalized).size !== normalized.length)
    throw new Error('Expanded words collide; review required');
  return {
    sourceKey: manifest.sourceKey,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    revision: manifest.revision,
    counts: {
      source: rows.length,
      v1: v1Position - 1,
      v2: v2Position - 1,
      classifications: rows.reduce(
        (counts, row) => ({
          ...counts,
          [row.classification]: (counts[row.classification] ?? 0) + 1,
        }),
        {},
      ),
    },
    databaseApplied: false,
    definitionsAdded: 0,
    pronunciationsAdded: 0,
    license: 'No external content added; original upstream source rights remain unverified.',
    rows,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(auditDailyBoundaries(), null, 2));
