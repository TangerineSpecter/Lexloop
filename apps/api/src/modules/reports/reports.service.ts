import { createHash } from 'node:crypto';
import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import {
  AiCallStatus,
  AssessmentItemType,
  CefrLevel,
  DailyGoalKind,
  Prisma,
  ProfileConfidence,
  ProfileSnapshotSource,
  ScenarioOutcome,
  ScenarioSessionStatus,
  StudyPlanStatus,
  WeaknessStatus,
  WordProgressState,
} from '@prisma/client';
import type {
  CareerAiAnalysis,
  CareerRecommendation,
  CareerStatistics,
  LearningHistoryItem,
  LearningHistoryResponse,
  PeriodStatistics,
} from '@lexloop/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';

const DAY = 86_400_000;
const LEVELS = [CefrLevel.A1, CefrLevel.A2, CefrLevel.B1, CefrLevel.B2, CefrLevel.C1];
type Signal = {
  word: string;
  attempts: number;
  correct: number;
  familiarity: number;
  reviewCount: number;
};
type FiveDimensions = {
  vocabulary: number;
  grammar: number;
  sentenceBuilding: number;
  taskCompletion: number;
  naturalness: number;
};
type HistoryCursor = {
  id: string;
  occurredAt: Date;
  kind: LearningHistoryItem['kind'];
};
const HISTORY_KIND_RANK: Record<LearningHistoryItem['kind'], number> = {
  PLAN: 0,
  ASSESSMENT: 1,
  SCENARIO: 2,
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  async statistics(userId: string, days: number, timeZone = 'UTC'): Promise<PeriodStatistics> {
    timeZone = validateTimeZone(timeZone);
    const now = new Date();
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayKey = dateKeyInTimeZone(dateFormatter, now);
    const firstDayKey = shiftDateKey(todayKey, -(days - 1));
    const dayKeys = Array.from({ length: days }, (_, index) => shiftDateKey(firstDayKey, index));
    const start = localDayStart(firstDayKey, timeZone);
    const end = localDayStart(shiftDateKey(todayKey, 1), timeZone);
    const previousStart = localDayStart(shiftDateKey(firstDayKey, -days), timeZone);
    const [
      attempts,
      previousAttempts,
      progresses,
      mastered,
      plans,
      scenarios,
      assessments,
      practiceDays,
    ] = await Promise.all([
      this.prisma.wordReviewAttempt.findMany({
        where: { userId, createdAt: { gte: start, lt: end } },
        include: { item: { include: { bookWord: { include: { word: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.wordReviewAttempt.count({
        where: { userId, createdAt: { gte: previousStart, lt: start } },
      }),
      this.prisma.userWordProgress.findMany({
        where: { userId },
        include: { bookWord: { include: { word: true } } },
      }),
      this.prisma.userMasteredWord.count({
        where: { userId, masteredAt: { gte: start, lt: end } },
      }),
      this.prisma.studyPlan.findMany({
        where: { userId, status: StudyPlanStatus.COMPLETED, completedAt: { gte: start, lt: end } },
        select: { completedAt: true },
      }),
      this.prisma.scenarioSession.findMany({
        where: {
          userId,
          status: ScenarioSessionStatus.COMPLETED,
          completedAt: { gte: start, lt: end },
        },
        select: { completedAt: true },
      }),
      this.prisma.assessmentAttempt.findMany({
        where: { userId, status: 'COMPLETED', completedAt: { gte: start, lt: end } },
        select: { completedAt: true },
      }),
      this.practiceDays(userId, start, end, timeZone),
    ]);
    const practiceCounts = new Map(practiceDays.map((item) => [item.dateKey, item.count]));
    const dailyRows = new Map(
      dayKeys.map((dateKey) => [
        dateKey,
        { words: new Set<string>(), questions: 0, studySeconds: 0, scenarios: 0, assessments: 0 },
      ]),
    );
    for (const attempt of attempts) {
      const day = dailyRows.get(dateKeyInTimeZone(dateFormatter, attempt.createdAt));
      if (!day) continue;
      day.words.add(attempt.bookWordId);
      day.questions++;
      day.studySeconds += attempt.responseTimeMs ?? 0;
    }
    for (const scenario of scenarios) {
      if (!scenario.completedAt) continue;
      const day = dailyRows.get(dateKeyInTimeZone(dateFormatter, scenario.completedAt));
      if (day) day.scenarios++;
    }
    for (const assessment of assessments) {
      if (!assessment.completedAt) continue;
      const day = dailyRows.get(dateKeyInTimeZone(dateFormatter, assessment.completedAt));
      if (day) day.assessments++;
    }
    const activityDays = dayKeys.map((dateKey) => {
      const [, month, dayOfMonth] = dateKey.split('-').map(Number);
      const daily = dailyRows.get(dateKey)!;
      return {
        dateKey,
        label: `${month} 月 ${dayOfMonth} 日`,
        words: daily.words.size,
        questions: daily.questions,
        studySeconds: Math.round(daily.studySeconds / 1000),
        scenarios: daily.scenarios,
        assessments: daily.assessments,
        practiceSessions: practiceCounts.get(dateKey) ?? 0,
        today: dateKey === todayKey,
      };
    });
    const activity = activityDays.map(({ dateKey: _dateKey, ...day }) => day);
    const chart =
      days === 7
        ? activityDays.map((day, index) => ({
            label: index === 6 ? '今天' : weekDayForDateKey(day.dateKey),
            words: day.words,
            completed: isActiveDay(day),
            today: day.today,
          }))
        : periodChart(activityDays, days === 365 ? 12 : 10);
    const activeDays = activity.filter(isActiveDay).length;
    const signals = signalRows(progresses, attempts);
    const responseTimes = attempts
      .map((item) => item.responseTimeMs)
      .filter((value): value is number => value != null);
    const streak = await this.streakSummary(userId, timeZone);
    return {
      activeDays,
      activity,
      chart,
      currentStreak: streak.currentStreak,
      dailyGoal: streak.goal,
      learnedWords: progresses.filter((item) => item.firstLearnedAt).length,
      masteredWords: mastered,
      newWords: progresses.filter(
        (item) => item.firstLearnedAt && item.firstLearnedAt >= start && item.firstLearnedAt < end,
      ).length,
      reviewWords: attempts.length,
      attemptCount: attempts.length,
      accuracy: attempts.length
        ? Math.round((attempts.filter((item) => item.isCorrect).length / attempts.length) * 100)
        : 0,
      averageResponseMs: responseTimes.length
        ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
        : 0,
      studySeconds: Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / 1000),
      completedPlans: plans.length,
      completedScenarios: scenarios.length,
      completedAssessments: assessments.length,
      versusPrevious: previousAttempts
        ? Math.round(((attempts.length - previousAttempts) / previousAttempts) * 100)
        : attempts.length
          ? 100
          : 0,
      summary: activeDays
        ? `本期有 ${activeDays} 天留下学习记录，共完成 ${attempts.length} 道题和 ${scenarios.length} 次场景练习。`
        : '本期还没有学习记录。',
      suggestion: signals.unfamiliar[0]
        ? `建议优先巩固 ${signals.unfamiliar[0].word}，它目前的陌生程度最高。`
        : '从一个单词或一次场景练习开始，建立今天的学习节奏。',
      rankings: signals,
    };
  }

  async streak(userId: string, timeZone = 'UTC') {
    return this.streakSummary(userId, timeZone);
  }

  async updateDailyGoal(
    userId: string,
    kind: 'activity' | 'reviews',
    target: number | undefined,
    timeZone = 'UTC',
  ) {
    if (kind === 'reviews' && target !== 5 && target !== 10 && target !== 15) {
      throw new BadRequestException('复习目标只能是 5、10 或 15 个词');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        dailyGoalKind: kind === 'reviews' ? DailyGoalKind.REVIEWS : DailyGoalKind.ACTIVITY,
        dailyGoalTarget: kind === 'reviews' ? target! : 1,
      },
    });
    return this.streak(userId, timeZone);
  }

  async history(
    userId: string,
    requestedPage = 1,
    requestedPageSize = 20,
    encodedCursor?: string,
  ): Promise<LearningHistoryResponse> {
    const page = Math.min(1_000, Math.max(1, Math.trunc(requestedPage)));
    const pageSize = Math.min(50, Math.max(1, Math.trunc(requestedPageSize)));
    const cursor = encodedCursor ? decodeHistoryCursor(encodedCursor) : null;
    // Keep numeric-page requests compatible. The app uses the bounded cursor path below.
    const legacyOffsetPage = !cursor && page > 1;
    const take = legacyOffsetPage ? page * pageSize + 1 : pageSize + 1;
    const afterCursor = (kind: LearningHistoryItem['kind']) =>
      cursor ? historyAfterCursor(cursor, kind) : undefined;
    const [
      plans,
      assessments,
      scenarios,
      planCount,
      wordCount,
      questionCount,
      correctQuestionCount,
      assessmentCount,
      scenarioCount,
    ] = await Promise.all([
      this.prisma.studyPlan.findMany({
        where: {
          userId,
          status: StudyPlanStatus.COMPLETED,
          completedAt: { not: null },
          ...afterCursor('PLAN'),
        },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        take,
        include: {
          items: {
            include: {
              bookWord: { include: { word: true } },
              attempts: { orderBy: { createdAt: 'desc' }, take: 1 },
            },
          },
        },
      }),
      this.prisma.assessmentAttempt.findMany({
        where: {
          userId,
          status: 'COMPLETED',
          completedAt: { not: null },
          ...afterCursor('ASSESSMENT'),
        },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        take,
        include: { responses: { select: { provisional: true } } },
      }),
      this.prisma.scenarioSession.findMany({
        where: {
          userId,
          status: ScenarioSessionStatus.COMPLETED,
          completedAt: { not: null },
          report: { isNot: null },
          ...afterCursor('SCENARIO'),
        },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        take,
        include: {
          template: { select: { title: true, category: true } },
          report: { select: { outcome: true } },
        },
      }),
      this.prisma.studyPlan.count({
        where: { userId, status: StudyPlanStatus.COMPLETED, completedAt: { not: null } },
      }),
      this.prisma.studyPlanItem.count({
        where: { plan: { userId, status: StudyPlanStatus.COMPLETED, completedAt: { not: null } } },
      }),
      this.prisma.wordReviewAttempt.count({
        where: {
          userId,
          item: { plan: { status: StudyPlanStatus.COMPLETED, completedAt: { not: null } } },
        },
      }),
      this.prisma.wordReviewAttempt.count({
        where: {
          userId,
          isCorrect: true,
          item: { plan: { status: StudyPlanStatus.COMPLETED, completedAt: { not: null } } },
        },
      }),
      this.prisma.assessmentAttempt.count({
        where: { userId, status: 'COMPLETED', completedAt: { not: null } },
      }),
      this.prisma.scenarioSession.count({
        where: {
          userId,
          status: ScenarioSessionStatus.COMPLETED,
          completedAt: { not: null },
          report: { isNot: null },
        },
      }),
    ]);
    const items: LearningHistoryItem[] = [
      ...plans.map((plan) => {
        const attempts = plan.items.flatMap((item) => item.attempts);
        const typeStats = questionTypeRows(attempts);
        return {
          kind: 'PLAN' as const,
          id: plan.id,
          occurredAt: plan.completedAt!.toISOString(),
          mode: plan.mode.toLowerCase() as 'group' | 'individual' | 'exam',
          wordCount: plan.items.length,
          totalQuestions: attempts.length,
          correctQuestions: attempts.filter((item) => item.isCorrect).length,
          durationSeconds: Math.round(
            attempts.reduce((sum, item) => sum + (item.responseTimeMs ?? 0), 0) / 1_000,
          ),
          typeStats,
          weakWords: [
            ...new Set(
              plan.items
                .filter((item) => item.attempts[0]?.isCorrect === false)
                .map((item) => item.bookWord.word.text),
            ),
          ],
        };
      }),
      ...assessments.map((attempt) => {
        const confidence = attempt.confidence ?? ProfileConfidence.LOW;
        return {
          kind: 'ASSESSMENT' as const,
          id: attempt.id,
          occurredAt: attempt.completedAt!.toISOString(),
          level: lowerLevel(
            attempt.objectiveLevel ?? CefrLevel.A1,
            attempt.expressionLevel ?? CefrLevel.A1,
          ),
          confidence,
          provisional: assessmentIsProvisional(confidence, attempt.responses),
          questionCount: attempt.itemCount,
        };
      }),
      ...scenarios.flatMap((session) =>
        session.report
          ? [
              {
                kind: 'SCENARIO' as const,
                id: session.id,
                occurredAt: session.completedAt!.toISOString(),
                title: session.template.title,
                category: session.template.category,
                level: session.level,
                outcome: session.report.outcome,
              },
            ]
          : [],
      ),
    ].sort(
      (left, right) =>
        new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime() ||
        right.id.localeCompare(left.id) ||
        HISTORY_KIND_RANK[left.kind] - HISTORY_KIND_RANK[right.kind],
    );
    const start = legacyOffsetPage ? (page - 1) * pageSize : 0;
    const end = start + pageSize;
    const pageItems = items.slice(start, end);
    return {
      items: pageItems,
      hasMore: items.length > end,
      nextCursor:
        items.length > end && pageItems.length
          ? encodeHistoryCursor(pageItems[pageItems.length - 1])
          : null,
      totals: {
        records: planCount + assessmentCount + scenarioCount,
        plans: planCount,
        words: wordCount,
        questions: questionCount,
        correctQuestions: correctQuestionCount,
        assessments: assessmentCount,
        scenarios: scenarioCount,
      },
    };
  }

  async career(
    userId: string,
    requestedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ): Promise<CareerStatistics> {
    const timeZone = validateTimeZone(requestedTimeZone);
    await this.ensureBackfilledSnapshots(userId);
    const now = new Date();
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayStart = localDayStart(dateKeyInTimeZone(dateFormatter, now), timeZone);
    const localDateKey = (date: Date) => dateKeyInTimeZone(dateFormatter, date);
    const [
      user,
      attempts,
      progresses,
      masteredWordRows,
      plans,
      learningEvents,
      weaknesses,
      profile,
      snapshots,
      scenarios,
      assessments,
      skills,
      cache,
    ] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
      this.prisma.wordReviewAttempt.findMany({
        where: { userId },
        select: { isCorrect: true, responseTimeMs: true, questionType: true, createdAt: true },
      }),
      this.prisma.userWordProgress.findMany({
        where: { userId },
        select: {
          state: true,
          nextReviewAt: true,
          firstLearnedAt: true,
          bookWord: {
            select: {
              wordId: true,
              word: { select: { masteredBy: { where: { userId }, select: { id: true } } } },
            },
          },
        },
      }),
      this.prisma.userMasteredWord.findMany({ where: { userId }, select: { wordId: true } }),
      this.prisma.studyPlan.findMany({
        where: { userId, status: StudyPlanStatus.COMPLETED },
        select: { completedAt: true },
      }),
      this.prisma.learningEvent.findMany({ where: { userId }, select: { createdAt: true } }),
      this.prisma.weaknessSignal.findMany({ where: { userId }, select: { status: true } }),
      this.prisma.languageProfile.findUnique({ where: { userId } }),
      this.prisma.languageProfileSnapshot.findMany({
        where: { userId },
        orderBy: { recordedAt: 'asc' },
      }),
      this.prisma.scenarioSession.findMany({
        where: { userId, status: ScenarioSessionStatus.COMPLETED },
        select: {
          completedAt: true,
          template: { select: { category: true } },
          report: { select: { outcome: true } },
        },
      }),
      this.prisma.assessmentAttempt.findMany({
        where: { userId, status: 'COMPLETED' },
        select: { completedAt: true },
      }),
      this.prisma.userSkillProgress.findMany({
        where: { userId },
        include: { skill: true },
        orderBy: [{ score: 'asc' }, { lastPracticedAt: 'desc' }],
      }),
      this.prisma.learningAnalysisCache.findUnique({ where: { userId } }),
    ]);
    const activeDates = new Set<string>();
    attempts.forEach((item) => activeDates.add(localDateKey(item.createdAt)));
    plans.forEach((item) => item.completedAt && activeDates.add(localDateKey(item.completedAt)));
    learningEvents.forEach((item) => activeDates.add(localDateKey(item.createdAt)));
    scenarios.forEach(
      (item) => item.completedAt && activeDates.add(localDateKey(item.completedAt)),
    );
    assessments.forEach(
      (item) => item.completedAt && activeDates.add(localDateKey(item.completedAt)),
    );
    const activityDates = [
      ...attempts.map((item) => item.createdAt),
      ...plans.map((item) => item.completedAt),
      ...learningEvents.map((item) => item.createdAt),
      ...scenarios.map((item) => item.completedAt),
      ...assessments.map((item) => item.completedAt),
    ].filter((value): value is Date => Boolean(value));
    const responseTimes = attempts
      .map((item) => item.responseTimeMs)
      .filter((value): value is number => value != null);
    const typeRows = questionTypeRows(attempts);
    const masteredWordIds = new Set(masteredWordRows.map((item) => item.wordId));
    const learnedWordIds = new Set([
      ...masteredWordIds,
      ...progresses.filter((item) => item.firstLearnedAt).map((item) => item.bookWord.wordId),
    ]);
    const learnedWords = learnedWordIds.size;
    const masteredWords = masteredWordIds.size;
    const reviewableProgresses = progresses.filter(
      (item) => item.bookWord.word.masteredBy.length === 0,
    );
    const dueWords = reviewableProgresses.filter(
      (item) =>
        item.state === WordProgressState.REVIEWING && item.nextReviewAt && item.nextReviewAt <= now,
    ).length;
    const overdueWords = reviewableProgresses.filter(
      (item) =>
        item.state === WordProgressState.REVIEWING &&
        item.nextReviewAt &&
        item.nextReviewAt < todayStart,
    ).length;
    const completedScenarios = scenarios.length;
    const successfulScenarios = scenarios.filter(
      (item) => item.report?.outcome === ScenarioOutcome.SUCCESS,
    ).length;
    const categoryRows = [...new Set(scenarios.map((item) => item.template.category))]
      .map((category) => {
        const rows = scenarios.filter((item) => item.template.category === category);
        const successful = rows.filter(
          (item) => item.report?.outcome === ScenarioOutcome.SUCCESS,
        ).length;
        return {
          category,
          count: rows.length,
          successRate: Math.round((successful / rows.length) * 100),
        };
      })
      .sort((left, right) => right.count - left.count);
    const overview = {
      startedAt: new Date(
        Math.min(
          user.createdAt.getTime(),
          ...(activityDates.length
            ? activityDates.map((value) => value.getTime())
            : [user.createdAt.getTime()]),
        ),
      ).toISOString(),
      activeDays: activeDates.size,
      totalQuestions: attempts.length,
      studySeconds: Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / 1000),
      completedPlans: plans.length,
      learnedWords,
      masteredWords,
      completedScenarios,
    };
    const memory = {
      learningWords: reviewableProgresses.filter(
        (item) => item.state === WordProgressState.LEARNING,
      ).length,
      reviewingWords: reviewableProgresses.filter(
        (item) => item.state === WordProgressState.REVIEWING,
      ).length,
      dueWords,
      overdueWords,
      masteryRate: learnedWords ? Math.round((masteredWords / learnedWords) * 100) : 0,
    };
    const quality = {
      accuracy: attempts.length
        ? Math.round((attempts.filter((item) => item.isCorrect).length / attempts.length) * 100)
        : 0,
      averageResponseMs: responseTimes.length
        ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
        : 0,
      activeWeaknesses: weaknesses.filter((item) => item.status === WeaknessStatus.ACTIVE).length,
      resolvedWeaknesses: weaknesses.filter((item) => item.status === WeaknessStatus.RESOLVED)
        .length,
      strongestQuestionType: typeRows.at(-1)?.type ?? null,
      weakestQuestionType: typeRows[0]?.type ?? null,
    };
    const practice = {
      successRate: completedScenarios
        ? Math.round((successfulScenarios / completedScenarios) * 100)
        : 0,
      categoriesExperienced: new Set(scenarios.map((item) => item.template.category)).size,
      totalCategories: 6,
      categories: categoryRows,
      skills: skills.map((item) => ({
        code: item.skill.code,
        title: item.skill.title,
        level: item.skill.level,
        score: item.score,
        evidenceCount: item.evidenceCount,
      })),
    };
    const currentProfile = {
      level: profile?.overallLevel ?? CefrLevel.A1,
      confidence: profile?.confidence ?? ProfileConfidence.LOW,
      provisional: profile?.provisional ?? true,
      assessedAt: profile?.assessedAt?.toISOString() ?? null,
      dimensions: profileDimensions(profile),
    };
    const insights = careerInsights({
      overview,
      memory,
      quality,
      practice,
      profile: currentProfile,
    });
    const resultWithoutAnalysis = {
      generatedAt: now.toISOString(),
      overview,
      profile: currentProfile,
      growth: snapshots.map((item) => ({
        id: item.id,
        source: item.source,
        level: item.overallLevel,
        confidence: item.confidence,
        provisional: item.provisional,
        dimensions: snapshotDimensions(item),
        recordedAt: item.recordedAt.toISOString(),
        backfilled: item.backfilled,
      })),
      memory,
      quality,
      practice,
      insights,
    };
    const inputHash = careerHash(resultWithoutAnalysis);
    return {
      ...resultWithoutAnalysis,
      aiAnalysis: {
        status: cache ? (cache.inputHash === inputHash ? 'ready' : 'stale') : 'none',
        generatedAt: cache?.generatedAt.toISOString() ?? null,
        content: cache ? parseStoredAnalysis(cache.content) : null,
      },
    };
  }

  async generateCareerAnalysis(userId: string) {
    const career = await this.career(userId);
    const inputHash = careerHash(career);
    const audit = await this.prisma.aiCallAudit.create({
      data: { userId, purpose: 'learning-career-analysis', promptVersion: 'v1' },
    });
    const startedAt = Date.now();
    try {
      const response = await this.ai.generateForUser(
        {
          purpose: 'learning-career-analysis',
          prompt: `请根据以下匿名聚合学习数据生成简洁、具体、可执行的中文学习分析。不得虚构数据，不得诊断用户。只返回 JSON：{"headline":"一句标题","summary":"2-3句总结","strengths":["最多3项"],"focusAreas":["最多3项"],"weeklyPlan":[{"action":"行动","target":"assessment|review|mistakes|travel|study","reason":"原因"}]}。\n数据：${JSON.stringify({ overview: career.overview, profile: career.profile, memory: career.memory, quality: career.quality, practice: career.practice, ruleInsights: career.insights })}`,
        },
        userId,
      );
      const content = validateAiAnalysis(extractCompletion(response));
      const generatedAt = new Date();
      await Promise.all([
        this.prisma.learningAnalysisCache.upsert({
          where: { userId },
          create: {
            userId,
            inputHash,
            content: content as unknown as Prisma.InputJsonValue,
            generatedAt,
          },
          update: { inputHash, content: content as unknown as Prisma.InputJsonValue, generatedAt },
        }),
        this.prisma.aiCallAudit.update({
          where: { id: audit.id },
          data: {
            status: AiCallStatus.SUCCEEDED,
            latencyMs: Date.now() - startedAt,
            completedAt: generatedAt,
          },
        }),
      ]);
      return { status: 'ready' as const, generatedAt: generatedAt.toISOString(), content };
    } catch (error) {
      await this.prisma.aiCallAudit.update({
        where: { id: audit.id },
        data: {
          status: AiCallStatus.FAILED,
          latencyMs: Date.now() - startedAt,
          errorCode: safeError(error),
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async ensureBackfilledSnapshots(userId: string) {
    const [profile, assessments, existingSnapshots] = await Promise.all([
      this.prisma.languageProfile.findUnique({ where: { userId } }),
      this.prisma.assessmentAttempt.findMany({
        where: { userId, status: 'COMPLETED', completedAt: { not: null } },
        include: { responses: { include: { item: true } } },
      }),
      this.prisma.languageProfileSnapshot.count({ where: { userId } }),
    ]);
    const rows: Prisma.LanguageProfileSnapshotCreateManyInput[] = assessments.map((attempt) => {
      const dimensions = assessmentDimensions(attempt.responses);
      const confidence = attempt.confidence ?? ProfileConfidence.LOW;
      return {
        userId,
        source: ProfileSnapshotSource.ASSESSMENT,
        sourceId: attempt.id,
        overallLevel: lowerLevel(
          attempt.objectiveLevel ?? CefrLevel.A1,
          attempt.expressionLevel ?? CefrLevel.A1,
        ),
        confidence,
        ...snapshotFields(dimensions),
        provisional: assessmentIsProvisional(confidence, attempt.responses),
        backfilled: true,
        recordedAt: attempt.completedAt!,
      };
    });
    const hasMeaningfulProfile =
      profile &&
      (profile.assessedAt ||
        Object.values(profileDimensions(profile)).some(
          (value) => typeof value === 'number' && value > 0,
        ));
    if (!existingSnapshots && hasMeaningfulProfile)
      rows.push({
        userId,
        source: ProfileSnapshotSource.BACKFILLED_BASELINE,
        sourceId: 'current-profile',
        overallLevel: profile.overallLevel,
        confidence: profile.confidence,
        ...snapshotFields(profileDimensions(profile)),
        provisional: profile.provisional,
        backfilled: true,
        recordedAt: profile.assessedAt ?? profile.updatedAt,
      });
    if (rows.length)
      await this.prisma.languageProfileSnapshot.createMany({ data: rows, skipDuplicates: true });
  }

  private async streakSummary(userId: string, requestedTimeZone: string) {
    const timeZone = validateTimeZone(requestedTimeZone);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const getDateKey = (date: Date) => dateKeyInTimeZone(formatter, date);
    const now = new Date();
    const since = new Date(now.getTime() - 367 * DAY);
    const [attempts, scenarios, assessments, practiceDates, user] = await Promise.all([
      this.prisma.wordReviewAttempt.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { createdAt: true, bookWordId: true },
      }),
      this.prisma.scenarioSession.findMany({
        where: { userId, status: ScenarioSessionStatus.COMPLETED, completedAt: { gte: since } },
        select: { completedAt: true },
      }),
      this.prisma.assessmentAttempt.findMany({
        where: { userId, status: 'COMPLETED', completedAt: { gte: since } },
        select: { completedAt: true },
      }),
      this.prisma.$queryRaw<Array<{ dateKey: string }>>`
        SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS "dateKey"
        FROM "LearningEvent"
        WHERE "userId" = ${userId} AND "createdAt" >= ${since} AND "createdAt" < ${now}
          AND "type" IN ('OUTPUT_COMPLETED', 'CONFUSION_COMPLETED', 'READING_COMPLETED', 'GRAMMAR_COMPLETED', 'MICRO_STORY_COMPLETED')
        GROUP BY 1
      `,
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { dailyGoalKind: true, dailyGoalTarget: true },
      }),
    ]);
    const eventDates = [
      ...attempts.map((item) => item.createdAt),
      ...scenarios.map((item) => item.completedAt),
      ...assessments.map((item) => item.completedAt),
    ].filter((value): value is Date => Boolean(value));
    const days = new Set([
      ...eventDates.map(getDateKey),
      ...practiceDates.map((item) => item.dateKey),
    ]);
    const today = getDateKey(now);
    const todayActive = days.has(today);
    const cursor = new Date(`${today}T00:00:00.000Z`);
    if (!todayActive) cursor.setUTCDate(cursor.getUTCDate() - 1);
    let streak = 0;
    while (days.has(utcDateKey(cursor))) {
      streak++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    const todayReviewCount = new Set(
      attempts
        .filter((item) => getDateKey(item.createdAt) === today)
        .map((item) => item.bookWordId || item.createdAt.toISOString()),
    ).size;
    const kind: 'activity' | 'reviews' =
      user?.dailyGoalKind === DailyGoalKind.REVIEWS ? 'reviews' : 'activity';
    const target = kind === 'reviews' ? normalizeReviewTarget(user?.dailyGoalTarget) : 1;
    const progress = kind === 'reviews' ? Math.min(todayReviewCount, target) : todayActive ? 1 : 0;
    const met = kind === 'reviews' ? todayReviewCount >= target : todayActive;
    return {
      currentStreak: streak,
      todayActive,
      goal: { kind, target, progress, met },
    };
  }
  private practiceDays(userId: string, start: Date, end: Date, timeZone: string) {
    return this.prisma.$queryRaw<Array<{ dateKey: string; count: number }>>`
      SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS "dateKey", COUNT(*)::int AS count
      FROM "LearningEvent" WHERE "userId" = ${userId} AND "createdAt" >= ${start} AND "createdAt" < ${end}
        AND "type" IN ('OUTPUT_COMPLETED', 'CONFUSION_COMPLETED', 'READING_COMPLETED', 'GRAMMAR_COMPLETED', 'MICRO_STORY_COMPLETED')
      GROUP BY 1
    `;
  }
}

function normalizeReviewTarget(value: number | null | undefined) {
  return value === 5 || value === 10 || value === 15 ? value : 10;
}

function isActiveDay(day: {
  questions: number;
  scenarios: number;
  assessments: number;
  practiceSessions?: number;
}) {
  return (
    day.questions > 0 || day.scenarios > 0 || day.assessments > 0 || (day.practiceSessions ?? 0) > 0
  );
}
function signalRows(
  progresses: Array<{
    bookWordId: string;
    familiarity: number;
    reviewCount: number;
    bookWord: { word: { text: string } };
  }>,
  attempts: Array<{ bookWordId: string; isCorrect: boolean }>,
) {
  const rows: Signal[] = progresses.map((progress) => {
    const rangeAttempts = attempts.filter((attempt) => attempt.bookWordId === progress.bookWordId);
    return {
      word: progress.bookWord.word.text,
      attempts: rangeAttempts.length,
      correct: rangeAttempts.filter((attempt) => attempt.isCorrect).length,
      familiarity: progress.familiarity,
      reviewCount: progress.reviewCount,
    };
  });
  const withAttempts = rows.filter((row) => row.attempts > 0);
  const rate = (row: Signal) => (row.attempts ? (row.correct / row.attempts) * 100 : 0);
  return {
    reviews: [...rows]
      .filter((row) => row.reviewCount > 0)
      .sort((a, b) => b.reviewCount - a.reviewCount)
      .slice(0, 5)
      .map((row) => ({ word: row.word, count: row.reviewCount })),
    unfamiliar: [...rows]
      .sort((a, b) => a.familiarity - b.familiarity)
      .slice(0, 5)
      .reverse()
      .map((row) => ({ word: row.word, rate: 100 - row.familiarity })),
    errorRate: [...withAttempts]
      .sort((a, b) => rate(a) - rate(b))
      .slice(0, 10)
      .map((row) => ({ word: row.word, rate: 100 - rate(row), count: row.attempts })),
    accuracy: [...withAttempts]
      .sort((a, b) => rate(b) - rate(a))
      .slice(0, 10)
      .map((row) => ({ word: row.word, rate: rate(row), count: row.attempts })),
  };
}
function questionTypeRows(attempts: Array<{ questionType: string | null; isCorrect: boolean }>) {
  const grouped = new Map<string, { type: string; total: number; correct: number }>();
  for (const item of attempts) {
    const type = item.questionType ?? 'OTHER';
    const row = grouped.get(type) ?? { type, total: 0, correct: 0 };
    row.total++;
    if (item.isCorrect) row.correct++;
    grouped.set(type, row);
  }
  return [...grouped.values()].sort((a, b) => a.correct / a.total - b.correct / b.total);
}
function profileDimensions(
  profile: {
    vocabularyScore: number;
    grammarScore: number;
    sentenceBuildingScore: number;
    taskCompletionScore: number;
    naturalnessScore: number;
    pronunciationScore?: number | null;
    listeningScore?: number | null;
    fluencyScore?: number | null;
  } | null,
): CareerStatistics['profile']['dimensions'] {
  return {
    vocabulary: profile?.vocabularyScore ?? 0,
    grammar: profile?.grammarScore ?? 0,
    sentenceBuilding: profile?.sentenceBuildingScore ?? 0,
    taskCompletion: profile?.taskCompletionScore ?? 0,
    naturalness: profile?.naturalnessScore ?? 0,
    pronunciation: profile?.pronunciationScore ?? null,
    listening: profile?.listeningScore ?? null,
    fluency: profile?.fluencyScore ?? null,
  };
}
function snapshotDimensions(value: {
  vocabularyScore: number;
  grammarScore: number;
  sentenceBuildingScore: number;
  taskCompletionScore: number;
  naturalnessScore: number;
}): FiveDimensions {
  return {
    vocabulary: value.vocabularyScore,
    grammar: value.grammarScore,
    sentenceBuilding: value.sentenceBuildingScore,
    taskCompletion: value.taskCompletionScore,
    naturalness: value.naturalnessScore,
  };
}
function snapshotFields(value: FiveDimensions) {
  return {
    vocabularyScore: value.vocabulary,
    grammarScore: value.grammar,
    sentenceBuildingScore: value.sentenceBuilding,
    taskCompletionScore: value.taskCompletion,
    naturalnessScore: value.naturalness,
  };
}
function assessmentIsProvisional(
  confidence: ProfileConfidence,
  responses: Array<{ provisional: boolean }>,
) {
  return confidence === ProfileConfidence.LOW || responses.some((item) => item.provisional);
}
function assessmentDimensions(
  responses: Array<{
    isCorrect: boolean | null;
    scores: Prisma.JsonValue | null;
    item: { dimension: string; type: AssessmentItemType };
  }>,
): FiveDimensions {
  const keys: Array<keyof FiveDimensions> = [
    'vocabulary',
    'grammar',
    'sentenceBuilding',
    'taskCompletion',
    'naturalness',
  ];
  const result = {
    vocabulary: 0,
    grammar: 0,
    sentenceBuilding: 0,
    taskCompletion: 0,
    naturalness: 0,
  };
  for (const key of keys) {
    const objective = responses.filter(
      (item) => item.item.type !== AssessmentItemType.FREE_RESPONSE && item.item.dimension === key,
    );
    const expression = responses
      .filter((item) => item.item.type === AssessmentItemType.FREE_RESPONSE)
      .map((item) => jsonScores(item.scores)[key]);
    const objectiveScore = objective.length
      ? (objective.filter((item) => item.isCorrect).length / objective.length) * 100
      : null;
    result[key] = Math.round(
      objectiveScore === null
        ? average(expression)
        : expression.length
          ? objectiveScore * 0.7 + average(expression) * 0.3
          : objectiveScore,
    );
  }
  return result;
}
function jsonScores(value: unknown): FiveDimensions {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const score = (key: string) => Math.max(0, Math.min(100, Number(row[key]) || 0));
  return {
    vocabulary: score('vocabulary'),
    grammar: score('grammar'),
    sentenceBuilding: score('sentenceBuilding'),
    taskCompletion: score('taskCompletion'),
    naturalness: score('naturalness'),
  };
}
function careerInsights(
  data: Pick<CareerStatistics, 'overview' | 'memory' | 'quality' | 'practice' | 'profile'>,
): CareerStatistics['insights'] {
  const strengths: string[] = [];
  const risks: string[] = [];
  const recommendations: CareerRecommendation[] = [];
  if (data.quality.accuracy >= 85 && data.overview.totalQuestions >= 10)
    strengths.push(`累计正确率 ${data.quality.accuracy}%，基础掌握较稳定。`);
  if (data.overview.activeDays >= 7)
    strengths.push(`已经留下 ${data.overview.activeDays} 个学习日，节奏正在形成。`);
  if (data.practice.successRate >= 70 && data.overview.completedScenarios > 0)
    strengths.push(`场景任务成功率 ${data.practice.successRate}%，实战表达表现良好。`);
  if (data.profile.provisional) {
    risks.push('当前 CEFR 仍是暂定起点，能力判断缺少正式测评证据。');
    recommendations.push({
      title: '完成一次水平测评',
      reason: '建立可信的 CEFR 起点和五维能力画像。',
      target: 'assessment',
    });
  }
  if (data.memory.overdueWords > 0) {
    risks.push(`${data.memory.overdueWords} 个单词已经逾期复习。`);
    recommendations.push({
      title: '先清理逾期复习',
      reason: '按记忆节奏及时再见一面，比继续堆新词更有效。',
      target: 'review',
    });
  }
  if (data.quality.activeWeaknesses > 0) {
    risks.push(`仍有 ${data.quality.activeWeaknesses} 个活跃薄弱项。`);
    recommendations.push({
      title: '完成薄弱项专项',
      reason: '连续答对后系统会自动标记为已纠正。',
      target: 'mistakes',
    });
  }
  if (!data.overview.completedScenarios)
    recommendations.push({
      title: '完成第一次场景练习',
      reason: '把词汇和语法放进真实表达任务中验证。',
      target: 'travel',
    });
  if (!recommendations.length)
    recommendations.push({
      title: '保持当前学习节奏',
      reason: '继续复习到期单词，并用场景练习检验调用能力。',
      target: 'study',
    });
  if (!strengths.length) strengths.push('学习证据正在积累，完成更多练习后会形成更稳定的趋势。');
  return {
    strengths: strengths.slice(0, 3),
    risks: risks.slice(0, 3),
    recommendations: recommendations.slice(0, 3),
  };
}
function careerHash(value: Omit<CareerStatistics, 'aiAnalysis'> | CareerStatistics) {
  const row = value as CareerStatistics;
  return createHash('sha256')
    .update(
      JSON.stringify({
        overview: row.overview,
        profile: row.profile,
        memory: row.memory,
        quality: row.quality,
        practice: row.practice,
        insights: row.insights,
      }),
    )
    .digest('hex');
}
function encodeHistoryCursor(item: LearningHistoryItem) {
  return Buffer.from(
    JSON.stringify({ id: item.id, occurredAt: item.occurredAt, kind: item.kind }),
  ).toString('base64url');
}
function decodeHistoryCursor(value: string): HistoryCursor {
  const invalid = () => new BadRequestException('学习历史游标无效，请重新加载');
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw invalid();
    const parsed = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (
      typeof parsed.id !== 'string' ||
      parsed.id.length < 1 ||
      parsed.id.length > 100 ||
      typeof parsed.occurredAt !== 'string' ||
      !['PLAN', 'ASSESSMENT', 'SCENARIO'].includes(String(parsed.kind))
    ) {
      throw invalid();
    }
    const occurredAt = new Date(parsed.occurredAt);
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== parsed.occurredAt)
      throw invalid();
    return {
      id: parsed.id,
      occurredAt,
      kind: parsed.kind as HistoryCursor['kind'],
    };
  } catch {
    throw invalid();
  }
}
function historyAfterCursor(cursor: HistoryCursor, kind: LearningHistoryItem['kind']) {
  const samePosition: Array<{ completedAt: Date | { lt: Date }; id?: string | { lt: string } }> = [
    { completedAt: { lt: cursor.occurredAt } },
    { completedAt: cursor.occurredAt, id: { lt: cursor.id } },
  ];
  if (HISTORY_KIND_RANK[kind] > HISTORY_KIND_RANK[cursor.kind]) {
    samePosition.push({ completedAt: cursor.occurredAt, id: cursor.id });
  }
  return { OR: samePosition };
}
function extractCompletion(value: unknown) {
  const content = (value as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== 'string') throw new BadGatewayException('学习分析模型没有返回有效内容');
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new BadGatewayException('学习分析模型返回的 JSON 无法解析');
  }
}
function validateAiAnalysis(value: unknown): CareerAiAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadGatewayException('学习分析结构无效');
  const row = value as Record<string, unknown>;
  const strings = (key: string) =>
    Array.isArray(row[key])
      ? (row[key] as unknown[])
          .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
          .slice(0, 3)
      : [];
  const targets = new Set(['assessment', 'review', 'mistakes', 'travel', 'study']);
  const weeklyPlan = Array.isArray(row.weeklyPlan)
    ? row.weeklyPlan
        .flatMap((item) => {
          const plan = item as Record<string, unknown>;
          return typeof plan?.action === 'string' &&
            typeof plan?.reason === 'string' &&
            targets.has(String(plan.target))
            ? [
                {
                  action: plan.action.trim(),
                  reason: plan.reason.trim(),
                  target: plan.target as CareerAiAnalysis['weeklyPlan'][number]['target'],
                },
              ]
            : [];
        })
        .slice(0, 3)
    : [];
  if (typeof row.headline !== 'string' || typeof row.summary !== 'string' || !weeklyPlan.length)
    throw new BadGatewayException('学习分析缺少必要字段');
  return {
    headline: row.headline.trim(),
    summary: row.summary.trim(),
    strengths: strings('strengths'),
    focusAreas: strings('focusAreas'),
    weeklyPlan,
  };
}
function parseStoredAnalysis(value: Prisma.JsonValue): CareerAiAnalysis | null {
  try {
    return validateAiAnalysis(value);
  } catch {
    return null;
  }
}
function safeError(error: unknown) {
  return (error instanceof Error ? error.name : 'unknown').slice(0, 120);
}
function lowerLevel(left: CefrLevel, right: CefrLevel) {
  return LEVELS[Math.min(LEVELS.indexOf(left), LEVELS.indexOf(right))];
}
function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
function validateTimeZone(timeZone: string) {
  const value = timeZone.trim() || 'UTC';
  if (value.length > 100) throw new BadRequestException('Invalid time zone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new BadRequestException('Invalid time zone');
  }
}
function dateKeyInTimeZone(formatter: Intl.DateTimeFormat, date: Date) {
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function utcDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateKey(date);
}
function localDayStart(dateKey: string, timeZone: string) {
  const wallClock = new Date(`${dateKey}T00:00:00.000Z`).getTime();
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });
  let timestamp = wallClock;
  for (let attempt = 0; attempt < 4; attempt++) {
    const offsetName = offsetFormatter
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === 'timeZoneName')?.value;
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(offsetName ?? '');
    if (!match) throw new RangeError(`Unsupported time zone offset: ${offsetName ?? 'unknown'}`);
    const minutes = match[1]
      ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1)
      : 0;
    const adjusted = wallClock - minutes * 60_000;
    if (adjusted === timestamp) break;
    timestamp = adjusted;
  }
  const start = new Date(timestamp);
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  if (dateKeyInTimeZone(dateFormatter, start) !== dateKey)
    throw new RangeError(`Could not resolve local day boundary for ${dateKey} in ${timeZone}`);
  return start;
}
function weekDayForDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return `周${'日一二三四五六'[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`;
}
function periodChart(
  activity: Array<PeriodStatistics['activity'][number] & { dateKey: string }>,
  bucketCount: number,
) {
  const bucketSize = Math.ceil(activity.length / bucketCount);
  return Array.from({ length: bucketCount }, (_, index) => {
    const offset = index * bucketSize;
    const slice = activity.slice(offset, offset + bucketSize);
    const [, month, day] = activity[offset]?.dateKey.split('-').map(Number) ?? [0, 0, 0];
    return {
      label:
        index === bucketCount - 1 ? '至今' : bucketCount === 12 ? `${month}月` : `${month}/${day}`,
      words: slice.reduce((sum, day) => sum + day.words, 0),
      completed: slice.some(isActiveDay),
      today: index === bucketCount - 1,
    };
  });
}

export { assessmentIsProvisional, careerInsights, validateAiAnalysis };
