import { AdventureEvidenceKind, AdventureHitGrade, AdventureRoomType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { aggregateMastery, attackDamage, experienceLevel, hitGrade, incomingDamage } from '../src/modules/adventure/adventure.rules';

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
      { targetId: 'one', runId: 'run-a', score: 100, kind: AdventureEvidenceKind.RECOGNITION },
      { targetId: 'one', runId: 'run-b', score: 100, kind: AdventureEvidenceKind.RECOGNITION },
    ];
    expect(aggregateMastery(evidence, 1)).toEqual({ exploration: 100, mastery: 0, bossUnlocked: false });
  });

  it('requires successful evidence from two runs and one active recall', () => {
    const evidence = [
      { targetId: 'one', runId: 'run-a', score: 100, kind: AdventureEvidenceKind.RECOGNITION },
      { targetId: 'one', runId: 'run-b', score: 70, kind: AdventureEvidenceKind.RECALL },
    ];
    expect(aggregateMastery(evidence, 1)).toEqual({ exploration: 100, mastery: 100, bossUnlocked: true });
  });

  it('awards levels from cumulative experience without skipping the threshold', () => {
    expect(experienceLevel(99)).toBe(1);
    expect(experienceLevel(100)).toBe(2);
    expect(experienceLevel(300)).toBe(3);
  });
});
