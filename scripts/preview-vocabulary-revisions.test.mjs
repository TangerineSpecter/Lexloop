import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import {
  createVocabularyRevisionPreview,
  PREVIEW_LIMITS,
} from './preview-vocabulary-revisions.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('../apps/api/node_modules/xlsx');

async function makeRoots(t) {
  const root = await mkdtemp(join(tmpdir(), 'lexloop-vocabulary-preview-'));
  const baselineRoot = join(root, 'baseline');
  const candidateRoot = join(root, 'candidate');
  await mkdir(baselineRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { baselineRoot, candidateRoot };
}

async function writeBook(root, relativePath, rows) {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['单词', '英音', '美音', '释义'], ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, '词表');
  XLSX.writeFile(workbook, path);
}

async function snapshot(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const bytes = await readFile(path);
        files.push([
          relative(root, path).replaceAll('\\', '/'),
          createHash('sha256').update(bytes).digest('hex'),
        ]);
      }
    }
  };
  await visit(root);
  return files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

test('compares book context, field changes, additions, missing rows, duplicates, and source status without writing', async (t) => {
  const { baselineRoot, candidateRoot } = await makeRoots(t);
  await writeBook(baselineRoot, '通用/A.xlsx', [
    ['Apple', '/ˈæp.əl/', 'ˈæp.əl', 'n. 苹果'],
    ['lead', 'liːd', 'liːd', '无'],
    ['gone', '', '', 'v. 离开'],
    ['dup', '', '', 'n. 旧值'],
  ]);
  await writeBook(baselineRoot, '通用/B.xlsx', [
    ['lead', '', '', 'n. 引导'],
    ['echo', '', '', 'v. 回声'],
    [' echo ', '', '', 'v. 回声'],
  ]);
  await writeBook(candidateRoot, '通用/A.xlsx', [
    ['apple', '/ˈæp.əl/', 'ˈæp.əl', 'n. 苹果；果实'],
    ['lead', 'liːd', 'liːd', ''],
    ['dup', '', '', 'n. 候选甲'],
    [' DUP ', '', '', 'n. 候选乙'],
    ['new word', '', '', '无'],
    ['', '', '', '有字段但没有词面'],
  ]);
  await writeBook(candidateRoot, '通用/B.xlsx', [
    ['lead', '', '', 'n. 引导'],
    ['echo', '', '', 'v. 回声'],
    ['ECHO', '', '', 'v. 回声'],
  ]);
  await writeBook(candidateRoot, '通用/C.xlsx', [['lead', '', '', 'v. 领导']]);

  const beforeBaseline = await snapshot(baselineRoot);
  const beforeCandidate = await snapshot(candidateRoot);
  const first = createVocabularyRevisionPreview({ baselineRoot, candidateRoot });
  const second = createVocabularyRevisionPreview({ baselineRoot, candidateRoot });

  assert.deepEqual(second, first, 'the same read-only inputs produce the same report');
  assert.deepEqual(
    await snapshot(baselineRoot),
    beforeBaseline,
    'the baseline XLSX files remain byte-identical',
  );
  assert.deepEqual(
    await snapshot(candidateRoot),
    beforeCandidate,
    'the candidate XLSX files remain byte-identical',
  );
  assert.equal(first.applyAvailable, false);
  assert.deepEqual(first.candidateSource, {
    provenance: 'missing',
    authorization: 'unverified',
    note: null,
    explanation: '候选数据的来源说明未提供；仓库现有词表文件不代表外部复制或补充来源已获授权。',
  });
  assert.equal(first.summary.booksAdded, 1);
  assert.equal(first.summary.wordsAdded, 2);
  assert.equal(first.summary.wordsMissing, 1);
  assert.equal(first.summary.wordsChanged, 2);
  assert.equal(first.summary.duplicates, 2);
  assert.equal(first.summary.conflicts, 1);
  assert.equal(first.summary.invalidRows, 1);
  assert.equal(first.summary.unchangedWords, 2);
  assert.ok(first.details.conflicts[0].candidate.count === 2);
  assert.equal(
    first.details.conflicts[0].normalizedWord,
    'dup',
    'different duplicate rows in the same book are conflicts',
  );
  assert.equal(
    first.details.duplicates.find((duplicate) => duplicate.normalizedWord === 'echo') !== undefined,
    true,
    'identical duplicate rows are visible but not treated as a meaning conflict',
  );

  const leadChange = first.details.wordsChanged.find((change) => change.normalizedWord === 'lead');
  assert.deepEqual(leadChange.changedFields, [
    {
      field: 'meaning',
      before: { raw: '无', status: 'placeholder' },
      candidate: { raw: '', status: 'blank' },
    },
  ]);
  assert.equal(
    leadChange.candidate.fields.meaning,
    '',
    'raw candidate values are not normalized or auto-filled',
  );
  assert.equal(
    first.details.wordsAdded.find((word) => word.normalizedWord === 'new word').fields.meaning,
    '无',
  );
  assert.equal(
    first.details.wordsAdded.find((word) => word.normalizedWord === 'new word').sourceProvenance
      .status,
    'missing',
  );
  assert.equal(
    first.details.conflicts.some((conflict) => conflict.normalizedWord === 'lead'),
    false,
    'different meanings in separate books are separate book contexts, not a conflict',
  );
  assert.equal(first.details.booksAdded[0].candidateRows, 1);
});

test('caps output details while accurately counting a large synthetic workbook diff', async (t) => {
  const { baselineRoot, candidateRoot } = await makeRoots(t);
  const rows = Array.from({ length: 10_000 }, (_, index) => [
    `word-${index}`,
    '',
    '',
    `n. old meaning ${index}`,
  ]);
  const candidateRows = rows.map(([word, uk, us, meaning]) => [word, uk, us, `${meaning} changed`]);
  await writeBook(baselineRoot, '专项/synthetic.xlsx', rows);
  await writeBook(candidateRoot, '专项/synthetic.xlsx', candidateRows);

  const started = performance.now();
  const report = createVocabularyRevisionPreview({ baselineRoot, candidateRoot });
  const elapsedMs = performance.now() - started;

  assert.equal(report.summary.wordsChanged, rows.length);
  assert.equal(report.details.wordsChanged.length, PREVIEW_LIMITS.maxDetailsPerCategory);
  assert.equal(
    report.omittedDetails.wordsChanged,
    rows.length - PREVIEW_LIMITS.maxDetailsPerCategory,
  );
  assert.ok(elapsedMs < 20_000, `10k-row local comparison took ${elapsedMs.toFixed(0)}ms`);
  t.diagnostic(
    `10k-row synthetic diff: ${elapsedMs.toFixed(0)}ms; details capped at ${PREVIEW_LIMITS.maxDetailsPerCategory}`,
  );
});

test('fails closed for missing required columns and oversized candidate files', async (t) => {
  const { baselineRoot, candidateRoot } = await makeRoots(t);
  await writeBook(baselineRoot, '通用/base.xlsx', [['hello', '', '', 'n. 你好']]);
  const invalidPath = join(candidateRoot, '通用/invalid.xlsx');
  await mkdir(join(invalidPath, '..'), { recursive: true });
  const invalidWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    invalidWorkbook,
    XLSX.utils.aoa_to_sheet([
      ['word', 'meaning'],
      ['hello', '你好'],
    ]),
    'Sheet1',
  );
  XLSX.writeFile(invalidWorkbook, invalidPath);
  assert.throws(
    () => createVocabularyRevisionPreview({ baselineRoot, candidateRoot }),
    /缺少或重复必需列/,
  );

  await rm(invalidPath);
  await writeBook(candidateRoot, '通用/long.xlsx', [
    ['long', '', '', 'x'.repeat(PREVIEW_LIMITS.maxTextLengthPerField + 1)],
  ]);
  assert.throws(() => createVocabularyRevisionPreview({ baselineRoot, candidateRoot }), /字符上限/);
  await rm(join(candidateRoot, '通用/long.xlsx'));

  const oversizedRoot = join(candidateRoot, 'oversized');
  await mkdir(oversizedRoot, { recursive: true });
  await writeFile(
    join(oversizedRoot, 'too-large.xlsx'),
    Buffer.alloc(PREVIEW_LIMITS.maxCompressedBytesPerBook + 1),
  );
  assert.throws(
    () => createVocabularyRevisionPreview({ baselineRoot, candidateRoot: oversizedRoot }),
    /超过 .* 上限/,
  );

  await symlink(join(baselineRoot, '通用/base.xlsx'), join(candidateRoot, 'linked.xlsx'));
  assert.throws(() => createVocabularyRevisionPreview({ baselineRoot, candidateRoot }), /符号链接/);
});
