export const STREAK_MILESTONES = [3, 7, 14, 30] as const;

const KEY_PREFIX = 'lexloop.streak-milestone.v1.';

const COPY: Record<(typeof STREAK_MILESTONES)[number], string> = {
  3: '连续 3 天了。先把这个节奏稳住。',
  7: '连续 7 天了。一周的学习已经接上。',
  14: '连续 14 天了。两周没有断开。',
  30: '连续 30 天了。这个月的学习留了下来。',
};

export type StreakMilestoneRecord = {
  acknowledged: number;
  streakAtAcknowledge: number;
};

export function streakMilestoneText(days: number) {
  return COPY[days as (typeof STREAK_MILESTONES)[number]] ?? null;
}

export function nextStreakMilestoneState(
  currentStreak: number,
  saved: StreakMilestoneRecord | null,
): { show: number | null; stored: StreakMilestoneRecord | null } {
  if (!Number.isSafeInteger(currentStreak) || currentStreak < 0) {
    return { show: null, stored: saved };
  }
  const broken = Boolean(saved && currentStreak < saved.streakAtAcknowledge);
  const stored = broken ? { acknowledged: 0, streakAtAcknowledge: currentStreak } : saved;
  const acknowledged = stored?.acknowledged ?? 0;
  const exact = (STREAK_MILESTONES as readonly number[]).includes(currentStreak)
    ? currentStreak
    : null;
  return {
    show: exact !== null && exact > acknowledged ? exact : null,
    stored,
  };
}

export function acknowledgeStreakMilestone(currentStreak: number): StreakMilestoneRecord {
  return { acknowledged: currentStreak, streakAtAcknowledge: currentStreak };
}

export function readStreakMilestone(
  storage: Pick<Storage, 'getItem'>,
  userId: string,
): StreakMilestoneRecord | null {
  try {
    const raw = storage.getItem(`${KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StreakMilestoneRecord>;
    const acknowledged = value.acknowledged;
    const streakAtAcknowledge = value.streakAtAcknowledge;
    const knownMilestone =
      acknowledged === 0 ||
      (typeof acknowledged === 'number' &&
        (STREAK_MILESTONES as readonly number[]).includes(acknowledged));
    if (
      typeof acknowledged !== 'number' ||
      !knownMilestone ||
      typeof streakAtAcknowledge !== 'number' ||
      !Number.isSafeInteger(streakAtAcknowledge) ||
      streakAtAcknowledge < acknowledged
    ) {
      return null;
    }
    return { acknowledged, streakAtAcknowledge };
  } catch {
    return null;
  }
}

export function writeStreakMilestone(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  record: StreakMilestoneRecord,
) {
  if (!userId) return;
  storage.setItem(`${KEY_PREFIX}${userId}`, JSON.stringify(record));
}
