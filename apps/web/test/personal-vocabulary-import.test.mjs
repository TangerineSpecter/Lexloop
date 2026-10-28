import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePersonalVocabularyTsv } from '../lib/personal-vocabulary-import.ts';

test('parses two or three TSV columns, trims words and previews duplicates', () => {
  assert.deepEqual(
    parsePersonalVocabularyTsv(
      ' look   forward to \t期待\tI look forward to Sunday.\nNOTICE\t注意到\nnotice\t另一个释义',
    ),
    {
      items: [
        { text: 'look forward to', meaning: '期待', example: 'I look forward to Sunday.' },
        { text: 'NOTICE', meaning: '注意到' },
      ],
      duplicates: 1,
      rowCount: 3,
      errors: [],
    },
  );
});

test('ignores a UTF-8 byte-order mark copied from an exported vocabulary file', () => {
  assert.deepEqual(parsePersonalVocabularyTsv('\uFEFFriver\t河流'), {
    items: [{ text: 'river', meaning: '河流' }],
    duplicates: 0,
    rowCount: 1,
    errors: [],
  });
});

test('rejects malformed, empty and overlong rows instead of partially accepting them', () => {
  const preview = parsePersonalVocabularyTsv(
    `river\t\n\t释义\nextra\t列\ttoo\tmany\n${'x'.repeat(121)}\t词义`,
  );
  assert.equal(preview.items.length, 0);
  assert.equal(preview.errors.length, 4);
  assert.deepEqual(parsePersonalVocabularyTsv(''), {
    items: [],
    duplicates: 0,
    rowCount: 0,
    errors: [],
  });
});

test('caps source rows at forty and blocks the entire oversized paste', () => {
  const preview = parsePersonalVocabularyTsv(
    Array.from({ length: 41 }, (_, index) => `word${index}\t词义${index}`).join('\n'),
  );
  assert.equal(preview.rowCount, 41);
  assert.equal(preview.items.length, 40);
  assert.equal(preview.errors.length, 1);
  assert.match(preview.errors[0].message, /最多导入 40 行/);
});
