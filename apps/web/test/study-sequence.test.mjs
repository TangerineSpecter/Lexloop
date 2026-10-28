import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { studyGroupCompletion } from '../lib/study-sequence.ts';

test('study sequence follows saved group completion and finds the next unfinished group', () => {
  const groups = [
    [{ completed: true }, { completed: true }],
    [{ completed: false }],
    [{ completed: false }],
  ];

  assert.deepEqual(studyGroupCompletion(groups), {
    completedGroups: [true, false, false],
    currentGroupIndex: 1,
  });
  assert.deepEqual(studyGroupCompletion([[{ completed: false }], [{ completed: false }]]), {
    completedGroups: [false, false],
    currentGroupIndex: 0,
  });
  assert.deepEqual(studyGroupCompletion([[{ completed: true }], [{ completed: true }]]), {
    completedGroups: [true, true],
    currentGroupIndex: -1,
  });
  assert.deepEqual(studyGroupCompletion([]), {
    completedGroups: [],
    currentGroupIndex: -1,
  });
});

test('study sequence status stays bounded for the maximum 140-word plan', (t) => {
  const groupSizes = [2, 3, 4, 5];
  const groups = [];
  let wordsLeft = 140;
  let groupIndex = 0;
  while (wordsLeft > 0) {
    const size = Math.min(groupSizes[groupIndex % groupSizes.length], wordsLeft);
    groups.push(Array.from({ length: size }, (_, index) => ({ completed: index % 2 === 0 })));
    wordsLeft -= size;
    groupIndex += 1;
  }

  const start = performance.now();
  let result;
  for (let index = 0; index < 1_000; index += 1) result = studyGroupCompletion(groups);
  const elapsed = performance.now() - start;
  assert.equal(
    groups.reduce((sum, group) => sum + group.length, 0),
    140,
  );
  assert.equal(result.completedGroups.length, groups.length);
  assert.equal(
    result.currentGroupIndex,
    groups.findIndex((group) => group.some((word) => !word.completed)),
  );
  t.diagnostic(
    `study group status: 140 words/${groups.length} groups × 1,000 calculations in ${elapsed.toFixed(1)} ms`,
  );
});
