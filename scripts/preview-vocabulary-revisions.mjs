#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const XLSX = require('../apps/api/node_modules/xlsx');

export const PREVIEW_LIMITS = Object.freeze({
  maxBooks: 500,
  maxDirectoryEntries: 10_000,
  maxDirectoryDepth: 32,
  maxCompressedBytesPerBook: 8 * 1024 * 1024,
  maxCompressedBytesPerRoot: 64 * 1024 * 1024,
  maxExpandedBytesPerBook: 32 * 1024 * 1024,
  maxExpandedBytesPerRoot: 512 * 1024 * 1024,
  maxRowsPerBook: 100_000,
  maxRowsPerRoot: 500_000,
  maxColumnsPerSheet: 32,
  maxTextLengthPerField: 2_048,
  maxDetailsPerCategory: 200,
  maxRowsPerConflictSample: 3,
  maxOutputBytes: 24 * 1024 * 1024,
});

const FIELD_NAMES = ['单词', '英音', '美音', '释义'];
const FIELD_KEYS = ['word', 'ukPhonetic', 'usPhonetic', 'meaning'];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE_ROOT = resolve(REPO_ROOT, 'apps/api/assets/vocabulary');

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeWord(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function fieldStatus(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim()))
    return 'blank';
  if (typeof value === 'string' && value.trim() === '无') return 'placeholder';
  return 'present';
}

function isEmptyRow(fields) {
  return Object.values(fields).every(
    (value) => value === null || value === undefined || value === '',
  );
}

function toPosixPath(path) {
  return path.split(sep).join('/');
}

function collectBooks(root) {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !lstatSync(absoluteRoot).isDirectory()) {
    throw new Error(`词表目录不存在或不是普通目录：${root}`);
  }

  const files = [];
  let compressedBytes = 0;
  let directoryEntries = 0;
  const visit = (directory, depth = 0) => {
    if (depth > PREVIEW_LIMITS.maxDirectoryDepth) {
      throw new Error(`词表目录层级超过 ${PREVIEW_LIMITS.maxDirectoryDepth} 层上限`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      directoryEntries += 1;
      if (directoryEntries > PREVIEW_LIMITS.maxDirectoryEntries) {
        throw new Error(`词表目录条目数超过 ${PREVIEW_LIMITS.maxDirectoryEntries} 上限`);
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`词表目录含符号链接，已拒绝不完整预览：${absolutePath}`);
      if (entry.isDirectory()) {
        visit(absolutePath, depth + 1);
      } else if (entry.isFile() && /\.xlsx$/i.test(entry.name) && !entry.name.startsWith('~$')) {
        const size = lstatSync(absolutePath).size;
        if (size > PREVIEW_LIMITS.maxCompressedBytesPerBook) {
          throw new Error(
            `单个 XLSX 超过 ${PREVIEW_LIMITS.maxCompressedBytesPerBook} bytes 上限：${absolutePath}`,
          );
        }
        compressedBytes += size;
        if (compressedBytes > PREVIEW_LIMITS.maxCompressedBytesPerRoot) {
          throw new Error(
            `词表目录压缩文件总量超过 ${PREVIEW_LIMITS.maxCompressedBytesPerRoot} bytes 上限`,
          );
        }
        files.push({
          absolutePath,
          relativePath: toPosixPath(relative(absoluteRoot, absolutePath)),
          size,
        });
        if (files.length > PREVIEW_LIMITS.maxBooks) {
          throw new Error(`词表文件数量超过 ${PREVIEW_LIMITS.maxBooks} 本上限`);
        }
      }
    }
  };
  visit(absoluteRoot);
  files.sort((a, b) => compareText(a.relativePath, b.relativePath));
  return { files, compressedBytes };
}

function zipExpandedBytes(buffer, filePath) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error(`不是完整的 XLSX/ZIP 文件：${filePath}`);

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error(`不支持多卷或 ZIP64 XLSX，已拒绝解析：${filePath}`);
  }
  if (entries > 10_000 || centralOffset + centralSize > eocd) {
    throw new Error(`XLSX ZIP 目录越界或条目过多：${filePath}`);
  }

  let offset = centralOffset;
  let totalExpanded = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > centralOffset + centralSize || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`XLSX ZIP 目录结构无效：${filePath}`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (flags & 1) throw new Error(`不支持加密 XLSX：${filePath}`);
    if (expandedSize === 0xffffffff) throw new Error(`不支持 ZIP64 XLSX：${filePath}`);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > centralOffset + centralSize) throw new Error(`XLSX ZIP 目录结构无效：${filePath}`);
    totalExpanded += expandedSize;
    if (totalExpanded > PREVIEW_LIMITS.maxExpandedBytesPerBook) {
      throw new Error(
        `单个 XLSX 解压后超过 ${PREVIEW_LIMITS.maxExpandedBytesPerBook} bytes 上限：${filePath}`,
      );
    }
  }
  if (offset !== centralOffset + centralSize)
    throw new Error(`XLSX ZIP 目录长度不匹配：${filePath}`);
  return totalExpanded;
}

function readBook(file, rootExpandedBytes) {
  const buffer = readFileSync(file.absolutePath);
  if (buffer.length !== file.size)
    throw new Error(`读取期间 XLSX 文件大小发生变化：${file.relativePath}`);
  const expandedBytes = zipExpandedBytes(buffer, file.relativePath);
  const nextExpandedBytes = rootExpandedBytes + expandedBytes;
  if (nextExpandedBytes > PREVIEW_LIMITS.maxExpandedBytesPerRoot) {
    throw new Error(`词表目录解压后总量超过 ${PREVIEW_LIMITS.maxExpandedBytesPerRoot} bytes 上限`);
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });
  } catch (error) {
    throw new Error(`无法读取 XLSX ${file.relativePath}：${error.message}`);
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet || !sheet['!ref']) throw new Error(`首个工作表为空：${file.relativePath}`);

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (rowCount > PREVIEW_LIMITS.maxRowsPerBook + 1) {
    throw new Error(`工作表超过 ${PREVIEW_LIMITS.maxRowsPerBook} 行上限：${file.relativePath}`);
  }
  if (columnCount > PREVIEW_LIMITS.maxColumnsPerSheet) {
    throw new Error(
      `首个工作表超过 ${PREVIEW_LIMITS.maxColumnsPerSheet} 列上限：${file.relativePath}`,
    );
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  const headers = rows[0]?.map((value) => String(value ?? '').trim()) ?? [];
  const fieldIndexes = FIELD_NAMES.map((name) => headers.indexOf(name));
  if (
    fieldIndexes.some((index) => index < 0) ||
    new Set(fieldIndexes).size !== FIELD_NAMES.length
  ) {
    throw new Error(`缺少或重复必需列（${FIELD_NAMES.join('、')}）：${file.relativePath}`);
  }

  const groups = new Map();
  const invalidRows = [];
  let dataRowCount = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index] ?? [];
    const fields = Object.fromEntries(
      FIELD_KEYS.map((key, fieldIndex) => [key, values[fieldIndexes[fieldIndex]] ?? null]),
    );
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' && value.length > PREVIEW_LIMITS.maxTextLengthPerField) {
        throw new Error(
          `字段 ${key} 超过 ${PREVIEW_LIMITS.maxTextLengthPerField} 个字符上限：${file.relativePath} 第 ${index + 1} 行`,
        );
      }
    }
    if (isEmptyRow(fields)) continue;
    dataRowCount += 1;
    if (dataRowCount > PREVIEW_LIMITS.maxRowsPerBook) {
      throw new Error(
        `工作表超过 ${PREVIEW_LIMITS.maxRowsPerBook} 条数据上限：${file.relativePath}`,
      );
    }
    const sourceRow = {
      rowNumber: index + 1,
      fields,
      fieldStatus: Object.fromEntries(FIELD_KEYS.map((key) => [key, fieldStatus(fields[key])])),
    };
    const normalized = normalizeWord(fields.word);
    if (!normalized) {
      invalidRows.push({ bookPath: file.relativePath, ...sourceRow, reason: 'blank-word' });
      continue;
    }
    const group = groups.get(normalized) ?? [];
    group.push(sourceRow);
    groups.set(normalized, group);
  }
  return { groups, invalidRows, dataRowCount, expandedBytes, nextExpandedBytes };
}

function sameFields(before, candidate) {
  return FIELD_KEYS.every((key) => Object.is(before.fields[key], candidate.fields[key]));
}

function hasDifferingRows(rows) {
  return rows.some((row) =>
    FIELD_KEYS.slice(1).some((key) => !Object.is(rows[0].fields[key], row.fields[key])),
  );
}

function countDetails() {
  const counts = Object.fromEntries(
    [
      'booksAdded',
      'booksMissing',
      'wordsAdded',
      'wordsMissing',
      'wordsChanged',
      'duplicates',
      'conflicts',
      'invalidRows',
      'unchangedWords',
    ]
      .filter((key) => key !== 'unchangedWords')
      .map((key) => [key, 0]),
  );
  const details = Object.fromEntries(Object.keys(counts).map((key) => [key, []]));
  const add = (key, value) => {
    counts[key] += 1;
    if (details[key].length < PREVIEW_LIMITS.maxDetailsPerCategory) details[key].push(value);
  };
  return { counts, details, add, unchangedWords: 0 };
}

function conflictRows(rows) {
  return {
    count: rows.length,
    sample: rows.slice(0, PREVIEW_LIMITS.maxRowsPerConflictSample),
    omittedRows: Math.max(0, rows.length - PREVIEW_LIMITS.maxRowsPerConflictSample),
  };
}

function compareBook(bookPath, baselineFile, candidateFile, state, rootTotals) {
  const baseline = baselineFile ? readBook(baselineFile, rootTotals.baselineExpandedBytes) : null;
  const candidate = candidateFile
    ? readBook(candidateFile, rootTotals.candidateExpandedBytes)
    : null;
  if (baseline) {
    rootTotals.baselineExpandedBytes = baseline.nextExpandedBytes;
    rootTotals.baselineRows += baseline.dataRowCount;
    if (rootTotals.baselineRows > PREVIEW_LIMITS.maxRowsPerRoot) {
      throw new Error(`基准词表总数据超过 ${PREVIEW_LIMITS.maxRowsPerRoot} 行上限`);
    }
  }
  if (candidate) {
    rootTotals.candidateExpandedBytes = candidate.nextExpandedBytes;
    rootTotals.candidateRows += candidate.dataRowCount;
    if (rootTotals.candidateRows > PREVIEW_LIMITS.maxRowsPerRoot) {
      throw new Error(`候选词表总数据超过 ${PREVIEW_LIMITS.maxRowsPerRoot} 行上限`);
    }
  }

  for (const row of baseline?.invalidRows ?? [])
    state.add('invalidRows', { ...row, side: 'baseline' });
  for (const row of candidate?.invalidRows ?? [])
    state.add('invalidRows', { ...row, side: 'candidate' });

  const keys = new Set([...(baseline?.groups.keys() ?? []), ...(candidate?.groups.keys() ?? [])]);
  for (const key of [...keys].sort(compareText)) {
    const beforeRows = baseline?.groups.get(key) ?? [];
    const candidateRows = candidate?.groups.get(key) ?? [];
    const hasDuplicates = beforeRows.length > 1 || candidateRows.length > 1;
    const conflictingDuplicates = hasDifferingRows(beforeRows) || hasDifferingRows(candidateRows);
    if (hasDuplicates) {
      state.add('duplicates', {
        bookPath,
        normalizedWord: key,
        baseline: conflictRows(beforeRows),
        candidate: conflictRows(candidateRows),
      });
    }
    if (conflictingDuplicates) {
      state.add('conflicts', {
        bookPath,
        normalizedWord: key,
        reason: 'duplicate-normalized-word-with-different-fields-in-same-book',
        baseline: conflictRows(beforeRows),
        candidate: conflictRows(candidateRows),
        candidateSource: candidateRows.length
          ? { provenance: 'missing', authorization: 'unverified' }
          : null,
      });
    } else if (!beforeRows.length) {
      const row = candidateRows[0];
      state.add('wordsAdded', {
        bookPath,
        normalizedWord: key,
        ...row,
        sourceProvenance: { status: 'missing', authorization: 'unverified' },
      });
    } else if (!candidateRows.length) {
      state.add('wordsMissing', { bookPath, normalizedWord: key, ...beforeRows[0] });
    } else if (!sameFields(beforeRows[0], candidateRows[0])) {
      const before = beforeRows[0];
      const next = candidateRows[0];
      const changedFields = FIELD_KEYS.filter(
        (field) => !Object.is(before.fields[field], next.fields[field]),
      ).map((field) => ({
        field,
        before: { raw: before.fields[field], status: before.fieldStatus[field] },
        candidate: { raw: next.fields[field], status: next.fieldStatus[field] },
      }));
      state.add('wordsChanged', {
        bookPath,
        normalizedWord: key,
        before,
        candidate: next,
        changedFields,
        sourceProvenance: { status: 'missing', authorization: 'unverified' },
      });
    } else {
      state.unchangedWords += 1;
    }
  }
  return {
    baselineRows: baseline?.dataRowCount ?? 0,
    candidateRows: candidate?.dataRowCount ?? 0,
  };
}

export function createVocabularyRevisionPreview({
  baselineRoot = DEFAULT_BASELINE_ROOT,
  candidateRoot,
} = {}) {
  if (!candidateRoot) throw new Error('必须指定 --candidate-root 候选目录');
  const baseline = collectBooks(baselineRoot);
  const candidate = collectBooks(candidateRoot);
  if (!candidate.files.length) throw new Error('候选目录中没有可比较的 .xlsx 文件');

  const baselineByPath = new Map(baseline.files.map((file) => [file.relativePath, file]));
  const candidateByPath = new Map(candidate.files.map((file) => [file.relativePath, file]));
  const paths = [...new Set([...baselineByPath.keys(), ...candidateByPath.keys()])].sort(
    compareText,
  );
  const state = countDetails();
  const rootTotals = {
    baselineExpandedBytes: 0,
    candidateExpandedBytes: 0,
    baselineRows: 0,
    candidateRows: 0,
  };

  for (const path of paths) {
    const before = baselineByPath.get(path);
    const next = candidateByPath.get(path);
    const rowCounts = compareBook(path, before, next, state, rootTotals);
    if (!before)
      state.add('booksAdded', { bookPath: path, candidateRows: rowCounts.candidateRows });
    if (!next) state.add('booksMissing', { bookPath: path, baselineRows: rowCounts.baselineRows });
  }

  const truncated = Object.fromEntries(
    Object.entries(state.counts).map(([key, count]) => [
      key,
      Math.max(0, count - state.details[key].length),
    ]),
  );
  const report = {
    schemaVersion: 1,
    mode: 'read-only-preview',
    candidateSource: {
      provenance: 'missing',
      authorization: 'unverified',
      note: null,
      explanation: '候选数据的来源说明未提供；仓库现有词表文件不代表外部复制或补充来源已获授权。',
    },
    limits: PREVIEW_LIMITS,
    inputs: {
      baselineBookCount: baseline.files.length,
      baselineCompressedBytes: baseline.compressedBytes,
      candidateBookCount: candidate.files.length,
      candidateCompressedBytes: candidate.compressedBytes,
      baselineRows: rootTotals.baselineRows,
      candidateRows: rootTotals.candidateRows,
    },
    summary: { ...state.counts, unchangedWords: state.unchangedWords },
    details: state.details,
    omittedDetails: truncated,
    applyAvailable: false,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > PREVIEW_LIMITS.maxOutputBytes) {
    throw new Error(
      `预览结果超过 ${PREVIEW_LIMITS.maxOutputBytes} bytes 上限；请按词书或目录分批比较`,
    );
  }
  return report;
}

function printUsage() {
  console.error(
    '用法：node scripts/preview-vocabulary-revisions.mjs --candidate-root <候选词表目录> [--baseline-root <基准目录>]\n' +
      '默认基准目录为 apps/api/assets/vocabulary。结果仅输出 JSON 到 stdout，不连接数据库且不会写入文件。',
  );
}

function parseArgs(argv) {
  const options = { baselineRoot: DEFAULT_BASELINE_ROOT };
  const seenOptions = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg !== '--candidate-root' && arg !== '--baseline-root') {
      throw new Error(`未知参数：${arg}`);
    }
    if (seenOptions.has(arg)) throw new Error(`参数不能重复：${arg}`);
    seenOptions.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少目录值`);
    options[arg === '--candidate-root' ? 'candidateRoot' : 'baselineRoot'] = resolve(value);
    index += 1;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      process.stdout.write(`${JSON.stringify(createVocabularyRevisionPreview(options))}\n`);
    }
  } catch (error) {
    printUsage();
    console.error(error.message);
    process.exitCode = 1;
  }
}
