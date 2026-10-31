import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyGoalProgressPercent, dailyGoalStatusText } from '../lib/daily-goal.ts';
import { getMistakeLearningDirection } from '../lib/mistake-learning-directions.ts';
import { parseDuePreview } from '../lib/due-preview.ts';
import { emptyStudyGuide } from '../lib/empty-study-guide.ts';
import { reviewQueueOrderNote } from '../lib/review-queue-order.ts';
import {
  dismissSessionRecap,
  isSessionRecapDismissed,
  sessionGoalLine,
  sessionPaceLine,
  sessionRecap,
  sessionStatsLine,
  sessionWeakLine,
} from '../lib/session-recap.ts';
import {
  dismissTomorrowNote,
  readTomorrowNoteDismissed,
  tomorrowPreviewLine,
} from '../lib/tomorrow-note.ts';
import {
  acknowledgeStreakMilestone,
  nextStreakMilestoneState,
  readStreakMilestone,
  streakMilestoneText,
  writeStreakMilestone,
} from '../lib/streak-milestone.ts';
import {
  parseWeakFocusCount,
  readWeakFocusPlanId,
  rememberWeakFocus,
  WEAK_FOCUS_WORD_COUNT,
} from '../lib/weak-focus.ts';

test('summarizes one finished plan without inventing a goal delta', () => {
  const recap = sessionRecap([
    { word: 'adapt', source: 'REVIEW', result: false, activeWeaknesses: [{ wrongCount: 4 }] },
    { word: 'bright', source: 'NEW', result: false, activeWeaknesses: [{ wrongCount: 1 }, { wrongCount: 3 }] },
    { word: 'calm', source: 'NEW', result: true },
    { word: 'drift', source: 'REVIEW', result: false },
    { word: 'eager', source: 'REVIEW', result: false, activeWeaknesses: [{ wrongCount: 9 }] },
  ]);
  assert.equal(recap.total, 5);
  assert.equal(recap.correct, 1);
  assert.equal(recap.accuracy, 20);
  assert.equal(recap.newCount, 2);
  assert.equal(recap.reviewCount, 3);
  assert.deepEqual(
    recap.weakest.map((item) => item.word),
    ['eager', 'adapt', 'bright'],
  );
  assert.equal(sessionStatsLine(recap), '正确率 20%（1/5）。新词 2 个，复习词 3 个。');
  assert.match(sessionWeakLine(recap.weakest, recap.total), /eager（单题型最多累计答错 9 次）/);
  assert.match(sessionWeakLine(recap.weakest, recap.total), /bright（单题型最多累计答错 3 次）/);
  assert.equal(sessionPaceLine(0, 5), null);
  assert.equal(sessionPaceLine(95, 5), '记录用时 1 分 35 秒，平均每词 19 秒。');
  assert.equal(sessionPaceLine(undefined, 5), null);
  assert.equal(sessionWeakLine([], 2), '这次没有答错的词。');
  assert.equal(
    sessionGoalLine({ kind: 'reviews', target: 10, progress: 6, met: false }, 5),
    '今日目标是复习 10 个不同词，当前 6/10。这次计划提交了 5 个词；同一天已经答过的词不会再计一次。',
  );
  assert.match(sessionGoalLine({ kind: 'activity', target: 1, progress: 1, met: true }, 5), /已完成/);
});

test('hides a dismissed session recap for that plan only', () => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  assert.equal(isSessionRecapDismissed(storage, 'learner', 'plan-1'), false);
  dismissSessionRecap(storage, 'learner', 'plan-1');
  assert.equal(isSessionRecapDismissed(storage, 'learner', 'plan-1'), true);
  assert.equal(isSessionRecapDismissed(storage, 'learner', 'plan-2'), false);
  assert.equal(isSessionRecapDismissed(storage, 'other', 'plan-1'), false);
});

test('shows a streak milestone only on 3, 7, 14 and 30, then again after a break', () => {
  assert.equal(nextStreakMilestoneState(2, null).show, null);
  assert.equal(nextStreakMilestoneState(4, null).show, null);
  assert.equal(nextStreakMilestoneState(7, null).show, 7);
  assert.equal(streakMilestoneText(7), '连续 7 天了。一周的学习已经接上。');
  const saved = acknowledgeStreakMilestone(7);
  assert.equal(nextStreakMilestoneState(7, saved).show, null);
  assert.equal(nextStreakMilestoneState(8, saved).show, null);
  const broken = nextStreakMilestoneState(5, saved);
  assert.equal(broken.show, null);
  assert.deepEqual(broken.stored, { acknowledged: 0, streakAtAcknowledge: 5 });
  assert.equal(nextStreakMilestoneState(7, broken.stored).show, 7);
  assert.equal(nextStreakMilestoneState(14, saved).show, 14);
  assert.equal(nextStreakMilestoneState(30, acknowledgeStreakMilestone(14)).show, 30);
});

test('stores the dismissed milestone per learner', () => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  writeStreakMilestone(storage, 'learner', acknowledgeStreakMilestone(14));
  assert.deepEqual(readStreakMilestone(storage, 'learner'), {
    acknowledged: 14,
    streakAtAcknowledge: 14,
  });
  assert.equal(readStreakMilestone(storage, 'other'), null);
  stored.set('lexloop.streak-milestone.v1.learner', '{"acknowledged":8,"streakAtAcknowledge":8}');
  assert.equal(readStreakMilestone(storage, 'learner'), null);
});

test('explains the saved review order and rejects a malformed due preview', () => {
  assert.equal(reviewQueueOrderNote([]), null);
  assert.equal(
    reviewQueueOrderNote([{ word: 'adapt' }, { word: 'bright' }]),
    '先刷这些：最逾期的在前；到期时间相同，则更久没复习的在前。队首是「adapt」。',
  );
  const preview = {
    timeZone: 'Asia/Shanghai',
    days: [
      { date: '2026-10-31', label: '今天', count: 2 },
      { date: '2026-11-01', label: '明天', count: 0 },
      { date: '2026-11-02', label: '后天', count: 1 },
      { date: '2026-11-03', label: '大后天', count: 4 },
    ],
  };
  assert.deepEqual(parseDuePreview(preview)?.days[0].count, 2);
  assert.equal(parseDuePreview({ ...preview, days: preview.days.slice(0, 3) }), null);
  assert.equal(parseDuePreview(undefined), null);
});

test('names a saved question type and skips an unknown one', () => {
  const cueFor = (type) => getMistakeLearningDirection(type)?.label ?? null;
  const recap = sessionRecap(
    [
      {
        word: 'adapt',
        result: false,
        activeWeaknesses: [{ questionType: 'MEANING_RECOGNITION', wrongCount: 2 }],
      },
      {
        word: 'bright',
        result: false,
        activeWeaknesses: [{ questionType: 'SPELLING', wrongCount: 4 }],
      },
    ],
    cueFor,
  );
  assert.match(sessionWeakLine(recap.weakest, recap.total) ?? '', /bright（单题型最多累计答错 4 次）/);
  assert.match(sessionWeakLine(recap.weakest, recap.total) ?? '', /adapt（单题型最多累计答错 2 次，词义识别）/);
  assert.equal((sessionWeakLine(recap.weakest, recap.total) ?? '').includes('拼写'), false);
});

test('states tomorrow’s scheduled count without turning it into a check-in', () => {
  assert.equal(tomorrowPreviewLine(4), '明天有 4 个词排到到期。今天留着不做完也没关系。');
  assert.equal(tomorrowPreviewLine(0), '明天还没有排到新的到期词。');
  assert.equal(tomorrowPreviewLine(-1), null);
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  dismissTomorrowNote(storage, 'learner', '2026-10-31');
  assert.equal(readTomorrowNoteDismissed(storage, 'learner'), '2026-10-31');
  assert.equal(readTomorrowNoteDismissed(storage, 'other'), null);
});

test('guides an empty review day toward new words or another book', () => {
  assert.equal(
    emptyStudyGuide({ reviewCount: 0, weakFocusCount: 0, newWordCount: 6 }),
    '今天没有到期词，也没有待练错题。用上面的「创建学习计划」从新词开始就行。',
  );
  assert.match(emptyStudyGuide({ reviewCount: 0, weakFocusCount: 0, newWordCount: 0 }) ?? '', /切换词书/);
  assert.equal(emptyStudyGuide({ reviewCount: 2, weakFocusCount: 0, newWordCount: 6 }), null);
  assert.equal(emptyStudyGuide({ reviewCount: 0, weakFocusCount: undefined, newWordCount: 6 }), null);
});

test('shows how many reviews remain and fills the goal bar from saved progress', () => {
  const goal = { kind: 'reviews', target: 10, progress: 4, met: false };
  assert.equal(dailyGoalStatusText(goal), '今日目标：复习 10 个词，还差 6 个');
  assert.equal(dailyGoalProgressPercent(goal), 40);
  assert.equal(dailyGoalProgressPercent({ kind: 'activity', target: 1, progress: 1, met: true }), 100);
});

test('remembers a weak-focus plan separately from a missing count', () => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  assert.equal(WEAK_FOCUS_WORD_COUNT, 8);
  assert.equal(parseWeakFocusCount(0), 0);
  assert.equal(parseWeakFocusCount(1.5), undefined);
  assert.equal(parseWeakFocusCount(undefined), undefined);
  rememberWeakFocus(storage, 'learner', 'plan-weak');
  assert.equal(readWeakFocusPlanId(storage, 'learner'), 'plan-weak');
  assert.equal(readWeakFocusPlanId(storage, 'other'), null);
});
