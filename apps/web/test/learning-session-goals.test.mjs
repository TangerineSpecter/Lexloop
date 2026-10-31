import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dailyGoalStatusText,
  goalCelebrationDecision,
  parseDailyGoal,
  parseGoalOption,
} from '../lib/daily-goal.ts';
import { reviewDueReason } from '../lib/review-due-reason.ts';
import {
  QUICK_DRILL_WORD_COUNT,
  readQuickDrillPlanId,
  rememberQuickDrill,
} from '../lib/quick-drill.ts';
import { wrongRetestPlan } from '../lib/wrong-item-retest.ts';

test('keeps the daily goal on one learning activity or a small review count', () => {
  assert.deepEqual(parseGoalOption('activity'), { kind: 'activity', target: 1 });
  assert.deepEqual(parseGoalOption('reviews:10'), { kind: 'reviews', target: 10 });
  assert.equal(parseGoalOption('reviews:7'), null);
  assert.equal(parseDailyGoal({ kind: 'activity', target: 2, progress: 1, met: false }), null);
  assert.equal(
    dailyGoalStatusText({ kind: 'reviews', target: 5, progress: 2, met: false }),
    '今日目标：复习 5 个词 · 2/5',
  );
});

test('celebrates only the first time today’s goal changes from unmet to met', () => {
  const first = goalCelebrationDecision(null, '2026-10-31', false);
  assert.equal(first.show, false);
  const alreadyMet = goalCelebrationDecision(null, '2026-10-31', true);
  assert.equal(alreadyMet.show, false);
  const met = goalCelebrationDecision(first.next, '2026-10-31', true);
  assert.equal(met.show, true);
  const again = goalCelebrationDecision(met.next, '2026-10-31', true);
  assert.equal(again.show, false);
  const dismissed = goalCelebrationDecision({ ...met.next, dismissed: true }, '2026-10-31', true);
  assert.equal(dismissed.show, false);
  const nextDay = goalCelebrationDecision(dismissed.next, '2026-11-01', false);
  assert.equal(nextDay.show, false);
  assert.equal(nextDay.next.met, false);
});

test('explains a due review from saved interval fields and hides words that are not due', () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  assert.equal(
    reviewDueReason({
      now,
      lastReviewedAt: '2026-10-28T12:00:00.000Z',
      nextReviewAt: '2026-10-31T08:00:00.000Z',
      lastIntervalDays: 3,
      timeZone: 'UTC',
    }),
    '距上次复习 3 天 · 计划间隔 3 天',
  );
  assert.equal(
    reviewDueReason({
      now,
      lastReviewedAt: null,
      nextReviewAt: '2026-10-29T12:00:00.000Z',
      lastIntervalDays: 0,
      timeZone: 'UTC',
    }),
    '已过到期日 2 天',
  );
  assert.equal(
    reviewDueReason({
      now,
      lastReviewedAt: '2026-10-30T12:00:00.000Z',
      nextReviewAt: '2026-11-02T12:00:00.000Z',
      lastIntervalDays: 3,
      timeZone: 'UTC',
    }),
    null,
  );
});

test('caps wrong-item retest and skips a session with no retestable wrong answers', () => {
  const question = { type: 'MEANING_RECOGNITION', options: ['a'], correctAnswers: ['a'] };
  const words = [
    { id: 'right', result: true, question },
    { id: 'blank', result: false, question: null },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `wrong-${index}`,
      result: false,
      question,
    })),
  ];
  const plan = wrongRetestPlan(words);
  assert.equal(plan.items.length, 8);
  assert.equal(plan.omitted, 1);
  assert.equal(plan.items[0].id, 'wrong-0');
  assert.deepEqual(wrongRetestPlan([{ id: 'only', result: true, question }]), {
    items: [],
    omitted: 0,
  });
});

test('remembers the quick drill plan id without storing answer fields', () => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  assert.equal(QUICK_DRILL_WORD_COUNT, 10);
  rememberQuickDrill(storage, 'learner', 'plan-1');
  assert.equal(readQuickDrillPlanId(storage, 'learner'), 'plan-1');
  assert.equal(readQuickDrillPlanId(storage, 'other'), null);
  assert.equal(
    [...stored.values()].some((value) => String(value).includes('answer')),
    false,
  );
});
