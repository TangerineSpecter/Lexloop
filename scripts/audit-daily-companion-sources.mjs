#!/usr/bin/env node
// Existing repository data only. Presence/conflicts are not semantic or license approval.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDailyBoundaries } from './audit-daily-vocabulary-boundaries.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('../apps/api/node_modules/xlsx');
const root = fileURLToPath(new URL('../apps/api/assets/vocabulary/', import.meta.url));
const audit = auditDailyBoundaries();
const candidates = new Map(
  audit.rows
    .filter((row) => row.classification === 'word-list')
    .flatMap((row) =>
      row.v2.map((entry) => [
        entry.word.toLowerCase(),
        { word: entry.word, sourceRow: row.row, matches: [], meanings: new Set() },
      ]),
    ),
);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Source symlink requires review');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.xlsx')) files.push(path);
  }
}
walk(root);
files.sort();
const snapshots = [];
for (const path of files) {
  const bytes = readFileSync(path);
  const sourceKey = relative(root, path).split('\\').join('/');
  snapshots.push({ sourceKey, sha256: createHash('sha256').update(bytes).digest('hex') });
  const workbook = XLSX.read(bytes);
  XLSX.utils
    .sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' })
    .forEach((row, index) => {
      const key = String(row['单词']).trim().toLowerCase().replace(/\s+/g, ' ');
      const candidate = candidates.get(key);
      if (!candidate) return;
      const meaning = String(row['释义'] ?? '').trim();
      const present = Boolean(meaning && meaning !== '无' && meaning !== '暂无释义');
      candidate.matches.push({ sourceKey, row: index + 2, nonPlaceholderMeaning: present });
      if (present) candidate.meanings.add(meaning);
    });
}
const rows = [...candidates.values()].map(({ meanings, ...candidate }) => ({
  ...candidate,
  distinctMeaningStrings: meanings.size,
}));
console.log(
  JSON.stringify(
    {
      mode: 'source-presence-triage-only',
      revision: audit.revision,
      counts: {
        books: files.length,
        candidates: rows.length,
        matched: rows.filter((row) => row.matches.length).length,
        withNonPlaceholderMeaning: rows.filter((row) => row.distinctMeaningStrings > 0).length,
        differingMeaningStrings: rows.filter((row) => row.distinctMeaningStrings > 1).length,
      },
      semanticReviewApproved: 0,
      licenseReviewApproved: 0,
      databaseApplied: 0,
      note: 'Different strings may be legitimate senses or formatting differences. Do not auto-select or merge them. Repository presence does not establish upstream rights.',
      snapshots,
      rows,
    },
    null,
    2,
  ),
);
