import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getMistakeLearningDirection,
  MISTAKE_LEARNING_DIRECTIONS,
} from '../lib/mistake-learning-directions.ts';

test('maps only the supported question and learning-practice types to their documented purpose', () => {
  assert.deepEqual(Object.keys(MISTAKE_LEARNING_DIRECTIONS).sort(), [
    'CONFUSION',
    'MEANING_RECOGNITION',
    'OUTPUT',
    'READING_COMPREHENSION',
    'SYNONYM_REPLACEMENT',
    'WORD_MATCHING',
    'WORD_MNEMONIC',
  ]);
  for (const [type, direction] of Object.entries(MISTAKE_LEARNING_DIRECTIONS)) {
    assert.ok(direction.label, `${type} has a learner-facing label`);
    assert.ok(direction.focus, `${type} has a type-level purpose`);
    assert.ok(direction.nextStep, `${type} points to an existing next step`);
    assert.equal(getMistakeLearningDirection(type), direction);
  }
});

test('keeps daily output and confusion on their existing practice routes without claiming the selected word carries over', () => {
  const output = getMistakeLearningDirection('OUTPUT');
  const confusion = getMistakeLearningDirection('CONFUSION');
  assert.deepEqual(output?.route, {
    href: '/dashboard/practice?tab=output',
    label: '打开每日输出',
  });
  assert.deepEqual(confusion?.route, {
    href: '/dashboard/practice?tab=confusion',
    label: '打开易混词训练',
  });
  assert.match(output?.nextStep ?? '', /不会自动带入/);
  assert.match(confusion?.nextStep ?? '', /不会自动带入/);
});

test('does not guess a learning direction for unknown or mixed legacy question types', () => {
  assert.equal(getMistakeLearningDirection('OTHER'), null);
  assert.equal(getMistakeLearningDirection('ADVENTURE_BATTLE_ACTION'), null);
  assert.equal(getMistakeLearningDirection('WORD_MATCHING+READING_COMPREHENSION'), null);
});
