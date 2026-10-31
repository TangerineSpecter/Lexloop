import type { CareerStatistics } from '@lexloop/types';
import { BadGatewayException } from '@nestjs/common';
import { ProfileConfidence } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWeekGlance } from '../src/modules/reports/week-glance';
import {
  assessmentIsProvisional,
  careerInsights,
  ReportsService,
  validateAiAnalysis,
} from '../src/modules/reports/reports.service';

afterEach(() => vi.useRealTimers());

describe('learning career reporting rules', () => {
  it('prioritizes assessment, overdue reviews, and active weaknesses', () => {
    const baseline = baseCareer();
    const insights = careerInsights({
      ...baseline,
      memory: { ...baseline.memory, overdueWords: 7 },
      quality: { ...baseline.quality, activeWeaknesses: 3 },
    });
    expect(insights.recommendations.map((item) => item.target)).toEqual([
      'assessment',
      'review',
      'mistakes',
    ]);
    expect(insights.risks.join(' ')).toContain('7 个单词');
    expect(insights.risks.join(' ')).toContain('3 个活跃薄弱项');
  });

  it('recognizes stable accuracy and real-world practice as strengths', () => {
    const baseline = baseCareer();
    const insights = careerInsights({
      ...baseline,
      overview: { ...baseline.overview, activeDays: 12, totalQuestions: 50, completedScenarios: 5 },
      quality: { ...baseline.quality, accuracy: 92 },
      practice: { ...baseline.practice, successRate: 80 },
      profile: { ...baseline.profile, provisional: false },
    });
    expect(insights.strengths).toHaveLength(3);
    expect(insights.strengths.join(' ')).toContain('92%');
    expect(insights.strengths.join(' ')).toContain('场景任务成功率 80%');
  });

  it('accepts only bounded, actionable AI analysis payloads', () => {
    const result = validateAiAnalysis({
      headline: '先稳住复习，再去实战',
      summary: '你的正确率稳定，但有逾期单词。',
      strengths: ['正确率稳定', '节奏良好', '表达清楚', '多余内容'],
      focusAreas: ['逾期复习'],
      weeklyPlan: [{ action: '清理逾期单词', target: 'review', reason: '恢复复习节奏' }],
    });
    expect(result.strengths).toHaveLength(3);
    expect(result.weeklyPlan[0].target).toBe('review');
    expect(() =>
      validateAiAnalysis({ headline: '缺少计划', summary: '无计划', weeklyPlan: [] }),
    ).toThrow(BadGatewayException);
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

    await expect(service.streak('user')).resolves.toEqual({
      currentStreak: 3,
      todayActive: true,
      goal: { kind: 'activity', target: 1, progress: 1, met: true },
      week: buildWeekGlance({
        today: '2026-10-26',
        activeDates: new Set(['2026-10-24', '2026-10-25', '2026-10-26']),
        attempts: [
          { date: '2026-10-24', bookWordId: '2026-10-24T09:00:00.000Z', source: null },
          { date: '2026-10-26', bookWordId: '2026-10-26T09:00:00.000Z', source: null },
        ],
      }),
    });
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

    await expect(service.streak('user')).resolves.toEqual({
      currentStreak: 2,
      todayActive: false,
      goal: { kind: 'activity', target: 1, progress: 0, met: false },
      week: buildWeekGlance({
        today: '2026-10-26',
        activeDates: new Set(['2026-10-24', '2026-10-25']),
        attempts: [
          { date: '2026-10-25', bookWordId: '2026-10-25T09:00:00.000Z', source: null },
          { date: '2026-10-25', bookWordId: '2026-10-25T10:00:00.000Z', source: null },
        ],
      }),
    });
  });

  it('uses the learner time zone at the local day boundary across UTC midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T16:30:00.000Z'));
    const { service, prisma } = streakService({
      attemptDates: ['2026-10-25T16:01:00.000Z'],
      scenarioDates: ['2026-10-26T16:00:00.000Z'],
      practiceDates: ['2026-10-26'],
    });

    await expect(service.streak('user', 'Asia/Shanghai')).resolves.toEqual({
      currentStreak: 2,
      todayActive: true,
      goal: { kind: 'activity', target: 1, progress: 1, met: true },
      week: buildWeekGlance({
        today: '2026-10-27',
        activeDates: new Set(['2026-10-26', '2026-10-27']),
        attempts: [{ date: '2026-10-26', bookWordId: '2026-10-25T16:01:00.000Z', source: null }],
      }),
    });
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain('Asia/Shanghai');
  });

  it('returns an empty record for no learning events and rejects an invalid time zone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const { service } = streakService();

    await expect(service.streak('user')).resolves.toEqual({
      currentStreak: 0,
      todayActive: false,
      goal: { kind: 'activity', target: 1, progress: 0, met: false },
      week: buildWeekGlance({
        today: '2026-10-26',
        activeDates: new Set(),
        attempts: [],
      }),
    });
    await expect(service.streak('user', 'not-a-time-zone')).rejects.toThrow('Invalid time zone');
  });

  it('counts unique review words toward a review goal without treating a scenario as a review', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T16:30:00.000Z'));
    const { service } = streakService({
      goal: { dailyGoalKind: 'REVIEWS', dailyGoalTarget: 5 },
      scenarioDates: ['2026-10-26T16:00:00.000Z'],
      attemptDates: [
        { createdAt: '2026-10-26T16:00:00.000Z', bookWordId: 'alpha' },
        { createdAt: '2026-10-26T16:10:00.000Z', bookWordId: 'alpha' },
        { createdAt: '2026-10-26T15:30:00.000Z', bookWordId: 'yesterday-in-shanghai' },
      ],
    });

    await expect(service.streak('user', 'Asia/Shanghai')).resolves.toMatchObject({
      todayActive: true,
      goal: { kind: 'reviews', target: 5, progress: 1, met: false },
    });
    await expect(service.streak('user', 'UTC')).resolves.toMatchObject({
      goal: { kind: 'reviews', target: 5, progress: 2, met: false },
    });
  });

  it('saves a review goal and reports it from the same streak evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const { service, prisma } = streakService({
      attemptDates: [
        { createdAt: '2026-10-26T09:00:00.000Z', bookWordId: 'one' },
        { createdAt: '2026-10-26T10:00:00.000Z', bookWordId: 'two' },
      ],
    });

    await expect(service.updateDailyGoal('user', 'reviews', 7)).rejects.toThrow(
      '复习目标只能是 5、10 或 15 个词',
    );
    await expect(service.updateDailyGoal('user', 'reviews', 10, 'UTC')).resolves.toMatchObject({
      todayActive: true,
      goal: { kind: 'reviews', target: 10, progress: 2, met: false },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user' },
      data: { dailyGoalKind: 'REVIEWS', dailyGoalTarget: 10 },
    });
  });
});

describe('period statistics word signals', () => {
  it('returns each word’s attempt count with its accuracy and error rate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const { service, prisma } = periodStatisticsService();

    const statistics = await service.statistics('learner-a', 7);

    expect(statistics.rankings.accuracy).toEqual([
      { word: 'single', rate: 100, count: 1 },
      { word: 'mixed', rate: 50, count: 2 },
    ]);
    expect(statistics.rankings.errorRate).toEqual([
      { word: 'mixed', rate: 50, count: 2 },
      { word: 'single', rate: 0, count: 1 },
    ]);
    expect(prisma.wordReviewAttempt.findMany.mock.calls[0][0].where.userId).toBe('learner-a');
    expect(prisma.userWordProgress.findMany.mock.calls[0][0].where.userId).toBe('learner-a');
  });

  it('uses the learner calendar day for statistics across UTC midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T00:30:00.000Z'));
    const { service, prisma } = periodStatisticsService();

    const statistics = await service.statistics('learner-a', 7, 'Asia/Shanghai');

    expect(prisma.wordReviewAttempt.findMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-10-20T16:00:00.000Z'),
      lt: new Date('2026-10-27T16:00:00.000Z'),
    });
    expect(prisma.wordReviewAttempt.count.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-10-13T16:00:00.000Z'),
      lt: new Date('2026-10-20T16:00:00.000Z'),
    });
    expect(statistics.activity).toHaveLength(7);
    expect(statistics.activity[0].label).toBe('10 月 21 日');
    expect(statistics.activity[6]).toMatchObject({ label: '10 月 27 日', today: true });
    expect(statistics.chart[0].label).toBe('周三');
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain('Asia/Shanghai');
    expect(prisma.wordReviewAttempt.findMany.mock.calls[0][0].where.userId).toBe('learner-a');
  });

  it('keeps each learner day aligned across a daylight-saving transition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T16:30:00.000Z'));
    const { service, prisma } = periodStatisticsService();

    const statistics = await service.statistics('learner-a', 7, 'America/New_York');

    const window = prisma.wordReviewAttempt.findMany.mock.calls[0][0].where.createdAt!;
    expect(window.gte).toEqual(new Date('2026-03-02T05:00:00.000Z'));
    expect(window.lt).toEqual(new Date('2026-03-09T04:00:00.000Z'));
    expect(window.lt!.getTime() - window.gte.getTime()).toBe(167 * 60 * 60 * 1000);
    expect(statistics.activity).toHaveLength(7);
    expect(statistics.activity[6]).toMatchObject({ label: '3 月 8 日', today: true });
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain('America/New_York');
  });
});

describe('learning history cursor pagination', () => {
  it('keeps all source reads bounded on deep cursor pages and scopes each query to the learner', async () => {
    const { service, prisma } = historyService();
    const cursor = Buffer.from(
      JSON.stringify({
        id: 'history-position',
        occurredAt: '2026-10-29T12:00:00.000Z',
        kind: 'ASSESSMENT',
      }),
    ).toString('base64url');

    await service.history('learner-a', 1_000, 20, cursor);

    for (const source of [prisma.studyPlan, prisma.assessmentAttempt, prisma.scenarioSession]) {
      const query = source.findMany.mock.calls[0][0];
      expect(query.take).toBe(21);
      expect(query.skip).toBeUndefined();
      expect(query.where.userId).toBe('learner-a');
    }
    expect(prisma.studyPlan.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
    expect(prisma.assessmentAttempt.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
    expect(prisma.studyPlan.findMany.mock.calls[0][0].where.OR[1]).toEqual({
      completedAt: new Date('2026-10-29T12:00:00.000Z'),
      id: { lt: 'history-position' },
    });
    expect(prisma.scenarioSession.findMany.mock.calls[0][0].where.OR).toHaveLength(3);
  });

  it('rejects malformed cursors before issuing history queries', async () => {
    const { service, prisma } = historyService();

    await expect(service.history('learner-a', 1, 20, 'not a cursor')).rejects.toThrow(
      '学习历史游标无效',
    );
    expect(prisma.studyPlan.findMany).not.toHaveBeenCalled();
  });

  it('preserves numeric page requests for older clients', async () => {
    const { service, prisma } = historyService();
    prisma.studyPlan.findMany.mockResolvedValue([
      historyPlan('newest', '2026-10-29T12:00:00.000Z'),
      historyPlan('second', '2026-10-29T11:00:00.000Z'),
      historyPlan('older', '2026-10-29T10:00:00.000Z'),
    ] as never);

    const page = await service.history('learner-a', 2, 1);

    expect(prisma.studyPlan.findMany.mock.calls[0][0].take).toBe(3);
    expect(page.items.map((item) => item.id)).toEqual(['second']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
  });
});

function streakService({
  attemptDates = [],
  scenarioDates = [],
  assessmentDates = [],
  practiceDates = [],
  goal = { dailyGoalKind: 'ACTIVITY', dailyGoalTarget: 1 },
}: {
  attemptDates?: Array<string | { createdAt: string; bookWordId: string }>;
  scenarioDates?: string[];
  assessmentDates?: string[];
  practiceDates?: string[];
  goal?: { dailyGoalKind: string; dailyGoalTarget: number };
} = {}) {
  const user = { ...goal };
  const prisma = {
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async ({ data }: { data: typeof user }) => Object.assign(user, data)),
    },
    wordReviewAttempt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          attemptDates.map((attempt) =>
            typeof attempt === 'string'
              ? { createdAt: new Date(attempt), bookWordId: attempt }
              : { createdAt: new Date(attempt.createdAt), bookWordId: attempt.bookWordId },
          ),
        ),
    },
    scenarioSession: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          scenarioDates.map((completedAt) => ({ completedAt: new Date(completedAt) })),
        ),
    },
    assessmentAttempt: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          assessmentDates.map((completedAt) => ({ completedAt: new Date(completedAt) })),
        ),
    },
    $queryRaw: vi.fn().mockResolvedValue(practiceDates.map((dateKey) => ({ dateKey }))),
  };
  return { service: new ReportsService(prisma as never, {} as never), prisma };
}

function historyService() {
  const emptyFindMany = () => vi.fn().mockResolvedValue([]);
  const emptyCount = () => vi.fn().mockResolvedValue(0);
  const prisma = {
    studyPlan: { findMany: emptyFindMany(), count: emptyCount() },
    studyPlanItem: { count: emptyCount() },
    wordReviewAttempt: { count: emptyCount() },
    assessmentAttempt: { findMany: emptyFindMany(), count: emptyCount() },
    scenarioSession: { findMany: emptyFindMany(), count: emptyCount() },
  };
  return { service: new ReportsService(prisma as never, {} as never), prisma };
}

function historyPlan(id: string, completedAt: string) {
  return {
    id,
    completedAt: new Date(completedAt),
    mode: 'GROUP',
    items: [],
  };
}

function periodStatisticsService() {
  const now = new Date('2026-10-27T11:00:00.000Z');
  const attempts = [
    { bookWordId: 'one', isCorrect: true, createdAt: now, responseTimeMs: 800 },
    { bookWordId: 'two', isCorrect: true, createdAt: now, responseTimeMs: 900 },
    { bookWordId: 'two', isCorrect: false, createdAt: now, responseTimeMs: 1100 },
  ];
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ dailyGoalKind: 'ACTIVITY', dailyGoalTarget: 1 }),
    },
    wordReviewAttempt: {
      findMany: vi.fn(
        ({
          select,
        }: {
          select?: unknown;
          where: { userId: string; createdAt?: { gte: Date; lt?: Date } };
        }) => Promise.resolve(select ? [] : attempts),
      ),
      count: vi.fn().mockResolvedValue(0),
    },
    userWordProgress: {
      findMany: vi.fn().mockResolvedValue([
        {
          bookWordId: 'one',
          familiarity: 50,
          reviewCount: 0,
          firstLearnedAt: now,
          bookWord: { word: { text: 'single' } },
        },
        {
          bookWordId: 'two',
          familiarity: 35,
          reviewCount: 0,
          firstLearnedAt: now,
          bookWord: { word: { text: 'mixed' } },
        },
      ]),
    },
    userMasteredWord: { count: vi.fn().mockResolvedValue(0) },
    studyPlan: { findMany: vi.fn().mockResolvedValue([]) },
    scenarioSession: { findMany: vi.fn().mockResolvedValue([]) },
    assessmentAttempt: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { service: new ReportsService(prisma as never, {} as never), prisma };
}

function baseCareer(): Pick<
  CareerStatistics,
  'overview' | 'memory' | 'quality' | 'practice' | 'profile'
> {
  return {
    overview: {
      startedAt: new Date(0).toISOString(),
      activeDays: 0,
      totalQuestions: 0,
      studySeconds: 0,
      completedPlans: 0,
      learnedWords: 0,
      masteredWords: 0,
      completedScenarios: 0,
    },
    memory: { learningWords: 0, reviewingWords: 0, dueWords: 0, overdueWords: 0, masteryRate: 0 },
    quality: {
      accuracy: 0,
      averageResponseMs: 0,
      activeWeaknesses: 0,
      resolvedWeaknesses: 0,
      strongestQuestionType: null,
      weakestQuestionType: null,
    },
    practice: {
      successRate: 0,
      categoriesExperienced: 0,
      totalCategories: 6,
      categories: [],
      skills: [],
    },
    profile: {
      level: 'A1',
      confidence: 'LOW',
      provisional: true,
      assessedAt: null,
      dimensions: {
        vocabulary: 0,
        grammar: 0,
        sentenceBuilding: 0,
        taskCompletion: 0,
        naturalness: 0,
        pronunciation: null,
        listening: null,
        fluency: null,
      },
    },
  };
}
