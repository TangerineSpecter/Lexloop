export type CurrentReviewStatus =
  'MASTERED' | 'MISSING_MEANING' | 'DUE' | 'SCHEDULED' | 'UNSCHEDULED' | 'OUTSIDE_QUEUE';

/** Current eligibility, not a historical result or a promise of selection in the next plan. */
export function currentReviewStatus(
  input: {
    mastered: boolean;
    supplementary: boolean;
    usableMeaning: boolean;
    progress?: { state?: string; nextReviewAt: Date | null };
  },
  now = new Date(),
): CurrentReviewStatus {
  if (input.mastered) return 'MASTERED';
  if (input.supplementary) return 'OUTSIDE_QUEUE';
  if (!input.usableMeaning) return 'MISSING_MEANING';
  if (input.progress?.state !== 'REVIEWING' || !input.progress.nextReviewAt) return 'UNSCHEDULED';
  return input.progress.nextReviewAt.getTime() <= now.getTime() ? 'DUE' : 'SCHEDULED';
}
