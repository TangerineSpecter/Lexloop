import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissDueClear, nextDueClearState } from '../lib/due-cleared.ts';
import { reviewQueueOrderNote } from '../lib/review-queue-order.ts';
import { orderWithSkips, toggleReviewSkip } from '../lib/review-skip.ts';
import { parseWeekGlance } from '../lib/week-glance.ts';

test('accepts a seven-day glance and rejects a mismatched active count', () => {
  const week = {
    activeDays: 2,
    answeredWords: 4,
    newWords: 1,
    reviewWords: 2,
    days: [
      { label: '六', active: false },
      { label: '日', active: false },
      { label: '一', active: true },
      { label: '二', active: false },
      { label: '三', active: false },
      { label: '四', active: false },
      { label: '今', active: true },
    ],
  };
  assert.equal(parseWeekGlance(week)?.activeDays, 2);
  assert.equal(parseWeekGlance({ ...week, activeDays: 1 }), null);
  assert.equal(parseWeekGlance({ ...week, days: week.days.slice(0, 6) }), null);
});

test('moves a skipped due word to the end without dropping it', () => {
  const words = [{ id: 'a', word: 'adapt' }, { id: 'b', word: 'bright' }, { id: 'c', word: 'calm' }];
  const skipped = toggleReviewSkip([], 'a');
  assert.deepEqual(
    orderWithSkips(words, skipped).map((word) => word.id),
    ['b', 'c', 'a'],
  );
  assert.equal(toggleReviewSkip(skipped, 'a').includes('a'), false);
  assert.match(reviewQueueOrderNote(orderWithSkips(words, skipped), { skipped: 1 }) ?? '', /队尾/);
});

test('celebrates a cleared due list only after words were seen today', () => {
  const empty = nextDueClearState(null, '2026-10-31', 0);
  assert.equal(empty.show, false);
  const seen = nextDueClearState(empty.next, '2026-10-31', 3);
  assert.equal(seen.show, false);
  assert.equal(seen.next.seenDue, true);
  const cleared = nextDueClearState(seen.next, '2026-10-31', 0);
  assert.equal(cleared.show, true);
  const dismissed = nextDueClearState(dismissDueClear(cleared.next), '2026-10-31', 0);
  assert.equal(dismissed.show, false);
  const nextDay = nextDueClearState(dismissed.next, '2026-11-01', 0);
  assert.equal(nextDay.show, false);
});
