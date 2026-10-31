import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intervalGrowthLine } from '../lib/interval-growth.ts';

test('mentions only correct answers whose saved interval grew by at least two days', () => {
  assert.equal(
    intervalGrowthLine([
      { word: 'adapt', result: true, previousIntervalDays: 2, lastIntervalDays: 4 },
      { word: 'bright', result: true, previousIntervalDays: 3, lastIntervalDays: 4 },
      { word: 'calm', result: false, previousIntervalDays: 2, lastIntervalDays: 8 },
      { word: 'drift', result: true, previousIntervalDays: 0, lastIntervalDays: 1 },
    ]),
    '复习间隔拉长：adapt 从 2 天到 4 天。',
  );
  assert.equal(intervalGrowthLine([{ word: 'adapt', result: true, lastIntervalDays: 9 }]), null);
});
