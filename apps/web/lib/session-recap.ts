import type { DailyGoalProgress } from './daily-goal';

export const SESSION_RECAP_WEAK_LIMIT = 3;

const DISMISS_KEY_PREFIX = 'lexloop.session-recap.v1.';
const DISMISS_LIMIT = 24;

export type SessionRecapWord = {
  word?: string | null;
  source?: string | null;
  result?: boolean;
  activeWeaknesses?: Array<{ wrongCount?: number | null; questionType?: string | null }>;
};

export type SessionWeakWord = {
  word: string;
  wrongCount: number | null;
  cue: string | null;
};

export type SessionRecap = {
  accuracy: number;
  correct: number;
  total: number;
  newCount: number;
  reviewCount: number;
  weakest: SessionWeakWord[];
};

export function sessionRecap(
  words: SessionRecapWord[],
  cueFor: (questionType: string) => string | null = () => null,
): SessionRecap {
  const total = words.length;
  const correct = words.filter((word) => word.result === true).length;
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const reviewCount = words.filter((word) => word.source === 'REVIEW').length;
  const ranked = words
    .map((word, index) => ({ word, index }))
    .filter((item) => item.word.result === false && item.word.word?.trim())
    .map((item) => {
      const leading = leadingWeakness(item.word.activeWeaknesses, cueFor);
      return {
        word: item.word.word!.trim(),
        wrongCount: leading.wrongCount,
        cue: leading.cue,
        index: item.index,
      };
    })
    .sort((left, right) => {
      const leftCount = left.wrongCount ?? -1;
      const rightCount = right.wrongCount ?? -1;
      if (rightCount !== leftCount) return rightCount - leftCount;
      return left.index - right.index;
    })
    .slice(0, SESSION_RECAP_WEAK_LIMIT)
    .map(({ word, wrongCount, cue }) => ({ word, wrongCount, cue }));
  return {
    accuracy,
    correct,
    total,
    newCount: total - reviewCount,
    reviewCount,
    weakest: ranked,
  };
}

export function sessionStatsLine(recap: SessionRecap) {
  return `正确率 ${recap.accuracy}%（${recap.correct}/${recap.total}）。新词 ${recap.newCount} 个，复习词 ${recap.reviewCount} 个。`;
}

export function sessionPaceLine(durationSeconds: unknown, wordCount: number) {
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isSafeInteger(wordCount) ||
    wordCount <= 0
  ) {
    return null;
  }
  const average = Math.round(durationSeconds / wordCount);
  const recorded = `记录用时 ${formatRecordedDuration(durationSeconds)}`;
  return average > 0 ? `${recorded}，平均每词 ${average} 秒。` : `${recorded}。`;
}

export function sessionWeakLine(weakest: SessionWeakWord[], total: number) {
  if (total <= 0) return null;
  if (!weakest.length) return '这次没有答错的词。';
  const parts = weakest.map((item) => {
    const detail =
      item.wrongCount === null ? '这次答错' : `单题型最多累计答错 ${item.wrongCount} 次`;
    return item.cue ? `${item.word}（${detail}，${item.cue}）` : `${item.word}（${detail}）`;
  });
  return `这次较弱的词：${parts.join('、')}。`;
}

export function sessionGoalLine(goal: DailyGoalProgress, answeredWords: number) {
  if (goal.kind === 'activity') {
    return goal.met
      ? '今日目标是完成 1 次学习，当前已完成。这次提交算一次学习活动。'
      : '今日目标是完成 1 次学习，当前还差 1 次。这次提交算一次学习活动。';
  }
  const status = goal.met ? '已完成' : `当前 ${goal.progress}/${goal.target}`;
  return `今日目标是复习 ${goal.target} 个不同词，${status}。这次计划提交了 ${answeredWords} 个词；同一天已经答过的词不会再计一次。`;
}

export function isSessionRecapDismissed(
  storage: Pick<Storage, 'getItem'>,
  userId: string,
  planId: string,
) {
  return readDismissedRecaps(storage, userId).includes(planId);
}

export function dismissSessionRecap(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  userId: string,
  planId: string,
) {
  if (!userId || !planId || planId.length > 200) return;
  const next = [planId, ...readDismissedRecaps(storage, userId).filter((id) => id !== planId)].slice(
    0,
    DISMISS_LIMIT,
  );
  storage.setItem(`${DISMISS_KEY_PREFIX}${userId}`, JSON.stringify(next));
}

function readDismissedRecaps(storage: Pick<Storage, 'getItem'>, userId: string) {
  try {
    const raw = storage.getItem(`${DISMISS_KEY_PREFIX}${userId}`);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200)
      .slice(0, DISMISS_LIMIT);
  } catch {
    return [];
  }
}

function leadingWeakness(
  weaknesses: SessionRecapWord['activeWeaknesses'],
  cueFor: (questionType: string) => string | null,
) {
  let wrongCount: number | null = null;
  let cue: string | null = null;
  for (const item of weaknesses ?? []) {
    const count = item.wrongCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue;
    if (wrongCount !== null && count <= wrongCount) continue;
    wrongCount = count;
    cue = item.questionType ? cueFor(item.questionType) : null;
  }
  return { wrongCount, cue };
}

function formatRecordedDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}
