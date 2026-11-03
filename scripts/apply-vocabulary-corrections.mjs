#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const XLSX = require('../apps/api/node_modules/xlsx');
export const batch = resolve(root, 'data/vocabulary-corrections/2026-11-03');
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function loadCorrections() {
  const manifest = JSON.parse(readFileSync(resolve(batch, 'manifest.json')));
  assert.equal(
    manifest.baseline.file,
    'data/vocabulary-candidates/2026-11-03/source-workbook.xlsx',
  );
  assert.equal(manifest.target, 'apps/api/assets/vocabulary/通用/日常生活单词.xlsx');
  const baseline = readFileSync(resolve(root, manifest.baseline.file));
  assert.equal(hash(baseline), manifest.baseline.sha256);
  const sources = {};
  for (const ref of manifest.sources) {
    assert.match(ref.file, /^sources\/[a-z-]+\.json$/);
    const bytes = readFileSync(resolve(batch, ref.file));
    assert.equal(hash(bytes), ref.sha256);
    assert.ok(!sources[ref.id]);
    sources[ref.id] = JSON.parse(bytes);
  }
  return { manifest, baseline, sources };
}
export function correctedWorkbook(manifest, baseline, sources) {
  assert.equal(manifest.scope, 'source-workbook-only');
  assert.equal(manifest.license, 'CC-BY-SA-4.0');
  assert.ok(manifest.entries.length > 0 && manifest.entries.length <= 20);
  const workbook = XLSX.read(baseline);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  assert.deepEqual(rows[0], ['单词', '英音', '美音', '释义']);
  const seen = new Set();
  const credits = [
    ['word', 'fields', 'author', 'source', 'history', 'snapshot', 'license', 'changes', 'review'],
  ];
  for (const entry of manifest.entries) {
    assert.ok(Number.isInteger(entry.row) && entry.row >= 2);
    assert.equal(rows[entry.row - 1]?.[0], entry.word);
    assert.ok(!seen.has(entry.word));
    seen.add(entry.word);
    assert.equal(entry.review.kind, 'assistant-source-review');
    assert.equal(entry.review.humanApproval, null);
    assert.ok(entry.review.rationale && entry.review.reviewedAt);
    assert.deepEqual(
      entry.review.context,
      rows.slice(entry.row - 3, entry.row + 2).map((r) => r[0]),
    );
    const source = sources[entry.sourceId];
    assert.equal(source.word, entry.word);
    assert.equal(source.pos, 'noun');
    assert.ok(source.sense.id && source.history && source.entry && source.url);
    assert.equal(source.license.selected, manifest.license);
    assert.ok(source.license.attribution && source.license.url && source.license.changes);
    assert.ok(
      source.snapshot.retrievedAt &&
        (source.snapshot.revision || (source.snapshot.dump && source.snapshot.extractedAt)),
    );
    const columns = new Set();
    assert.ok(entry.changes.length > 0);
    for (const change of entry.changes) {
      assert.ok(['释义', '英音', '美音'].includes(change.column));
      assert.ok(!columns.has(change.column));
      columns.add(change.column);
      const col = rows[0].indexOf(change.column);
      assert.equal(rows[entry.row - 1][col], change.from);
      assert.ok(
        change.from === '无' || !String(change.from ?? '').trim(),
        'cannot overwrite existing value',
      );
      if (change.column === '释义') {
        assert.ok(
          source.sense.chinese.some((t) => change.to === `n. ${t}`),
          'translation must match selected sense',
        );
      } else {
        const tags =
          change.column === '英音' ? ['UK', 'Received-Pronunciation'] : ['US', 'General-American'];
        assert.ok(
          source.sounds.some((s) => s.ipa === change.to && s.tags.some((t) => tags.includes(t))),
          'IPA must carry its own region',
        );
      }
      const address = XLSX.utils.encode_cell({ r: entry.row - 1, c: col });
      sheet[address] = { t: 's', v: change.to };
    }
    credits.push([
      entry.word,
      entry.changes.map((c) => c.column).join(', '),
      source.license.attribution,
      source.url,
      source.history,
      JSON.stringify(source.snapshot),
      source.license.url,
      'Selected Chinese noun translation; added n. prefix; selected explicitly regional IPA. No audio/images/examples.',
      entry.review.kind,
    ]);
  }
  assert.ok(!workbook.SheetNames.includes('来源与许可'));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(credits), '来源与许可');
  return workbook;
}
export function workbookValues(workbook) {
  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }),
  }));
}
export function verifyApplied(manifest, baseline, sources, actual) {
  assert.deepEqual(
    workbookValues(XLSX.read(actual)),
    workbookValues(correctedWorkbook(manifest, baseline, sources)),
    'workbook differs from reviewed patch',
  );
  const rows = workbookValues(XLSX.read(actual))[0].rows.slice(1);
  const missing = (col) =>
    rows.filter((r) => !String(r[col] ?? '').trim() || r[col] === '无').length;
  return {
    sourceWords: manifest.entries.length,
    sourceFields: manifest.entries.reduce((n, e) => n + e.changes.length, 0),
    existingDatabaseApplied: 0,
    rows: rows.length,
    remaining: { meaning: missing(3), ukPhonetic: missing(1), usPhonetic: missing(2) },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || (args.length === 1 && args[0] === '--apply-source'),
    'Usage: node scripts/apply-vocabulary-corrections.mjs [--apply-source]',
  );
  const { manifest, baseline, sources } = loadCorrections();
  const target = resolve(root, manifest.target);
  const current = readFileSync(target);
  const expected = correctedWorkbook(manifest, baseline, sources);
  if (args[0] === '--apply-source' && hash(current) === manifest.baseline.sha256) {
    const output = XLSX.write(expected, { type: 'buffer', bookType: 'xlsx', compression: true });
    verifyApplied(manifest, baseline, sources, output);
    // Only an exact baseline can be modified. No database access or network.
    assert.equal(hash(readFileSync(target)), manifest.baseline.sha256);
    const temporary = target + '.reviewed.tmp';
    writeFileSync(temporary, output, { flag: 'wx' });
    renameSync(temporary, target);
  }
  console.log(
    JSON.stringify(verifyApplied(manifest, baseline, sources, readFileSync(target)), null, 2),
  );
}
