import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareSpelling,
  normalizeSpelling,
} from '../components/learning-lab/spelling-difference.ts';

test('comparison ignores case and repeated whitespace like answer checking', () => {
  assert.equal(normalizeSpelling('  Take\n  IT for granted  '), 'take it for granted');
  const result = compareSpelling(' TAKE   IT FOR GRANTED ', 'take it for granted');
  assert.equal(result.equal, true);
  assert.equal(result.alignable, true);
  assert.deepEqual(result.issues, []);
});

test('substitutions identify the entered and expected characters', () => {
  const result = compareSpelling('wrold', 'world');
  assert.equal(result.equal, false);
  assert.deepEqual(
    result.issues.map(({ kind, entered, expected }) => ({ kind, entered, expected })),
    [
      { kind: 'substitution', entered: 'r', expected: 'o' },
      { kind: 'substitution', entered: 'o', expected: 'r' },
    ],
  );
});

test('extra and missing characters are reported separately', () => {
  assert.deepEqual(compareSpelling('runn', 'run').issues, [{ kind: 'extra', entered: 'n' }]);
  assert.deepEqual(compareSpelling('frequntly', 'frequently').issues, [
    { kind: 'missing', expected: 'e' },
  ]);
});

test('repeated characters align to the omitted position', () => {
  assert.deepEqual(compareSpelling('bok', 'book').issues, [{ kind: 'missing', expected: 'o' }]);
});

test('punctuation remains part of the spelling comparison', () => {
  assert.deepEqual(compareSpelling('wellbeing', 'well-being').issues, [
    { kind: 'missing', expected: '-' },
  ]);
});

test('empty input is represented as missing characters without inventing a match', () => {
  const result = compareSpelling('', 'word');
  assert.equal(result.equal, false);
  assert.deepEqual(result.issues, [
    { kind: 'missing', expected: 'w' },
    { kind: 'missing', expected: 'o' },
    { kind: 'missing', expected: 'r' },
    { kind: 'missing', expected: 'd' },
  ]);
});

test('very long answers skip detailed alignment within a fixed work bound', () => {
  const result = compareSpelling('a'.repeat(241), 'a');
  assert.equal(result.equal, false);
  assert.equal(result.alignable, false);
  assert.deepEqual(result.issues, []);
});
