#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const batchRoot = resolve(root, 'data/vocabulary-candidates/2026-11-03');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const missing = (value) =>
  value === null || value === undefined || !String(value).trim() || value === '无';

/** Validates traceability and boundaries, not lexicographic truth. No writes or network. */
export function verifyCandidateBatch(bundle, rows, sources) {
  assert.equal(bundle.mode, 'review-only');
  assert.equal(bundle.applyAvailable, false);
  assert.equal(bundle.license, 'CC-BY-SA-4.0');
  assert.ok(bundle.candidates.length > 0 && bundle.candidates.length <= 20);
  const seen = new Set();
  for (const candidate of bundle.candidates) {
    assert.equal(candidate.status, 'needs-review');
    assert.ok(Number.isInteger(candidate.row) && candidate.row >= 2);
    assert.ok(!seen.has(candidate.word));
    seen.add(candidate.word);
    const original = rows[candidate.row - 2];
    assert.equal(original?.['单词'], candidate.word, 'candidate must match the exact source row');
    for (const [key, column] of [
      ['meaning', '释义'],
      ['ukPhonetic', '英音'],
      ['usPhonetic', '美音'],
    ]) {
      assert.equal(candidate.original[key], original[column], 'original value changed');
      assert.ok(Array.isArray(candidate.proposed[key]));
      if (candidate.proposed[key].length)
        assert.ok(missing(original[column]), 'must not replace existing content');
    }
    const source = sources[candidate.sourceId];
    assert.equal(source?.word, candidate.word);
    assert.equal(source.pos, candidate.pos);
    assert.equal(source.sense.label, candidate.sense);
    assert.equal(source.license.selected, bundle.license);
    assert.ok(source.license.attribution && source.license.changes);
    assert.ok(source.snapshot.dump && source.snapshot.extractedAt && source.snapshot.retrievedAt);
    assert.ok(
      source.url.startsWith('https://kaikki.org/') &&
        source.entry.startsWith('https://en.wiktionary.org/'),
    );
    assert.ok(source.history && source.sense.id);
    assert.equal(source.pos, 'noun');
    for (const value of candidate.proposed.meaning) {
      assert.ok(
        source.sense.chinese.some((text) => value === `n. ${text}`),
        'meaning must preserve a selected source translation',
      );
    }
    for (const [key, tags] of [
      ['ukPhonetic', ['Received-Pronunciation', 'UK']],
      ['usPhonetic', ['General-American', 'US']],
    ]) {
      for (const ipa of candidate.proposed[key]) {
        assert.ok(
          source.sounds.some(
            (sound) => sound.ipa === ipa && sound.tags.some((tag) => tags.includes(tag)),
          ),
          'IPA requires its own explicit region tag',
        );
      }
    }
  }
  return {
    mode: bundle.mode,
    candidates: bundle.candidates.length,
    applied: 0,
    status: 'needs-review',
  };
}

export function loadCandidateBatch() {
  const require = createRequire(import.meta.url);
  const XLSX = require('../apps/api/node_modules/xlsx');
  const bundle = JSON.parse(readFileSync(resolve(batchRoot, 'preview.json'), 'utf8'));
  assert.equal(bundle.book.path, 'apps/api/assets/vocabulary/通用/日常生活单词.xlsx');
  const bytes = readFileSync(resolve(root, bundle.book.path));
  assert.equal(hash(bytes), bundle.book.sha256, 'source workbook snapshot changed');
  const workbook = XLSX.read(bytes);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  const sources = {};
  for (const ref of bundle.sourceExcerpts) {
    assert.match(ref.file, /^sources\/[a-z-]+\.json$/);
    const bytes = readFileSync(resolve(batchRoot, ref.file));
    assert.equal(hash(bytes), ref.sha256, 'source excerpt snapshot changed');
    sources[ref.id] = JSON.parse(bytes);
  }
  return { bundle, rows, sources };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bundle, rows, sources } = loadCandidateBatch();
  console.log(JSON.stringify(verifyCandidateBatch(bundle, rows, sources), null, 2));
}
