import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTargetExcerpt } from '../lib/output-word-evidence.ts';

test('matches case-insensitively and preserves surrounding punctuation', () => {
  const excerpt = findTargetExcerpt('She said “APPROACH,” then left.', 'approach');

  assert.deepEqual(excerpt, {
    before: 'She said “',
    match: 'APPROACH',
    after: ',” then left.',
  });
});

test('matches the target spelling around hyphens and apostrophes', () => {
  assert.equal(findTargetExcerpt('A well-known fact.', 'well-known')?.match, 'well-known');
  assert.equal(findTargetExcerpt('“CAN’T,” she said.', 'CAN’T')?.match, 'CAN’T');
  assert.equal(findTargetExcerpt("“CAN'T,” she said.", "can't")?.match, "CAN'T");
});

test('matches a complete phrase across spacing and line breaks with surrounding punctuation', () => {
  const excerpt = findTargetExcerpt('We might MISS   the\nbus, today.', 'miss the bus');

  assert.equal(excerpt?.match, 'MISS   the\nbus');
  assert.equal(findTargetExcerpt('We might dismiss the bus today.', 'miss the bus'), null);
  assert.equal(findTargetExcerpt('We might miss the buses today.', 'miss the bus'), null);
  assert.equal(findTargetExcerpt('We might miss-the-bus today.', 'miss the bus'), null);
});

test('respects complete-word boundaries instead of matching substrings or inflections', () => {
  assert.equal(findTargetExcerpt('The party started early.', 'art'), null);
  assert.equal(findTargetExcerpt('This is effective.', 'effect'), null);
  assert.equal(findTargetExcerpt('I approached the problem.', 'approach'), null);
});

test('returns the first occurrence when a target appears more than once', () => {
  const excerpt = findTargetExcerpt('Approach one; approach two.', 'approach');

  assert.equal(excerpt?.match, 'Approach');
  assert.equal(excerpt?.before, '');
});

test('keeps a bounded excerpt from a long answer while retaining the full match', () => {
  const answer = `Opening. ${'ordinary words '.repeat(100)}distinctive ${'later words '.repeat(100)}`;
  const excerpt = findTargetExcerpt(answer, 'distinctive');

  assert.ok(excerpt);
  assert.equal(excerpt.match, 'distinctive');
  assert.ok(excerpt.before.length + excerpt.match.length + excerpt.after.length <= 140);
  assert.ok(excerpt.before.startsWith('…'));
  assert.ok(excerpt.after.endsWith('…'));
});
