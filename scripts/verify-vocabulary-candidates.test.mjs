import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCandidateBatch, verifyCandidateBatch } from './verify-vocabulary-candidates.mjs';

test('the two sourced candidates remain review-only and preserve unknown pronunciation regions', () => {
  const { bundle, rows, sources } = loadCandidateBatch();
  const before = JSON.stringify({ bundle, rows, sources });
  assert.deepEqual(verifyCandidateBatch(bundle, rows, sources), {
    mode: 'review-only',
    candidates: 2,
    applied: 0,
    status: 'needs-review',
  });
  const crate = bundle.candidates.find((c) => c.word === 'crate');
  assert.deepEqual(crate.proposed.ukPhonetic, []);
  assert.deepEqual(crate.proposed.usPhonetic, []);
  assert.equal(JSON.stringify({ bundle, rows, sources }), before);
});

test('rejects existing-field overwrites, detached translations and inferred IPA regions', () => {
  for (const mutation of [
    ({ bundle, rows }) => {
      rows[bundle.candidates[0].row - 2]['释义'] = '已有释义';
      bundle.candidates[0].original.meaning = '已有释义';
    },
    ({ bundle }) => {
      bundle.candidates[0].proposed.meaning = ['n. 无来源的猜测'];
    },
    ({ bundle }) => {
      bundle.candidates[1].proposed.usPhonetic = ['/kɹeɪt/'];
    },
    ({ bundle }) => {
      bundle.candidates[0].status = 'approved';
    },
    ({ sources }) => {
      sources['espresso-en'].license.selected = 'MIT';
    },
  ]) {
    const data = loadCandidateBatch();
    mutation(data);
    assert.throws(() => verifyCandidateBatch(data.bundle, data.rows, data.sources));
  }
});
