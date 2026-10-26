import type { CareerStatistics } from '@lexloop/types';
import { BadGatewayException } from '@nestjs/common';
import { ProfileConfidence } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessmentIsProvisional, careerInsights, ReportsService, validateAiAnalysis } from '../src/modules/reports/reports.service';

afterEach(() => vi.useRealTimers());

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

  it('counts consecutive completed learning days and scopes evidence to the user', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const { service, prisma } = streakService({
      attemptDates: ['2026-10-24T09:00:00.000Z', '2026-10-26T09:00:00.000Z'],
      scenarioDates: ['2026-10-25T09:00:00.000Z'],
    });

    await expect(service.streak('user')).resolves.toEqual({ currentStreak: 3, todayActive: true });
    expect(prisma.wordReviewAttempt.findMany.mock.calls[0][0].where.userId).toBe('user');
    expect(prisma.scenarioSession.findMany.mock.calls[0][0].where.userId).toBe('user');
    expect(prisma.assessmentAttempt.findMany.mock.calls[0][0].where.userId).toBe('user');
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain('user');
  });

  it('keeps yesterday’s streak without claiming today activity and ignores duplicate events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const { service } = streakService({
      assessmentDates: ['2026-10-24T09:00:00.000Z'],
      attemptDates: ['2026-10-25T09:00:00.000Z', '2026-10-25T10:00:00.000Z'],
      practiceDates: ['2026-10-25'],
    });

    await expect(service.streak('user')).resolves.toEqual({ currentStreak: 2, todayActive: false });
  });

  it('uses the learner time zone at the local day boundary across UTC midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T16:30:00.000Z'));
    const { service, prisma } = streakService({
      attemptDates: ['2026-10-25T16:01:00.000Z'],
      scenarioDates: ['2026-10-26T16:00:00.000Z'],
      practiceDates: ['2026-10-26'],
    });

    await expect(service.streak('user', 'Asia/Shanghai')).resolves.toEqual({ currentStreak: 2, todayActive: true });
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain('Asia/Shanghai');
  });

  it('returns an empty record for no learning events and rejects an invalid time zone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const { service } = streakService();

    await expect(service.streak('user')).resolves.toEqual({ currentStreak: 0, todayActive: false });
    await expect(service.streak('user', 'not-a-time-zone')).rejects.toThrow('Invalid time zone');
  });
});

function streakService({ attemptDates = [], scenarioDates = [], assessmentDates = [], practiceDates = [] }: {
  attemptDates?: string[]; scenarioDates?: string[]; assessmentDates?: string[]; practiceDates?: string[];
} = {}) {
  const prisma = {
    wordReviewAttempt: { findMany: vi.fn().mockResolvedValue(attemptDates.map(createdAt => ({ createdAt: new Date(createdAt) }))) },
    scenarioSession: { findMany: vi.fn().mockResolvedValue(scenarioDates.map(completedAt => ({ completedAt: new Date(completedAt) }))) },
    assessmentAttempt: { findMany: vi.fn().mockResolvedValue(assessmentDates.map(completedAt => ({ completedAt: new Date(completedAt) }))) },
    $queryRaw: vi.fn().mockResolvedValue(practiceDates.map(dateKey => ({ dateKey }))),
  };
  return { service: new ReportsService(prisma as never, {} as never), prisma };
}

function baseCareer(): Pick<CareerStatistics, 'overview' | 'memory' | 'quality' | 'practice' | 'profile'> {
  return {
    overview: { startedAt: new Date(0).toISOString(), activeDays: 0, totalQuestions: 0, studySeconds: 0, completedPlans: 0, learnedWords: 0, masteredWords: 0, completedScenarios: 0 },
    memory: { learningWords: 0, reviewingWords: 0, dueWords: 0, overdueWords: 0, masteryRate: 0 },
    quality: { accuracy: 0, averageResponseMs: 0, activeWeaknesses: 0, resolvedWeaknesses: 0, strongestQuestionType: null, weakestQuestionType: null },
    practice: { successRate: 0, categoriesExperienced: 0, totalCategories: 6, categories: [], skills: [] },
    profile: { level: 'A1', confidence: 'LOW', provisional: true, assessedAt: null, dimensions: { vocabulary: 0, grammar: 0, sentenceBuilding: 0, taskCompletion: 0, naturalness: 0, pronunciation: null, listening: null, fluency: null } },
  };
}
