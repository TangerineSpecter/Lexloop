import { BadGatewayException } from '@nestjs/common';
import { CefrLevel, ScenarioCategory } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ASSESSMENT_ITEMS, SCENARIOS } from '../src/modules/travel/travel.catalog';
import { adaptLevel, expressionEvidenceLevel, highestPassedObjectiveLevel, mergeProgress, normalizeTurn } from '../src/modules/travel/travel.service';

describe('travel learning rules', () => {
  it('ships six categories, three scenarios each, and a complete 22-item assessment', () => {
    expect(ASSESSMENT_ITEMS).toHaveLength(22);
    expect(ASSESSMENT_ITEMS.filter(item => item.type === 'FREE_RESPONSE')).toHaveLength(2);
    expect(SCENARIOS).toHaveLength(18);
    for (const category of Object.values(ScenarioCategory)) {
      expect(SCENARIOS.filter(item => item.category === category)).toHaveLength(3);
    }
  });

  it('adapts one CEFR band at a time without leaving the supported range', () => {
    expect(adaptLevel(CefrLevel.A2, .75)).toBe(CefrLevel.B1);
    expect(adaptLevel(CefrLevel.B1, .5)).toBe(CefrLevel.B1);
    expect(adaptLevel(CefrLevel.B1, .25)).toBe(CefrLevel.A2);
    expect(adaptLevel(CefrLevel.A1, 0)).toBe(CefrLevel.A1);
    expect(adaptLevel(CefrLevel.C1, 1)).toBe(CefrLevel.C1);
  });

  it('requires prerequisite levels instead of promoting from one advanced guess', () => {
    const responses = [
      ...answers(CefrLevel.A1, 4),
      ...answers(CefrLevel.A2, 3),
      ...answers(CefrLevel.B1, 2),
      ...answers(CefrLevel.C1, 4),
    ];
    expect(highestPassedObjectiveLevel(responses)).toBe(CefrLevel.A2);
  });

  it('does not pass a CEFR band when its grammar foundation is missing', () => {
    const responses = [
      ...answers(CefrLevel.A1, 4),
      ...answers(CefrLevel.A2, 4).map(item => item.item.dimension === 'grammar' ? { ...item, isCorrect: false } : item),
    ];
    expect(highestPassedObjectiveLevel(responses)).toBe(CefrLevel.A1);
  });

  it('requires a completed free-expression task before awarding its score band', () => {
    const highScores = { vocabulary: 95, grammar: 95, sentenceBuilding: 95, taskCompletion: 40, naturalness: 95 };
    expect(expressionEvidenceLevel([{ isCorrect: false, scores: highScores }])).toBe(CefrLevel.A1);
  });

  it('never loses an objective that was completed in an earlier turn', () => {
    expect(mergeProgress(['确认预订', '询问早餐'], [{ objective: '确认预订', completed: true }], [{ objective: '询问早餐', completed: true }])).toEqual([
      { objective: '确认预订', completed: true },
      { objective: '询问早餐', completed: true },
    ]);
  });

  it('normalizes structured AI output and rejects a reply-less payload', () => {
    const result = normalizeTurn({ reply: 'Of course. May I see your passport?', taskProgress: [], blockingCorrection: null, deferredFeedback: [], scores: { vocabulary: 80, grammar: 100, sentenceBuilding: 85, taskCompletion: 75, naturalness: 72 }, vocabulary: [{ text: 'check in', type: 'PHRASE', meaning: '办理入住', example: 'I would like to check in.' }], skillCodes: ['polite-request'], sessionShouldEnd: false });
    expect(result.scores.grammar).toBe(100);
    expect(result.scores.naturalness).toBe(72);
    expect(result.vocabulary[0].type).toBe('PHRASE');
    expect(() => normalizeTurn({ scores: {} })).toThrow(BadGatewayException);
    expect(() => normalizeTurn({ reply: 'OK', taskProgress: [], blockingCorrection: null, deferredFeedback: [], vocabulary: [], scores: {}, skillCodes: [], sessionShouldEnd: false })).toThrow(BadGatewayException);
  });
});

function answers(level: CefrLevel, correct: number) {
  const dimensions = ['vocabulary', 'grammar', 'sentenceBuilding', 'taskCompletion'];
  return Array.from({ length: 4 }, (_, index) => ({ isCorrect: index < correct, item: { level, dimension: dimensions[index] } }));
}
