import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNotebookContextPrompt } from '../lib/target-word-highlighting.ts';

test('blanks every complete case-insensitive phrase and preserves surrounding punctuation', () => {
  const prompt = buildNotebookContextPrompt(
    '“Take   it for granted,” and take it for granted.',
    'take it for granted',
  );

  assert.deepEqual(prompt, {
    parts: [
      { kind: 'text', value: '“' },
      { kind: 'blank', key: 0 },
      { kind: 'text', value: ',” and ' },
      { kind: 'blank', key: 1 },
      { kind: 'text', value: '.' },
    ],
    occurrenceCount: 2,
  });
  assert.equal(
    prompt.parts.some((part) => part.kind === 'text' && part.value.includes('take it for granted')),
    false,
  );
});

test('keeps hyphenated and apostrophe terms complete', () => {
  assert.deepEqual(
    buildNotebookContextPrompt("A well-being plan can't wait.", 'well-being')?.parts,
    [
      { kind: 'text', value: 'A ' },
      { kind: 'blank', key: 0 },
      { kind: 'text', value: " plan can't wait." },
    ],
  );
  assert.deepEqual(buildNotebookContextPrompt("A well-being plan can't wait.", "can't")?.parts, [
    { kind: 'text', value: 'A well-being plan ' },
    { kind: 'blank', key: 0 },
    { kind: 'text', value: ' wait.' },
  ]);
});

test('does not create a prompt from a substring, inflection, or missing example', () => {
  assert.equal(buildNotebookContextPrompt('The plans are brighter than expected.', 'bright'), null);
  assert.equal(buildNotebookContextPrompt('She walks home.', 'walk'), null);
  assert.equal(buildNotebookContextPrompt('An unrelated saved sentence.', 'deadline'), null);
  assert.equal(buildNotebookContextPrompt('', 'deadline'), null);
  assert.equal(buildNotebookContextPrompt('A deadline is set.', '  '), null);
});
