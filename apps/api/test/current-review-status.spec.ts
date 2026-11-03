import { describe, expect, it } from 'vitest';
import { currentReviewStatus } from '../src/modules/study/current-review-status';
const now = new Date('2026-11-03T12:00:00Z');
const input = {
  mastered: false,
  supplementary: false,
  usableMeaning: true,
  progress: { state: 'REVIEWING', nextReviewAt: now },
};
describe('current review evidence', () => {
  it('gives global mastery priority over stale due dates, even from another book', () => {
    expect(currentReviewStatus({ ...input, mastered: true }, now)).toBe('MASTERED');
    expect(currentReviewStatus({ ...input, mastered: true, usableMeaning: false }, now)).toBe(
      'MASTERED',
    );
  });
  it('distinguishes missing meaning from a supplemental book outside the ordinary queue', () => {
    expect(currentReviewStatus({ ...input, usableMeaning: false }, now)).toBe('MISSING_MEANING');
    expect(currentReviewStatus({ ...input, supplementary: true }, now)).toBe('OUTSIDE_QUEUE');
  });
  it('uses the inclusive due boundary and reflects postponement', () => {
    expect(currentReviewStatus(input, now)).toBe('DUE');
    expect(
      currentReviewStatus(
        { ...input, progress: { ...input.progress, nextReviewAt: new Date(now.getTime() + 1) } },
        now,
      ),
    ).toBe('SCHEDULED');
    expect(
      currentReviewStatus(
        { ...input, progress: { ...input.progress, nextReviewAt: new Date(0) } },
        now,
      ),
    ).toBe('DUE');
  });
  it('does not invent a review schedule for missing, cleared or learning progress', () => {
    expect(currentReviewStatus({ ...input, progress: undefined }, now)).toBe('UNSCHEDULED');
    expect(
      currentReviewStatus({ ...input, progress: { ...input.progress, nextReviewAt: null } }, now),
    ).toBe('UNSCHEDULED');
    expect(
      currentReviewStatus({ ...input, progress: { ...input.progress, state: 'LEARNING' } }, now),
    ).toBe('UNSCHEDULED');
  });
});
