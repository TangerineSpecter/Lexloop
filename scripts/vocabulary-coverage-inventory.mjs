#!/usr/bin/env node
// Read-only triage. A single-token candidate is not a validated dictionary entry.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const XLSX = require('../apps/api/node_modules/xlsx');
const path = fileURLToPath(
  new URL('../apps/api/assets/vocabulary/通用/日常生活单词.xlsx', import.meta.url),
);
const bytes = readFileSync(path);
const book = XLSX.read(bytes);
const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
const missing = rows.flatMap((r, i) =>
  !String(r.释义).trim() || r.释义 === '无' ? [{ row: i + 2, word: r.单词 }] : [],
);
const single = missing.filter((r) => /^[a-z]+(?:[-'][a-z]+)*$/i.test(r.word));
console.log(
  JSON.stringify(
    {
      mode: 'triage-only',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rows: rows.length,
      missingMeanings: missing.length,
      singleTokenCandidates: single.length,
      needsWordBoundaryReview: missing.length - single.length,
      candidates: single,
      applied: 0,
    },
    null,
    2,
  ),
);
