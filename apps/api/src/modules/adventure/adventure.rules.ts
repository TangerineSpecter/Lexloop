import {
  AdventureActionPhase,
  AdventureChallengeType,
  AdventureEvidenceKind,
  AdventureHitGrade,
  AdventureRoomType,
} from '@prisma/client';
import type { AdventureCombatPassiveKey, AdventurePracticeFocus } from '@lexloop/types';

const CHALLENGE_SEQUENCES: Record<AdventurePracticeFocus, AdventureChallengeType[]> = {
  BALANCED: [
    AdventureChallengeType.CHOICE,
    AdventureChallengeType.SPELLING,
    AdventureChallengeType.SENTENCE_ORDER,
    AdventureChallengeType.MATCHING,
    AdventureChallengeType.FREE_RESPONSE,
  ],
  RECALL: [
    AdventureChallengeType.SPELLING,
    AdventureChallengeType.SPELLING,
    AdventureChallengeType.CHOICE,
    AdventureChallengeType.SPELLING,
    AdventureChallengeType.SENTENCE_ORDER,
  ],
  CONTEXT: [
    AdventureChallengeType.SENTENCE_ORDER,
    AdventureChallengeType.SENTENCE_ORDER,
    AdventureChallengeType.SPELLING,
    AdventureChallengeType.SENTENCE_ORDER,
    AdventureChallengeType.MATCHING,
  ],
};

export function normalizePracticeFocus(value: unknown): AdventurePracticeFocus {
  return value === 'RECALL' || value === 'CONTEXT' ? value : 'BALANCED';
}

export function challengeTypeForFocus(
  focus: AdventurePracticeFocus,
  ordinal: number,
  phase: AdventureActionPhase,
) {
  const sequence = CHALLENGE_SEQUENCES[focus];
  const offset = Number.isFinite(ordinal) ? Math.max(0, Math.floor(ordinal)) : 0;
  return sequence[(offset + (phase === AdventureActionPhase.BLOCK ? 1 : 0)) % sequence.length];
}

export type ProvisionalFreeResponseGrade = {
  score: number;
  message: string;
  answer: string;
  provisional: true;
};

export function gradeProvisionalFreeResponse(
  text: string,
  targetWord: string,
  referenceAnswer: string,
): ProvisionalFreeResponseGrade {
  const answerTokens = lexicalTokens(text);
  const targetTokens = lexicalTokens(targetWord);
  const containsTarget =
    targetTokens.length > 0 &&
    answerTokens.some((_, start) =>
      targetTokens.every((token, offset) => answerTokens[start + offset] === token),
    );
  const hasSentenceLength = answerTokens.length >= 4;

  return {
    // A lexical heuristic cannot verify that the target is used naturally.
    // Keep it below the learning-correct threshold while still allowing partial battle damage.
    score: containsTarget ? (hasSentenceLength ? 60 : 50) : 20,
    message: containsTarget
      ? 'AI 评分暂不可用；已找到目标词的完整拼写，但无法确认句子语法、搭配或语义，本次不计为正确。'
      : `AI 评分暂不可用；未找到目标词“${targetWord}”的完整拼写，本次不计为正确。`,
    answer: referenceAnswer,
    provisional: true,
  };
}

function lexicalTokens(value: string) {
  return (
    value
      .normalize('NFKC')
      .replace(/[’‘]/g, "'")
      .toLocaleLowerCase('en')
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []
  );
}

export function hitGrade(score: number): AdventureHitGrade {
  if (score >= 90) return AdventureHitGrade.PERFECT;
  if (score >= 70) return AdventureHitGrade.HIT;
  if (score >= 50) return AdventureHitGrade.GRAZE;
  return AdventureHitGrade.MISS;
}

export function attackDamage(score: number, multiplier = 1) {
  const grade = hitGrade(score);
  const factor =
    grade === AdventureHitGrade.PERFECT
      ? 1.25
      : grade === AdventureHitGrade.HIT
        ? 1
        : grade === AdventureHitGrade.GRAZE
          ? 0.45
          : 0;
  return Math.max(0, Math.round(32 * factor * Math.max(1, multiplier)));
}

export function incomingDamage(score: number, roomType: AdventureRoomType, blockBonus = 0) {
  const base =
    roomType === AdventureRoomType.BOSS ? 30 : roomType === AdventureRoomType.ELITE ? 24 : 18;
  const grade = hitGrade(score);
  const reduction =
    grade === AdventureHitGrade.PERFECT
      ? 1
      : grade === AdventureHitGrade.HIT
        ? 0.6
        : grade === AdventureHitGrade.GRAZE
          ? 0.25
          : 0;
  return Math.max(0, Math.round(base * (1 - Math.min(1, reduction + blockBonus))));
}

export function resolveCombatPassive(input: {
  passiveKey: AdventureCombatPassiveKey;
  phase: string;
  challengeType: string;
  score: number;
  provisional: boolean;
  skillCost: number;
  previousCorrectStreak: number;
  supportHealUsed: boolean;
  damageReceived: number;
  playerHpAfterDamage: number;
  playerMaxHp: number;
}) {
  const validCorrect = input.score >= 70 && !input.provisional;
  const previousCorrectStreak = Math.max(0, Math.floor(input.previousCorrectStreak));
  let damageDealtBonus = 0;
  let damageReduction = 0;
  let healing = 0;
  let supportHealUsed = input.supportHealUsed;
  let trigger: string | undefined;

  if (
    input.passiveKey === 'VANGUARD' &&
    input.phase === 'BLOCK' &&
    validCorrect &&
    input.damageReceived > 0
  ) {
    damageReduction = Math.min(4, Math.max(0, input.damageReceived));
    if (damageReduction > 0) trigger = `稳守：额外减伤 ${damageReduction} 点。`;
  } else if (
    input.passiveKey === 'BURST' &&
    input.phase === 'ATTACK' &&
    validCorrect &&
    hitGrade(input.score) === AdventureHitGrade.PERFECT &&
    input.skillCost > 0
  ) {
    damageDealtBonus = 6;
    trigger = '精准施法：技能完美命中，额外造成 6 点战斗伤害。';
  } else if (
    input.passiveKey === 'STRIKER' &&
    input.phase === 'ATTACK' &&
    validCorrect &&
    previousCorrectStreak > 0
  ) {
    damageDealtBonus = 6;
    trigger = '连续出击：连续答对，额外造成 6 点战斗伤害。';
  } else if (
    input.passiveKey === 'SUPPORT' &&
    validCorrect &&
    (input.challengeType === AdventureChallengeType.SENTENCE_ORDER ||
      input.challengeType === AdventureChallengeType.FREE_RESPONSE) &&
    !input.supportHealUsed &&
    input.playerHpAfterDamage < input.playerMaxHp
  ) {
    healing = Math.min(4, input.playerMaxHp - Math.max(0, input.playerHpAfterDamage));
    supportHealUsed = healing > 0;
    if (healing > 0) trigger = `温和疗愈：恢复 ${healing} 点生命（本房间一次）。`;
  }

  return {
    damageDealtBonus,
    damageReduction,
    healing,
    supportHealUsed,
    nextCorrectStreak: validCorrect ? previousCorrectStreak + 1 : 0,
    trigger,
  };
}

export function evidenceKind(type: string): AdventureEvidenceKind {
  if (type === 'CHOICE' || type === 'MATCHING') return AdventureEvidenceKind.RECOGNITION;
  if (type === 'FREE_RESPONSE' || type === 'SENTENCE_ORDER')
    return AdventureEvidenceKind.PRODUCTION;
  return AdventureEvidenceKind.RECALL;
}

export function aggregateMastery(
  evidence: Array<{
    targetId: string;
    runId: string;
    score: number;
    kind: AdventureEvidenceKind;
    validRecall: boolean;
    provisional?: boolean;
  }>,
  targetCount: number,
) {
  if (!targetCount) return { exploration: 0, mastery: 0, bossUnlocked: false };
  const grouped = new Map<string, typeof evidence>();
  for (const item of evidence)
    grouped.set(item.targetId, [...(grouped.get(item.targetId) ?? []), item]);
  const explored = grouped.size;
  const mastered = [...grouped.values()].filter((items) => {
    const valid = items.filter((item) => item.score >= 70 && !item.provisional);
    return (
      new Set(valid.map((item) => item.runId)).size >= 2 &&
      valid.some((item) => item.validRecall && item.kind !== AdventureEvidenceKind.RECOGNITION)
    );
  }).length;
  const exploration = Math.round((explored / targetCount) * 100);
  const mastery = Math.round((mastered / targetCount) * 100);
  return { exploration, mastery, bossUnlocked: exploration >= 80 && mastery >= 70 };
}

export function experienceLevel(experience: number) {
  let level = 1;
  while (level < 99 && experience >= level * (level + 1) * 50) level += 1;
  return level;
}

export function experienceToNextLevel(level: number) {
  return level * (level + 1) * 50;
}
