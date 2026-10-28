import { AdventureEvidenceKind, AdventureHitGrade, AdventureRoomType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  aggregateMastery,
  attackDamage,
  experienceLevel,
  gradeProvisionalFreeResponse,
  hitGrade,
  incomingDamage,
} from '../src/modules/adventure/adventure.rules';

describe('adventure learning RPG rules', () => {
  it('maps scores to the four visible hit grades', () => {
    expect(hitGrade(90)).toBe(AdventureHitGrade.PERFECT);
    expect(hitGrade(70)).toBe(AdventureHitGrade.HIT);
    expect(hitGrade(50)).toBe(AdventureHitGrade.GRAZE);
    expect(hitGrade(49)).toBe(AdventureHitGrade.MISS);
  });

  it('never lets equipment turn a miss into damage', () => {
    expect(attackDamage(49, 99)).toBe(0);
    expect(attackDamage(90, 1.2)).toBeGreaterThan(attackDamage(70, 1.2));
  });

  it('applies the documented block reductions', () => {
    expect(incomingDamage(90, AdventureRoomType.COMBAT)).toBe(0);
    expect(incomingDamage(70, AdventureRoomType.COMBAT)).toBe(7);
    expect(incomingDamage(0, AdventureRoomType.BOSS)).toBe(30);
  });

  it('does not allow repeated recognition guesses to create mastery', () => {
    const evidence = [
      {
        targetId: 'one',
        runId: 'run-a',
        score: 100,
        kind: AdventureEvidenceKind.RECOGNITION,
        validRecall: false,
      },
      {
        targetId: 'one',
        runId: 'run-b',
        score: 100,
        kind: AdventureEvidenceKind.RECOGNITION,
        validRecall: false,
      },
    ];
    expect(aggregateMastery(evidence, 1)).toEqual({
      exploration: 100,
      mastery: 0,
      bossUnlocked: false,
    });
  });

  it('requires successful evidence from two runs and one active recall', () => {
    const evidence = [
      {
        targetId: 'one',
        runId: 'run-a',
        score: 100,
        kind: AdventureEvidenceKind.RECOGNITION,
        validRecall: false,
      },
      {
        targetId: 'one',
        runId: 'run-b',
        score: 70,
        kind: AdventureEvidenceKind.RECALL,
        validRecall: true,
      },
    ];
    expect(aggregateMastery(evidence, 1)).toEqual({
      exploration: 100,
      mastery: 100,
      bossUnlocked: true,
    });
  });

  it('does not count provisional evidence as verified recall even if its score is high', () => {
    const evidence = [
      {
        targetId: 'one',
        runId: 'run-a',
        score: 100,
        kind: AdventureEvidenceKind.PRODUCTION,
        validRecall: false,
      },
      {
        targetId: 'one',
        runId: 'run-b',
        score: 100,
        kind: AdventureEvidenceKind.PRODUCTION,
        validRecall: false,
      },
    ];
    expect(aggregateMastery(evidence, 1)).toEqual({
      exploration: 100,
      mastery: 0,
      bossUnlocked: false,
    });
  });

  it('filters historical provisional actions that were previously stored as valid recall', () => {
    const evidence = ['run-a', 'run-b'].map((runId) => ({
      targetId: 'one',
      runId,
      score: 70,
      kind: AdventureEvidenceKind.PRODUCTION,
      validRecall: true,
      provisional: true,
    }));
    expect(aggregateMastery(evidence, 1)).toEqual({
      exploration: 100,
      mastery: 0,
      bossUnlocked: false,
    });
  });

  it('keeps provisional free-response scoring below the correct-evidence threshold', () => {
    expect(
      gradeProvisionalFreeResponse(
        'We can use patient words in context.',
        'patient',
        'I can be patient.',
      ),
    ).toMatchObject({ score: 60, provisional: true });
    expect(
      gradeProvisionalFreeResponse('The interesting story helped me.', 'in', 'I am in.'),
    ).toMatchObject({ score: 20, provisional: true });
    expect(
      gradeProvisionalFreeResponse('Be patient.', 'patient', 'I can be patient.'),
    ).toMatchObject({
      score: 50,
      provisional: true,
    });
  });

  it('matches complete target words and phrases with case, punctuation, hyphens, and apostrophes', () => {
    expect(
      gradeProvisionalFreeResponse('She is PATIENT, even at work.', 'patient', 'I can be patient.'),
    ).toMatchObject({ score: 60 });
    expect(
      gradeProvisionalFreeResponse(
        'I will look-after it today.',
        'look after',
        'I can look after it.',
      ),
    ).toMatchObject({ score: 60 });
    expect(
      gradeProvisionalFreeResponse("We don't need to stop.", 'don’t', "We don't need to stop."),
    ).toMatchObject({ score: 60 });
    expect(
      gradeProvisionalFreeResponse('Impatient people hurry.', 'patient', 'I can be patient.'),
    ).toMatchObject({ score: 20 });
  });

  it('awards levels from cumulative experience without skipping the threshold', () => {
    expect(experienceLevel(99)).toBe(1);
    expect(experienceLevel(100)).toBe(2);
    expect(experienceLevel(300)).toBe(3);
  });
});
