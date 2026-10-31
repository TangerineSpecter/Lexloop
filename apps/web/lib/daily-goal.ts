export const REVIEW_GOAL_TARGETS = [5, 10, 15] as const;

export type DailyGoalKind = 'activity' | 'reviews';

export type DailyGoalProgress = {
  kind: DailyGoalKind;
  target: number;
  progress: number;
  met: boolean;
};

export type DailyGoalVisit = {
  date: string;
  met: boolean;
  dismissed: boolean;
};

const VISIT_KEY_PREFIX = 'lexloop.daily-goal.v1.';

export function localDateKey(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return 'invalid-date';
  return `${year}-${month}-${day}`;
}

export function calendarDaysBetween(earlier: Date, later: Date, timeZone: string) {
  const start = Date.parse(`${localDateKey(timeZone, earlier)}T00:00:00Z`);
  const end = Date.parse(`${localDateKey(timeZone, later)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export function parseDailyGoal(value: unknown): DailyGoalProgress | null {
  if (!value || typeof value !== 'object') return null;
  const goal = value as Partial<DailyGoalProgress>;
  const target = goal.target;
  const progress = goal.progress;
  if (goal.kind !== 'activity' && goal.kind !== 'reviews') return null;
  if (typeof target !== 'number' || typeof progress !== 'number') return null;
  if (!Number.isSafeInteger(target) || !Number.isSafeInteger(progress)) return null;
  if (target < 1 || progress < 0 || progress > target) return null;
  if (typeof goal.met !== 'boolean') return null;
  if (goal.kind === 'activity' && target !== 1) return null;
  if (
    goal.kind === 'reviews' &&
    !REVIEW_GOAL_TARGETS.includes(target as (typeof REVIEW_GOAL_TARGETS)[number])
  ) {
    return null;
  }
  return { kind: goal.kind, target, progress, met: goal.met };
}

export function dailyGoalStatusText(goal: DailyGoalProgress) {
  if (goal.kind === 'activity') {
    return goal.met ? '今日目标：完成 1 次学习，已经完成' : '今日目标：完成 1 次学习，还差 1 次';
  }
  const remaining = Math.max(0, goal.target - goal.progress);
  return goal.met
    ? `今日目标：复习 ${goal.target} 个词，已经完成`
    : `今日目标：复习 ${goal.target} 个词，还差 ${remaining} 个`;
}

export function dailyGoalProgressPercent(goal: DailyGoalProgress) {
  if (goal.target <= 0) return 0;
  return Math.min(100, Math.round((goal.progress / goal.target) * 100));
}

export function goalOptionValue(goal: DailyGoalProgress) {
  return goal.kind === 'reviews' ? `reviews:${goal.target}` : 'activity';
}

export function parseGoalOption(value: string): { kind: DailyGoalKind; target: number } | null {
  if (value === 'activity') return { kind: 'activity', target: 1 };
  const match = /^reviews:(5|10|15)$/.exec(value);
  if (!match) return null;
  return { kind: 'reviews', target: Number(match[1]) };
}

export function goalCelebrationDecision(
  previous: DailyGoalVisit | null,
  date: string,
  met: boolean,
): { show: boolean; next: DailyGoalVisit } {
  const sameDay = previous?.date === date;
  const show = Boolean(sameDay && previous && !previous.met && met && !previous.dismissed);
  return {
    show,
    next: {
      date,
      met,
      dismissed: show ? false : Boolean(sameDay && previous?.dismissed && met),
    },
  };
}

export function readDailyGoalVisit(
  storage: Pick<Storage, 'getItem'>,
  userId: string,
): DailyGoalVisit | null {
  try {
    const raw = storage.getItem(`${VISIT_KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DailyGoalVisit>;
    if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null;
    if (typeof value.met !== 'boolean' || typeof value.dismissed !== 'boolean') return null;
    return { date: value.date, met: value.met, dismissed: value.dismissed };
  } catch {
    return null;
  }
}

export function writeDailyGoalVisit(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  visit: DailyGoalVisit,
) {
  storage.setItem(`${VISIT_KEY_PREFIX}${userId}`, JSON.stringify(visit));
}
