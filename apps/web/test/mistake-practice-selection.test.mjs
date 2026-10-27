import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partitionMistakePracticeSelection } from '../lib/mistake-practice-selection.ts';

const items = [
  { bookWordId: 'standard', weaknesses: [{ questionType: 'READING_COMPREHENSION' }] },
  { bookWordId: 'output', weaknesses: [{ questionType: 'OUTPUT' }] },
  { bookWordId: 'confusion', weaknesses: [{ questionType: 'CONFUSION' }] },
  {
    bookWordId: 'mixed',
    weaknesses: [
      { questionType: 'WORD_MATCHING' },
      { questionType: 'CONFUSION' },
      { questionType: 'OUTPUT' },
    ],
  },
];

test('keeps ordinary and special practice paths explicit for a mixed selection', () => {
  assert.deepEqual(partitionMistakePracticeSelection(items, ['output', 'standard', 'confusion']), {
    standardWordIds: ['standard'],
    outputWordIds: ['output'],
    confusionWordIds: ['confusion'],
  });
});

test('does not send words with special weaknesses to an incompatible objective plan', () => {
  assert.deepEqual(partitionMistakePracticeSelection(items, ['mixed']), {
    standardWordIds: [],
    outputWordIds: ['mixed'],
    confusionWordIds: ['mixed'],
  });
});

test('preserves selection order and ignores duplicate or stale ids', () => {
  assert.deepEqual(
    partitionMistakePracticeSelection(items, ['confusion', 'missing', 'standard', 'confusion']),
    {
      standardWordIds: ['standard'],
      outputWordIds: [],
      confusionWordIds: ['confusion'],
    },
  );
});
