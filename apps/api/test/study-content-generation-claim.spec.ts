import { describe, expect, it } from 'vitest';
import {
  STUDY_CONTENT_CLAIM_WAIT_MS,
  studyContentClaimWaitDeadline,
} from '../src/modules/study/study-content-generation-claim';

describe('public content claim wait budget', () => {
  it('caps waiting at 100 seconds when the plan has more budget remaining', () => {
    const now = 1_000_000;
    const generationDeadline = now + 6 * 60_000;

    expect(studyContentClaimWaitDeadline(generationDeadline, now)).toBe(
      now + STUDY_CONTENT_CLAIM_WAIT_MS,
    );
  });

  it('ends the wait at the earlier plan deadline when less than 100 seconds remain', () => {
    const now = 1_000_000;
    const generationDeadline = now + 20_000;

    expect(studyContentClaimWaitDeadline(generationDeadline, now)).toBe(generationDeadline);
  });

  it('does not add another wait after the plan generation budget has expired', () => {
    const now = 1_000_000;
    const generationDeadline = now - 1;

    expect(studyContentClaimWaitDeadline(generationDeadline, now)).toBe(generationDeadline);
  });
});
