import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTargetWordMatches } from '../lib/target-word-highlighting.ts';

test('matches complete target words case-insensitively and keeps their original offsets', () => {
  const text = 'Bright rooms are bright; brightness matters when rooms are brightly lit.';
  const matches = findTargetWordMatches(text, ['bright']);

  assert.deepEqual(
    matches.map(({ start, end, wordIndex }) => ({
      text: text.slice(start, end),
      wordIndex,
    })),
    [
      { text: 'Bright', wordIndex: 0 },
      { text: 'bright', wordIndex: 0 },
    ],
  );
});

test('does not highlight target substrings inside words, possessives, or compounds', () => {
  const text = "The artist can't start a cart; art is its own word.";
  const matches = findTargetWordMatches(text, ['art', 'can']);

  assert.deepEqual(
    matches.map(({ start, end, wordIndex }) => ({
      text: text.slice(start, end),
      wordIndex,
    })),
    [{ text: 'art', wordIndex: 0 }],
  );
});

test('matches multiword targets across repeated whitespace and favors the longer overlapping target', () => {
  const text = 'They help   people, then help themselves.';
  const matches = findTargetWordMatches(text, ['help', 'help people']);

  assert.deepEqual(
    matches.map(({ start, end, wordIndex }) => ({
      text: text.slice(start, end),
      wordIndex,
    })),
    [
      { text: 'help   people', wordIndex: 1 },
      { text: 'help', wordIndex: 0 },
    ],
  );
});

test('ignores empty targets and preserves punctuation around exact matches', () => {
  const text = '“Well-being,” matters.';
  const matches = findTargetWordMatches(text, ['', '  well-being  ']);

  assert.deepEqual(
    matches.map(({ start, end, wordIndex }) => ({
      text: text.slice(start, end),
      wordIndex,
    })),
    [{ text: 'Well-being', wordIndex: 1 }],
  );
});
