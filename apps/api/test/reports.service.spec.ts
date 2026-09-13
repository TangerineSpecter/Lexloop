import type { CareerStatistics } from '@lexloop/types';
import { BadGatewayException } from '@nestjs/common';
import { ProfileConfidence } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assessmentIsProvisional, careerInsights, validateAiAnalysis } from '../src/modules/reports/reports.service';

describe('learning career reporting rules', () => {
  it('prioritizes assessment, overdue reviews, and active weaknesses', () => {
    const baseline = baseCareer();
    const insights = careerInsights({ ...baseline, memory: { ...baseline.memory, overdueWords: 7 }, quality: { ...baseline.quality, activeWeaknesses: 3 } });
    expect(insights.recommendations.map(item => item.target)).toEqual(['assessment', 'review', 'mistakes']);
    expect(insights.risks.join(' ')).toContain('7 个单词');
    expect(insights.risks.join(' ')).toContain('3 个活跃薄弱项');
  });

  it('recognizes stable accuracy and real-world practice as strengths', () => {
    const baseline = baseCareer();
    const insights = careerInsights({ ...baseline, overview: { ...baseline.overview, activeDays: 12, totalQuestions: 50, completedScenarios: 5 }, quality: { ...baseline.quality, accuracy: 92 }, practice: { ...baseline.practice, successRate: 80 }, profile: { ...baseline.profile, provisional: false } });
    expect(insights.strengths).toHaveLength(3);
    expect(insights.strengths.join(' ')).toContain('92%');
    expect(insights.strengths.join(' ')).toContain('场景任务成功率 80%');
  });

  it('accepts only bounded, actionable AI analysis payloads', () => {
    const result = validateAiAnalysis({ headline: '先稳住复习，再去实战', summary: '你的正确率稳定，但有逾期单词。', strengths: ['正确率稳定', '节奏良好', '表达清楚', '多余内容'], focusAreas: ['逾期复习'], weeklyPlan: [{ action: '清理逾期单词', target: 'review', reason: '恢复复习节奏' }] });
    expect(result.strengths).toHaveLength(3);
    expect(result.weeklyPlan[0].target).toBe('review');
    expect(() => validateAiAnalysis({ headline: '缺少计划', summary: '无计划', weeklyPlan: [] })).toThrow(BadGatewayException);
  });

  it('keeps low-confidence and fallback-scored assessments provisional', () => {
    expect(assessmentIsProvisional(ProfileConfidence.LOW, [{ provisional: false }])).toBe(true);
    expect(assessmentIsProvisional(ProfileConfidence.MEDIUM, [{ provisional: true }])).toBe(true);
    expect(assessmentIsProvisional(ProfileConfidence.HIGH, [{ provisional: false }])).toBe(false);
  });
});

function baseCareer(): Pick<CareerStatistics, 'overview' | 'memory' | 'quality' | 'practice' | 'profile'> {
  return {
    overview: { startedAt: new Date(0).toISOString(), activeDays: 0, totalQuestions: 0, studySeconds: 0, completedPlans: 0, learnedWords: 0, masteredWords: 0, completedScenarios: 0 },
    memory: { learningWords: 0, reviewingWords: 0, dueWords: 0, overdueWords: 0, masteryRate: 0 },
    quality: { accuracy: 0, averageResponseMs: 0, activeWeaknesses: 0, resolvedWeaknesses: 0, strongestQuestionType: null, weakestQuestionType: null },
    practice: { successRate: 0, categoriesExperienced: 0, totalCategories: 6, categories: [], skills: [] },
    profile: { level: 'A1', confidence: 'LOW', provisional: true, assessedAt: null, dimensions: { vocabulary: 0, grammar: 0, sentenceBuilding: 0, taskCompletion: 0, naturalness: 0, pronunciation: null, listening: null, fluency: null } },
  };
}
