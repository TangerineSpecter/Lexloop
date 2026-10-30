import { AdventureEvidenceKind, AdventureHitGrade, AdventureRoomType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  aggregateMastery,
  attackDamage,
  challengeTypeForFocus,
  experienceLevel,
  gradeProvisionalFreeResponse,
  hitGrade,
  incomingDamage,
  normalizePracticeFocus,
  resolveCombatPassive,
} from '../src/modules/adventure/adventure.rules';
import { combatPassiveKeyForClassId } from '../src/modules/adventure/adventure.catalog';

describe('adventure learning RPG rules', () => {
  it('keeps the four class passives distinct and passes them down their class branches', () => {
    expect([
      combatPassiveKeyForClassId('class-warrior'),
      combatPassiveKeyForClassId('class-mage'),
      combatPassiveKeyForClassId('class-ranger'),
      combatPassiveKeyForClassId('class-cleric'),
    ]).toEqual(['VANGUARD', 'BURST', 'STRIKER', 'SUPPORT']);
    expect(combatPassiveKeyForClassId('class-berserker')).toBe('VANGUARD');
    expect(combatPassiveKeyForClassId('class-archmage')).toBe('BURST');
    expect(combatPassiveKeyForClassId('unknown-class')).toBeNull();
  });

  it('applies the guard passive only to a successful block that still takes damage', () => {
    const result = resolveCombatPassive({
      passiveKey: 'VANGUARD',
      phase: 'BLOCK',
      challengeType: 'CHOICE',
      score: 80,
      provisional: false,
      skillCost: 0,
      previousCorrectStreak: 0,
      supportHealUsed: false,
      damageReceived: 7,
      playerHpAfterDamage: 93,
      playerMaxHp: 100,
    });
    expect(result).toMatchObject({ damageReduction: 4, trigger: '稳守：额外减伤 4 点。' });
    expect(
      resolveCombatPassive({
        passiveKey: 'VANGUARD',
        phase: 'BLOCK',
        challengeType: 'CHOICE',
        score: 100,
        provisional: false,
        skillCost: 0,
        previousCorrectStreak: 0,
        supportHealUsed: false,
        damageReceived: 0,
        playerHpAfterDamage: 100,
        playerMaxHp: 100,
      }).trigger,
    ).toBeUndefined();
    expect(
      resolveCombatPassive({
        passiveKey: 'VANGUARD',
        phase: 'BLOCK',
        challengeType: 'CHOICE',
        score: 69,
        provisional: false,
        skillCost: 0,
        previousCorrectStreak: 0,
        supportHealUsed: false,
        damageReceived: 18,
        playerHpAfterDamage: 82,
        playerMaxHp: 100,
      }).damageReduction,
    ).toBe(0);
  });

  it('rewards only a resource-consuming perfect mage skill, not ordinary or provisional hits', () => {
    const resolve = (score: number, skillCost: number, provisional = false) =>
      resolveCombatPassive({
        passiveKey: 'BURST',
        phase: 'ATTACK',
        challengeType: 'SPELLING',
        score,
        provisional,
        skillCost,
        previousCorrectStreak: 0,
        supportHealUsed: false,
        damageReceived: 0,
        playerHpAfterDamage: 100,
        playerMaxHp: 100,
      });
    expect(resolve(100, 1).damageDealtBonus).toBe(6);
    expect(resolve(90, 0).damageDealtBonus).toBe(0);
    expect(resolve(89, 1).damageDealtBonus).toBe(0);
    expect(resolve(100, 1, true).damageDealtBonus).toBe(0);
  });

  it('rewards an accurate ranger combo and resets its streak after an incorrect answer', () => {
    const resolve = (score: number, previousCorrectStreak: number) =>
      resolveCombatPassive({
        passiveKey: 'STRIKER',
        phase: 'ATTACK',
        challengeType: 'MATCHING',
        score,
        provisional: false,
        skillCost: 0,
        previousCorrectStreak,
        supportHealUsed: false,
        damageReceived: 0,
        playerHpAfterDamage: 100,
        playerMaxHp: 100,
      });
    expect(resolve(70, 1)).toMatchObject({
      damageDealtBonus: 6,
      nextCorrectStreak: 2,
    });
    expect(resolve(100, 0).damageDealtBonus).toBe(0);
    expect(resolve(69, 3).nextCorrectStreak).toBe(0);
  });

  it('heals the cleric only on a valid production answer, once per room and up to max HP', () => {
    const resolve = (overrides: Partial<Parameters<typeof resolveCombatPassive>[0]> = {}) =>
      resolveCombatPassive({
        passiveKey: 'SUPPORT',
        phase: 'ATTACK',
        challengeType: 'SENTENCE_ORDER',
        score: 100,
        provisional: false,
        skillCost: 0,
        previousCorrectStreak: 0,
        supportHealUsed: false,
        damageReceived: 0,
        playerHpAfterDamage: 97,
        playerMaxHp: 100,
        ...overrides,
      });
    expect(resolve()).toMatchObject({ healing: 3, supportHealUsed: true });
    expect(resolve({ playerHpAfterDamage: 90 }).healing).toBe(4);
    expect(resolve({ supportHealUsed: true }).healing).toBe(0);
    expect(resolve({ challengeType: 'CHOICE' }).healing).toBe(0);
    expect(resolve({ provisional: true }).healing).toBe(0);
    expect(resolve({ playerHpAfterDamage: 100 }).healing).toBe(0);
  });

  it('offers deterministic challenge mixes without changing legacy defaults', () => {
    const balanced = Array.from({ length: 5 }, (_, index) =>
      challengeTypeForFocus('BALANCED', index, 'ATTACK'),
    );
    const recall = Array.from({ length: 5 }, (_, index) =>
      challengeTypeForFocus('RECALL', index, 'ATTACK'),
    );
    const context = Array.from({ length: 5 }, (_, index) =>
      challengeTypeForFocus('CONTEXT', index, 'ATTACK'),
    );

    expect(balanced).toEqual(['CHOICE', 'SPELLING', 'SENTENCE_ORDER', 'MATCHING', 'FREE_RESPONSE']);
    expect(recall.filter((type) => type === 'SPELLING')).toHaveLength(3);
    expect(context.filter((type) => type === 'SENTENCE_ORDER')).toHaveLength(3);
    expect([...recall, ...context]).not.toContain('FREE_RESPONSE');
    expect(challengeTypeForFocus('RECALL', 0, 'BLOCK')).toBe('SPELLING');
    expect(normalizePracticeFocus(undefined)).toBe('BALANCED');
    expect(normalizePracticeFocus('unknown')).toBe('BALANCED');
  });

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
