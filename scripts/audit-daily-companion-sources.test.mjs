import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('keeps workbook presence distinct from reviewed import senses and unfinished semantic review', () => {
  const audit = JSON.parse(
    execFileSync(process.execPath, ['scripts/audit-daily-companion-sources.mjs'], {
      encoding: 'utf8',
    }),
  );
  const quality = JSON.parse(
    readFileSync('data/vocabulary-corrections/2026-11-03-supplement/quality-review.json'),
  );
  assert.deepEqual(audit.counts, {
    books: 113,
    candidates: 92,
    matched: 89,
    withNonPlaceholderMeaning: 84,
    differingMeaningStrings: 38,
  });
  assert.equal(audit.semanticReviewApproved, 0);
  assert.equal(audit.licenseReviewApproved, 0);
  assert.equal(audit.databaseApplied, 0);
  assert.equal(audit.reviewedImportOverlay.selectedSenses, 7);
  assert.deepEqual(audit.snapshots, quality.baselineSourceSnapshots);
  assert.equal(quality.rows.length, 92);
  for (const row of audit.rows) {
    const reviewed = quality.rows.find((item) => item.word === row.word);
    assert.ok(reviewed);
    assert.equal(reviewed.distinctMeaningStrings, row.distinctMeaningStrings);
    assert.deepEqual(
      reviewed.matches.map((match) => [match.sourceKey, match.row, !match.placeholder]),
      row.matches.map((match) => [match.sourceKey, match.row, match.nonPlaceholderMeaning]),
    );
  }
  assert.equal(
    audit.rows.find((row) => row.word === 'sexuality').qualityClassification,
    'missing-deferred',
  );
  for (const word of ['joint', 'palm'])
    assert.equal(audit.rows.find((row) => row.word === word).qualityClassification, 'context-gap');
  assert.equal(
    quality.rows.filter((row) => row.classification === 'unreviewed-existing').length,
    80,
  );
});
