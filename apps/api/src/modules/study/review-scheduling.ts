import { WordProgressState } from '@prisma/client';

const DAY = 86_400_000;

export type ReviewScheduleProgress = {
  reviewCount: number;
  totalAttempts: number;
  correctAttempts: number;
  consecutiveCorrect: number;
  lastIntervalDays: number;
  postponedCount: number;
  lastReviewedAt: Date | null;
  nextReviewAt: Date | null;
};

export function reviewSchedule(
  progress: ReviewScheduleProgress,
  correct: boolean,
  now = new Date(),
) {
  const totalAttempts = progress.totalAttempts + 1;
  const correctAttempts = progress.correctAttempts + (correct ? 1 : 0);
  const accuracy = correctAttempts / totalAttempts;
  const overdueDays = progress.nextReviewAt
    ? Math.max(0, (now.getTime() - progress.nextReviewAt.getTime()) / DAY)
    : 0;
  const actualGap = progress.lastReviewedAt
    ? Math.max(1, (now.getTime() - progress.lastReviewedAt.getTime()) / DAY)
    : 1;
  const base = Math.max(1, progress.lastIntervalDays || 1);
  const quality = accuracy >= 0.85 ? 2.2 : accuracy >= 0.65 ? 1.45 : 0.9;
  const overdueFactor = Math.max(0.4, 1 - Math.min(0.55, (overdueDays / base) * 0.18));
  const postponeFactor = Math.max(0.55, 1 - Math.min(0.4, progress.postponedCount * 0.08));
  const persistentDifficulty = progress.reviewCount >= 4 && accuracy < 0.6;
  const interval = correct
    ? Math.max(
        1,
        Math.min(
          persistentDifficulty ? 2 : 180,
          Math.round(base * quality * overdueFactor * postponeFactor),
        ),
      )
    : 1;
  const nextReviewAt = new Date(now.getTime() + interval * DAY);
  const unfamiliarity = unfamiliarityScore({
    accuracy,
    overdueDays,
    actualGap,
    lastIntervalDays: base,
    reviewCount: progress.reviewCount + 1,
    consecutiveCorrect: correct ? progress.consecutiveCorrect + 1 : 0,
    postponedCount: progress.postponedCount,
  });
  return {
    state: WordProgressState.REVIEWING,
    reviewCount: { increment: 1 },
    totalAttempts: { increment: 1 },
    correctAttempts: correct ? { increment: 1 } : undefined,
    consecutiveCorrect: correct ? { increment: 1 } : 0,
    lastIntervalDays: interval,
    lastReviewedAt: now,
    nextReviewAt,
    familiarity: 100 - unfamiliarity,
    postponedCount: 0,
  };
}

export function unfamiliarityScore(input: {
  accuracy: number;
  overdueDays: number;
  actualGap: number;
  lastIntervalDays: number;
  reviewCount: number;
  consecutiveCorrect: number;
  postponedCount: number;
}) {
  const accuracyRisk = (1 - input.accuracy) * 58;
  const overdueRisk = Math.min(18, (input.overdueDays / Math.max(1, input.lastIntervalDays)) * 12);
  const gapRisk = Math.min(
    8,
    (Math.max(0, input.actualGap - input.lastIntervalDays) / Math.max(1, input.lastIntervalDays)) *
      5,
  );
  const streakRelief = Math.min(12, input.consecutiveCorrect * 3);
  const postponeRisk = Math.min(10, input.postponedCount * 2);
  const persistentRisk =
    input.reviewCount >= 4 && input.accuracy < 0.6
      ? 14
      : input.reviewCount < 2 && input.accuracy < 0.6
        ? 6
        : 0;
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        accuracyRisk + overdueRisk + gapRisk + postponeRisk + persistentRisk - streakRelief,
      ),
    ),
  );
}
