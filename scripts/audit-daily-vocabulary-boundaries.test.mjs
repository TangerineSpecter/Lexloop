import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditDailyBoundaries } from './audit-daily-vocabulary-boundaries.mjs';

test('coverage inventory distinguishes retained reviewed rows from rows not yet reviewed', () => {
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./vocabulary-coverage-inventory.mjs', import.meta.url))],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(report.remainingUnclassifiedMultiTokenRows, 1019);
  assert.equal(report.reviewedPhraseRows, 7);
  assert.equal(report.reviewedAmbiguousRows, 29);
});

test('audits every source row with explicit classifications and distinct upgrade mappings', () => {
  const report = auditDailyBoundaries();
  assert.deepEqual(report.counts, {
    source: 1177,
    v1: 1189,
    v2: 1245,
    classifications: {
      'single-cell-entry': 81,
      ambiguous: 29,
      'word-list': 36,
      'previously-repaired': 5,
      phrase: 7,
      unreviewed: 1019,
    },
  });
  const surname = report.rows.find((row) => row.row === 5);
  assert.deepEqual(surname.v1, [{ position: 4, word: 'surname nickname' }]);
  assert.deepEqual(surname.v2, [
    { position: 4, word: 'surname' },
    { position: 5, word: 'nickname' },
  ]);
  for (const category of ['phrase', 'ambiguous', 'unreviewed', 'single-cell-entry']) {
    for (const row of report.rows.filter((row) => row.classification === category))
      assert.deepEqual(
        row.v2.map((entry) => entry.word),
        [row.original],
      );
  }
  const entries = report.rows.flatMap((row) => row.v2);
  assert.equal(new Set(entries.map((entry) => entry.word)).size, 1245);
  assert.deepEqual(
    entries.map((entry) => entry.position),
    Array.from({ length: 1245 }, (_, i) => i + 1),
  );
  assert.equal(report.databaseApplied, false);
  assert.equal(report.definitionsAdded, 0);
});
