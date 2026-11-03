import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  loadCorrections,
  correctedWorkbook,
  verifyApplied,
  workbookValues,
  XLSX,
} from './apply-vocabulary-corrections.mjs';
test('reviewed source patch changes exactly twelve missing cells, preserving all other words and values', () => {
  const { manifest, baseline, sources } = loadCorrections();
  const expected = correctedWorkbook(manifest, baseline, sources);
  const oldRows = workbookValues(XLSX.read(baseline))[0].rows;
  const newRows = workbookValues(expected)[0].rows;
  assert.equal(newRows.length, oldRows.length);
  const differences = [];
  for (let r = 0; r < oldRows.length; r++)
    for (let c = 0; c < oldRows[r].length; c++)
      if (oldRows[r][c] !== newRows[r][c])
        differences.push({
          row: r + 1,
          column: oldRows[0][c],
          from: oldRows[r][c],
          to: newRows[r][c],
        });
  assert.deepEqual(
    differences,
    manifest.entries
      .flatMap((e) => e.changes.map((c) => ({ row: e.row, ...c })))
      .sort((a, b) => a.row - b.row || oldRows[0].indexOf(a.column) - oldRows[0].indexOf(b.column)),
  );
  assert.equal(differences.length, 12);
  assert.ok(differences.every((d) => d.from === '无'));
  const actual = readFileSync(new URL('../' + manifest.target, import.meta.url));
  assert.deepEqual(verifyApplied(manifest, baseline, sources, actual), {
    sourceWords: 6,
    sourceFields: 12,
    existingDatabaseApplied: 0,
    rows: 1177,
    remaining: { meaning: 1109, ukPhonetic: 1117, usPhonetic: 1117 },
  });
  assert.equal(workbookValues(expected)[1].rows.length, 7);
});
test('rejects drift, existing fields, wrong part of speech, guessed region and missing attribution', () => {
  const mutations = [
    ({ manifest }) => manifest.entries[0].row++,
    ({ manifest }) => (manifest.entries[0].changes[0].from = '已有释义'),
    ({ manifest }) => (manifest.entries[0].changes[0].to = 'n. 无来源释义'),
    ({ manifest }) =>
      manifest.entries[2].changes.push({ column: '美音', from: '无', to: '/kɹeɪt/' }),
    ({ sources }) => (sources['moped-en'].pos = 'verb'),
    ({ sources }) =>
      (sources['moped-en'].sounds = [
        { ipa: '/məʊpt/', tags: ['UK'] },
        { ipa: '/moʊpt/', tags: ['US'] },
      ]),
    ({ sources }) => (sources['brownie-en'].license.attribution = ''),
    ({ manifest }) => manifest.entries.push(manifest.entries[0]),
    ({ manifest }) => (manifest.entries[0].review.humanApproval = 'fabricated'),
  ];
  for (const mutation of mutations) {
    const d = loadCorrections();
    mutation(d);
    assert.throws(() => correctedWorkbook(d.manifest, d.baseline, d.sources));
  }
  const d = loadCorrections();
  const altered = correctedWorkbook(d.manifest, d.baseline, d.sources);
  altered.Sheets[altered.SheetNames[0]].A2 = { t: 's', v: 'unrelated edit' };
  assert.throws(() =>
    verifyApplied(
      d.manifest,
      d.baseline,
      d.sources,
      XLSX.write(altered, { type: 'buffer', bookType: 'xlsx' }),
    ),
  );
});
