import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiCallStatus,
  AssessmentItem,
  AssessmentItemType,
  AssessmentStatus,
  CefrLevel,
  PracticeItemType,
  Prisma,
  ProfileConfidence,
  ProfileSnapshotSource,
  ScenarioCategory,
  ScenarioOutcome,
  ScenarioSessionStatus,
  ScenarioTurnRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { CATEGORY_LABELS, LEVELS } from './travel.catalog';

type DimensionScores = {
  vocabulary: number;
  grammar: number;
  sentenceBuilding: number;
  taskCompletion: number;
  naturalness: number;
};

type TurnResult = {
  reply: string;
  taskProgress: Array<{ objective: string; completed: boolean }>;
  blockingCorrection: null | {
    issue: string;
    hint: string;
    natural: string;
    frame: string;
    explanation: string;
  };
  deferredFeedback: Array<{ type: string; original: string; natural: string; explanation: string }>;
  vocabulary: Array<{ text: string; type: 'WORD' | 'PHRASE'; meaning: string; example: string }>;
  scores: DimensionScores;
  skillCodes: string[];
  sessionShouldEnd: boolean;
};

type AssessmentEvaluation = {
  isCorrect: boolean;
  scores?: DimensionScores;
  evidence?: unknown;
  provisional: boolean;
};

@Injectable()
export class TravelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  async profile(userId: string) {
    const profile = await this.prisma.languageProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return this.publicProfile(profile);
  }

  async startAssessment(userId: string) {
    const active = await this.prisma.assessmentAttempt.findFirst({
      where: { userId, status: AssessmentStatus.IN_PROGRESS },
      orderBy: { startedAt: 'desc' },
      include: { responses: { select: { itemId: true } } },
    });
    const attempt =
      active ??
      (await this.prisma.assessmentAttempt.create({
        data: { userId },
        include: { responses: { select: { itemId: true } } },
      }));
    const next = await this.nextAssessmentItem(
      attempt.currentLevel,
      attempt.responses.map((item) => item.itemId),
    );
    return this.assessmentState(attempt, next);
  }

  async answerAssessment(userId: string, attemptId: string, itemId: string, answer: unknown) {
    const attempt = await this.prisma.assessmentAttempt.findFirst({
      where: { id: attemptId, userId },
      include: { responses: { include: { item: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!attempt) throw new NotFoundException('测评不存在');
    if (attempt.status !== AssessmentStatus.IN_PROGRESS)
      throw new BadRequestException('测评已经完成');
    const duplicate = attempt.responses.find((response) => response.itemId === itemId);
    if (duplicate) {
      const next = await this.nextAssessmentItem(
        attempt.currentLevel,
        attempt.responses.map((item) => item.itemId),
      );
      return {
        ...this.assessmentState(attempt, next),
        result: this.publicAssessmentResult(duplicate),
      };
    }
    const expected = await this.nextAssessmentItem(
      attempt.currentLevel,
      attempt.responses.map((item) => item.itemId),
    );
    if (!expected || expected.id !== itemId)
      throw new BadRequestException('题目已变化，请按当前题目继续');

    const evaluation: AssessmentEvaluation =
      expected.type === AssessmentItemType.FREE_RESPONSE
        ? await this.evaluateExpression(userId, expected, answer)
        : this.evaluateObjective(expected, answer);
    const created = await this.prisma.assessmentResponse.create({
      data: {
        attemptId,
        itemId: expected.id,
        answer: json(answer),
        isCorrect: evaluation.isCorrect,
        scores: evaluation.scores ? json(evaluation.scores) : undefined,
        evidence: evaluation.evidence ? json(evaluation.evidence) : undefined,
        provisional: evaluation.provisional,
      },
      include: { item: true },
    });
    const objectiveResponses = [...attempt.responses, created].filter(
      (response) => response.item.type !== AssessmentItemType.FREE_RESPONSE,
    );
    const currentLevel =
      objectiveResponses.length > 0 && objectiveResponses.length % 4 === 0
        ? adaptLevel(
            attempt.currentLevel,
            objectiveResponses.slice(-4).filter((item) => item.isCorrect).length / 4,
          )
        : attempt.currentLevel;
    const updated = await this.prisma.assessmentAttempt.update({
      where: { id: attemptId },
      data: { itemCount: { increment: 1 }, currentLevel },
      include: { responses: { select: { itemId: true } } },
    });
    const next = await this.nextAssessmentItem(
      currentLevel,
      updated.responses.map((item) => item.itemId),
    );
    return { ...this.assessmentState(updated, next), result: this.publicAssessmentResult(created) };
  }

  async completeAssessment(userId: string, attemptId: string) {
    const attempt = await this.prisma.assessmentAttempt.findFirst({
      where: { id: attemptId, userId },
      include: { responses: { include: { item: true } } },
    });
    if (!attempt) throw new NotFoundException('测评不存在');
    if (attempt.status === AssessmentStatus.COMPLETED) return this.profile(userId);
    const total = await this.prisma.assessmentItem.count({
      where: { version: attempt.version, isActive: true },
    });
    if (attempt.responses.length < total)
      throw new BadRequestException(`还有 ${total - attempt.responses.length} 道题未完成`);

    const objective = attempt.responses.filter(
      (item) => item.item.type !== AssessmentItemType.FREE_RESPONSE,
    );
    const expressions = attempt.responses.filter(
      (item) => item.item.type === AssessmentItemType.FREE_RESPONSE,
    );
    const objectiveLevel = highestPassedObjectiveLevel(objective);
    const expressionLevel = expressionEvidenceLevel(expressions);
    const overallLevel =
      LEVELS[Math.min(LEVELS.indexOf(objectiveLevel), LEVELS.indexOf(expressionLevel))];
    const difference = Math.abs(LEVELS.indexOf(objectiveLevel) - LEVELS.indexOf(expressionLevel));
    const provisional = expressions.some((item) => item.provisional);
    const confidence =
      attempt.responses.length >= 20 && difference === 0 && !provisional
        ? ProfileConfidence.HIGH
        : attempt.responses.length >= 16 && difference <= 1
          ? ProfileConfidence.MEDIUM
          : ProfileConfidence.LOW;
    const dimensions = assessmentDimensions(attempt.responses);
    const now = new Date();
    const profile = await this.prisma.$transaction(async (tx) => {
      await tx.assessmentAttempt.update({
        where: { id: attemptId },
        data: {
          status: AssessmentStatus.COMPLETED,
          completedAt: now,
          objectiveLevel,
          expressionLevel,
          confidence,
        },
      });
      const updatedProfile = await tx.languageProfile.upsert({
        where: { userId },
        create: {
          userId,
          overallLevel,
          confidence,
          ...profileFields(dimensions),
          provisional: provisional || confidence === ProfileConfidence.LOW,
          assessedAt: now,
        },
        update: {
          overallLevel,
          confidence,
          ...profileFields(dimensions),
          provisional: provisional || confidence === ProfileConfidence.LOW,
          assessedAt: now,
        },
      });
      await tx.languageProfileSnapshot.upsert({
        where: {
          userId_source_sourceId: {
            userId,
            source: ProfileSnapshotSource.ASSESSMENT,
            sourceId: attemptId,
          },
        },
        create: {
          userId,
          source: ProfileSnapshotSource.ASSESSMENT,
          sourceId: attemptId,
          overallLevel,
          confidence,
          ...profileFields(dimensions),
          provisional: updatedProfile.provisional,
          recordedAt: now,
        },
        update: {
          overallLevel,
          confidence,
          ...profileFields(dimensions),
          provisional: updatedProfile.provisional,
          recordedAt: now,
        },
      });
      return updatedProfile;
    });
    return this.publicProfile(profile);
  }

  async listScenarios(userId: string, category?: ScenarioCategory) {
    const [templates, completed] = await Promise.all([
      this.prisma.scenarioTemplate.findMany({
        where: { isActive: true, ...(category ? { category } : {}) },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
      }),
      this.prisma.scenarioSession.findMany({
        where: { userId, status: ScenarioSessionStatus.COMPLETED },
        select: { templateId: true, report: { select: { outcome: true } }, completedAt: true },
      }),
    ]);
    return templates.map((template) => {
      const history = completed.filter((item) => item.templateId === template.id);
      return {
        ...this.publicTemplate(template),
        completedCount: history.length,
        lastCompletedAt:
          history.sort((a, b) => Number(b.completedAt) - Number(a.completedAt))[0]?.completedAt ??
          null,
        bestOutcome: history.some((item) => item.report?.outcome === ScenarioOutcome.SUCCESS)
          ? 'SUCCESS'
          : (history[0]?.report?.outcome ?? null),
      };
    });
  }

  async resumableScenario(userId: string) {
    const session = await this.prisma.scenarioSession.findFirst({
      where: { userId, status: ScenarioSessionStatus.ACTIVE },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: { template: true, turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return null;

    const repliedTo = new Set(
      session.turns
        .filter((turn) => turn.role === ScenarioTurnRole.ASSISTANT && turn.replyToTurnId)
        .map((turn) => turn.replyToTurnId),
    );
    const pendingTurn = [...session.turns]
      .reverse()
      .find((turn) => turn.role === ScenarioTurnRole.USER && !repliedTo.has(turn.id));

    return {
      session: this.publicSession(session),
      template: this.publicTemplate(session.template),
      turns: session.turns.map((turn) => this.publicTurn(turn)),
      pendingRetry:
        pendingTurn?.clientMessageId && pendingTurn.content
          ? { clientMessageId: pendingTurn.clientMessageId, content: pendingTurn.content }
          : null,
    };
  }

  async latestScenarioReport(userId: string) {
    const session = await this.prisma.scenarioSession.findFirst({
      where: {
        userId,
        status: ScenarioSessionStatus.COMPLETED,
        completedAt: { not: null },
        report: { isNot: null },
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      include: { template: true, report: true },
    });
    if (!session?.report || !session.completedAt) return null;

    return {
      session: this.publicSession(session),
      completedAt: session.completedAt,
      template: this.publicTemplate(session.template),
      report: this.publicReport(session.report),
    };
  }

  async startScenario(userId: string, templateId: string) {
    const template = await this.prisma.scenarioTemplate.findFirst({
      where: { id: templateId, isActive: true },
    });
    if (!template) throw new NotFoundException('场景不存在或暂不可用');
    const profile = await this.prisma.languageProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const level = profile.provisional
      ? await this.calibratedScenarioLevel(userId, profile.overallLevel)
      : profile.overallLevel;
    const session = await this.prisma.scenarioSession.create({
      data: {
        userId,
        templateId,
        level,
        objectivesProgress: json(
          asStringArray(template.objectives).map((objective) => ({ objective, completed: false })),
        ),
      },
    });
    const opening = openingFor(template.category);
    const assistant = await this.prisma.scenarioTurn.create({
      data: { sessionId: session.id, role: ScenarioTurnRole.ASSISTANT, content: opening },
    });
    return {
      session: this.publicSession(session),
      template: this.publicTemplate(template),
      turns: [this.publicTurn(assistant)],
      opening,
    };
  }

  async takeTurn(userId: string, sessionId: string, message: string, clientMessageId: string) {
    const initial = await this.prisma.scenarioSession.findFirst({
      where: { id: sessionId, userId },
      include: { template: true, turns: { orderBy: { createdAt: 'asc' } } },
    });
    if (!initial) throw new NotFoundException('场景会话不存在');
    if (initial.status !== ScenarioSessionStatus.ACTIVE)
      throw new BadRequestException('场景会话已经结束');
    if (initial.turnCount >= initial.template.maxTurns)
      throw new BadRequestException('本场景已达到最大对话轮数，请完成复盘');

    const userTurn = await this.prisma.scenarioTurn.upsert({
      where: { sessionId_clientMessageId: { sessionId, clientMessageId } },
      create: { sessionId, clientMessageId, role: ScenarioTurnRole.USER, content: message },
      update: {},
    });
    if (userTurn.role !== ScenarioTurnRole.USER || userTurn.content !== message)
      throw new BadRequestException('消息 ID 已用于其他内容');
    const completedReply = await this.prisma.scenarioTurn.findUnique({
      where: { replyToTurnId: userTurn.id },
    });
    if (completedReply)
      return {
        turn: this.publicTurn(completedReply),
        evaluation: completedReply.evaluation,
        session: this.publicSession(initial),
      };

    const claimedAt = new Date();
    const staleBefore = new Date(claimedAt.getTime() - 2 * 60_000);
    const claim = await this.prisma.scenarioSession.updateMany({
      where: {
        id: sessionId,
        userId,
        status: ScenarioSessionStatus.ACTIVE,
        turnCount: { lt: initial.template.maxTurns },
        OR: [{ processingMessageId: null }, { processingStartedAt: { lt: staleBefore } }],
      },
      data: { processingMessageId: clientMessageId, processingStartedAt: claimedAt },
    });
    if (!claim.count) {
      const current = await this.prisma.scenarioSession.findFirst({
        where: { id: sessionId, userId },
        include: { template: true },
      });
      if (!current || current.status !== ScenarioSessionStatus.ACTIVE)
        throw new BadRequestException('场景会话已经结束');
      if (current.turnCount >= current.template.maxTurns)
        throw new BadRequestException('本场景已达到最大对话轮数，请完成复盘');
      throw new ConflictException('上一条场景回复仍在处理中，请稍后使用同一消息重试');
    }

    let quota: { usageDate: Date } | undefined;
    try {
      const session = await this.prisma.scenarioSession.findFirstOrThrow({
        where: { id: sessionId, userId, processingMessageId: clientMessageId },
        include: { template: true, turns: { orderBy: { createdAt: 'asc' } } },
      });
      const history = session.turns
        .slice(-16)
        .map((turn) => ({ role: turn.role.toLowerCase(), content: turn.content }));
      const prompt = scenarioPrompt(
        session.template,
        session.level,
        history,
        session.turnCount + 1,
        session.objectivesProgress,
      );
      quota = await this.reserveScenarioQuota(userId);
      const result = await this.callTurnModel(userId, prompt);
      result.taskProgress = mergeProgress(
        asStringArray(session.template.objectives),
        asProgress(session.objectivesProgress),
        result.taskProgress,
      );
      const assistant = await this.prisma.$transaction(async (tx) => {
        const created = await tx.scenarioTurn.create({
          data: {
            sessionId,
            replyToTurnId: userTurn.id,
            role: ScenarioTurnRole.ASSISTANT,
            content: result.reply,
            evaluation: json(result),
          },
        });
        const updated = await tx.scenarioSession.updateMany({
          where: { id: sessionId, processingMessageId: clientMessageId },
          data: {
            turnCount: { increment: 1 },
            objectivesProgress: json(result.taskProgress),
            deferredFeedback: json(result.deferredFeedback),
            processingMessageId: null,
            processingStartedAt: null,
          },
        });
        if (!updated.count) throw new ConflictException('场景回合状态已经变化，请重试');
        return created;
      });
      const updatedSession = await this.prisma.scenarioSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      return {
        turn: this.publicTurn(assistant),
        evaluation: result,
        session: this.publicSession(updatedSession),
      };
    } catch (error) {
      if (quota) await this.refundScenarioQuota(userId, quota.usageDate);
      await this.releaseTurnClaim(sessionId, clientMessageId);
      const completed = await this.prisma.scenarioTurn.findUnique({
        where: { replyToTurnId: userTurn.id },
      });
      if (completed) {
        const current = await this.prisma.scenarioSession.findUniqueOrThrow({
          where: { id: sessionId },
        });
        return {
          turn: this.publicTurn(completed),
          evaluation: completed.evaluation,
          session: this.publicSession(current),
        };
      }
      throw error;
    }
  }

  async completeScenario(userId: string, sessionId: string) {
    const session = await this.prisma.scenarioSession.findFirst({
      where: { id: sessionId, userId },
      include: { template: true, turns: { orderBy: { createdAt: 'asc' } }, report: true },
    });
    if (!session) throw new NotFoundException('场景会话不存在');
    if (session.report) return this.publicReport(session.report);
    const evaluations = session.turns
      .map((turn) => turn.evaluation)
      .filter(Boolean)
      .map((value) => value as unknown as TurnResult);
    const progress = mergeProgress(
      asStringArray(session.template.objectives),
      asProgress(session.objectivesProgress),
      [],
    );
    const completedGoals = progress.filter((item) => item.completed).length;
    const outcome =
      completedGoals === progress.length && session.turnCount >= session.template.minTurns
        ? ScenarioOutcome.SUCCESS
        : completedGoals > 0
          ? ScenarioOutcome.PARTIAL
          : ScenarioOutcome.INCOMPLETE;
    const dimensions = averageDimensions(evaluations.map((item) => item.scores));
    const rewrites = evaluations
      .flatMap((item) => [
        ...(item.blockingCorrection
          ? [
              {
                type: 'blocking',
                original: item.blockingCorrection.issue,
                natural: item.blockingCorrection.natural,
                explanation: item.blockingCorrection.explanation,
              },
            ]
          : []),
        ...item.deferredFeedback,
      ])
      .slice(0, 8);
    const vocabulary = uniqueVocabulary(evaluations.flatMap((item) => item.vocabulary)).slice(0, 8);
    const recommendation =
      outcome === ScenarioOutcome.SUCCESS
        ? '换一个相近情境再说一遍，把表达变成可以随时调用的习惯。'
        : '先复习本页的句子骨架，再重新挑战这个场景。';
    const skillCode = skillForCategory(session.template.category);
    const skill = await this.prisma.languageSkill.findUnique({ where: { code: skillCode } });
    const profileSnapshot = await this.prisma.languageProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const promotionTarget = nextLevel(profileSnapshot.overallLevel);
    const promotionEvidence =
      profileSnapshot.provisional &&
      promotionTarget !== profileSnapshot.overallLevel &&
      session.level === promotionTarget &&
      isStrongScenario(outcome, dimensions)
        ? await this.countStrongScenarios(userId, promotionTarget)
        : 0;
    const promotedLevel = promotionEvidence >= 2 ? promotionTarget : profileSnapshot.overallLevel;
    const today = this.usageDate();
    try {
      const report = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.scenarioSession.updateMany({
          where: { id: sessionId, status: ScenarioSessionStatus.ACTIVE, processingMessageId: null },
          data: { status: ScenarioSessionStatus.COMPLETED, completedAt: new Date() },
        });
        if (!claimed.count) throw new ConflictException('场景正在结算');
        const created = await tx.scenarioReport.create({
          data: {
            sessionId,
            outcome,
            dimensionScores: json(dimensions),
            rewrites: json(rewrites),
            grammarFrames: json(session.template.grammarFrames),
            evidence: json(progress),
            vocabulary: json(vocabulary),
            recommendation,
          },
        });
        if (evaluations.length) {
          const profile = await tx.languageProfile.upsert({
            where: { userId },
            create: { userId },
            update: {},
          });
          const updatedProfile = await tx.languageProfile.update({
            where: { userId },
            data: {
              overallLevel: promotedLevel,
              vocabularyScore: blend(profile.vocabularyScore, dimensions.vocabulary),
              grammarScore: blend(profile.grammarScore, dimensions.grammar),
              sentenceBuildingScore: blend(
                profile.sentenceBuildingScore,
                dimensions.sentenceBuilding,
              ),
              taskCompletionScore: blend(profile.taskCompletionScore, dimensions.taskCompletion),
              naturalnessScore: blend(profile.naturalnessScore, dimensions.naturalness),
            },
          });
          await tx.languageProfileSnapshot.upsert({
            where: {
              userId_source_sourceId: {
                userId,
                source: ProfileSnapshotSource.SCENARIO,
                sourceId: sessionId,
              },
            },
            create: {
              userId,
              source: ProfileSnapshotSource.SCENARIO,
              sourceId: sessionId,
              overallLevel: updatedProfile.overallLevel,
              confidence: updatedProfile.confidence,
              ...profileSnapshotFields(updatedProfile),
              provisional: updatedProfile.provisional,
              recordedAt: new Date(),
            },
            update: {
              overallLevel: updatedProfile.overallLevel,
              confidence: updatedProfile.confidence,
              ...profileSnapshotFields(updatedProfile),
              provisional: updatedProfile.provisional,
            },
          });
        }
        if (skill && evaluations.length) {
          await tx.userSkillProgress.upsert({
            where: { userId_skillId: { userId, skillId: skill.id } },
            create: {
              userId,
              skillId: skill.id,
              score: dimensions.taskCompletion,
              evidenceCount: 1,
              consecutivePass: dimensions.taskCompletion >= 70 ? 1 : 0,
              lastPracticedAt: new Date(),
            },
            update: {
              score: dimensions.taskCompletion,
              evidenceCount: { increment: 1 },
              consecutivePass: dimensions.taskCompletion >= 70 ? { increment: 1 } : 0,
              lastPracticedAt: new Date(),
            },
          });
        }
        await tx.dailyPracticePlanItem.updateMany({
          where: {
            scenarioTemplateId: session.templateId,
            completedAt: null,
            plan: { userId, planDate: today },
          },
          data: { completedAt: new Date() },
        });
        return created;
      });
      return this.publicReport(report);
    } catch (error) {
      const existing = await this.prisma.scenarioReport.findUnique({ where: { sessionId } });
      if (existing) return this.publicReport(existing);
      throw error;
    }
  }

  async todayPlan(userId: string) {
    const planDate = this.usageDate();
    const existing = await this.prisma.dailyPracticePlan.findUnique({
      where: { userId_planDate: { userId, planDate } },
      include: { items: { include: { scenarioTemplate: true }, orderBy: { position: 'asc' } } },
    });
    if (existing) return this.publicPlan(existing);
    const [templates, completed, weakestSkill] = await Promise.all([
      this.prisma.scenarioTemplate.findMany({
        where: { isActive: true },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
      }),
      this.prisma.scenarioSession.findMany({
        where: { userId, status: ScenarioSessionStatus.COMPLETED },
        select: { templateId: true, completedAt: true },
        orderBy: { completedAt: 'asc' },
      }),
      this.prisma.userSkillProgress.findFirst({
        where: { userId },
        orderBy: [{ score: 'asc' }, { lastPracticedAt: 'asc' }],
        include: { skill: true },
      }),
    ]);
    if (!templates.length) throw new NotFoundException('旅行场景尚未初始化');
    const completedIds = new Set(completed.map((item) => item.templateId));
    const useReview = completed.length > 0 && new Date().getDate() % 10 >= 7;
    const selected =
      (useReview
        ? templates.find((item) => completedIds.has(item.id))
        : templates.find((item) => !completedIds.has(item.id))) ?? templates[0];
    try {
      const plan = await this.prisma.dailyPracticePlan.create({
        data: {
          userId,
          planDate,
          items: {
            create: [
              {
                type: PracticeItemType.EXPRESSION_REVIEW,
                position: 1,
                minutes: 3,
                title: '热身：救命表达',
                reason: weakestSkill
                  ? `先巩固「${weakestSkill.skill.title}」`
                  : '先准备本场景最常用的表达',
              },
              {
                type: PracticeItemType.SCENARIO,
                position: 2,
                minutes: 8,
                title: selected.title,
                reason: useReview
                  ? '换一个变化重新表达'
                  : `继续完成${CATEGORY_LABELS[selected.category]}核心场景`,
                scenarioTemplateId: selected.id,
              },
              {
                type: PracticeItemType.GRAMMAR_REVIEW,
                position: 3,
                minutes: 4,
                title: '复盘：重说一句',
                reason: '把今天的错误改成自然表达',
              },
            ],
          },
        },
        include: { items: { include: { scenarioTemplate: true }, orderBy: { position: 'asc' } } },
      });
      return this.publicPlan(plan);
    } catch {
      const plan = await this.prisma.dailyPracticePlan.findUniqueOrThrow({
        where: { userId_planDate: { userId, planDate } },
        include: { items: { include: { scenarioTemplate: true }, orderBy: { position: 'asc' } } },
      });
      return this.publicPlan(plan);
    }
  }

  async clearRecords(userId: string) {
    const [plans, sessions, assessments, skills, profiles, usages, snapshots, analysisCache] =
      await this.prisma.$transaction([
        this.prisma.dailyPracticePlan.deleteMany({ where: { userId } }),
        this.prisma.scenarioSession.deleteMany({ where: { userId } }),
        this.prisma.assessmentAttempt.deleteMany({ where: { userId } }),
        this.prisma.userSkillProgress.deleteMany({ where: { userId } }),
        this.prisma.languageProfile.deleteMany({ where: { userId } }),
        this.prisma.scenarioDailyUsage.deleteMany({ where: { userId } }),
        this.prisma.languageProfileSnapshot.deleteMany({ where: { userId } }),
        this.prisma.learningAnalysisCache.deleteMany({ where: { userId } }),
      ]);
    return {
      success: true,
      cleared: {
        plans: plans.count,
        sessions: sessions.count,
        assessments: assessments.count,
        skills: skills.count,
        profiles: profiles.count,
        usages: usages.count,
        snapshots: snapshots.count,
        analysisCache: analysisCache.count,
      },
    };
  }

  private async reserveScenarioQuota(userId: string) {
    const usageDate = this.usageDate();
    const limit = Math.max(1, Number(this.config.get('TRAVEL_SCENARIO_DAILY_LIMIT') ?? 40));
    const usage = await this.prisma.$transaction(async (tx) => {
      await tx.scenarioDailyUsage.upsert({
        where: { userId_usageDate: { userId, usageDate } },
        create: { userId, usageDate },
        update: {},
      });
      const updated = await tx.scenarioDailyUsage.updateMany({
        where: { userId, usageDate, count: { lt: limit } },
        data: { count: { increment: 1 } },
      });
      if (!updated.count) return null;
      return tx.scenarioDailyUsage.findUniqueOrThrow({
        where: { userId_usageDate: { userId, usageDate } },
      });
    });
    if (!usage)
      throw new HttpException(
        `今天的 ${limit} 个场景回合已经完成，明天再继续吧`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    return { usageDate, remaining: Math.max(0, limit - usage.count) };
  }

  private refundScenarioQuota(userId: string, usageDate: Date) {
    return this.prisma.scenarioDailyUsage.updateMany({
      where: { userId, usageDate, count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  }

  private releaseTurnClaim(sessionId: string, clientMessageId: string) {
    return this.prisma.scenarioSession.updateMany({
      where: { id: sessionId, processingMessageId: clientMessageId },
      data: { processingMessageId: null, processingStartedAt: null },
    });
  }

  private async calibratedScenarioLevel(userId: string, currentLevel: CefrLevel) {
    const target = nextLevel(currentLevel);
    if (target === currentLevel) return currentLevel;
    return (await this.countStrongScenarios(userId, currentLevel)) >= 2 ? target : currentLevel;
  }

  private async countStrongScenarios(userId: string, level: CefrLevel) {
    const sessions = await this.prisma.scenarioSession.findMany({
      where: { userId, level, status: ScenarioSessionStatus.COMPLETED, report: { isNot: null } },
      select: { report: { select: { outcome: true, dimensionScores: true } } },
    });
    return sessions.filter(
      (item) =>
        item.report &&
        isStrongScenario(item.report.outcome, normalizeScores(item.report.dimensionScores)),
    ).length;
  }

  private usageDate() {
    const timezone = this.config.get<string>('APP_TIMEZONE') ?? 'Asia/Shanghai';
    const value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return new Date(`${value}T00:00:00.000Z`);
  }

  private async nextAssessmentItem(level: CefrLevel, answered: string[]) {
    const remaining = await this.prisma.assessmentItem.findMany({
      where: { version: 1, isActive: true, id: { notIn: answered } },
      orderBy: { displayOrder: 'asc' },
    });
    const objective = remaining.filter((item) => item.type !== AssessmentItemType.FREE_RESPONSE);
    if (objective.length)
      return objective.sort(
        (a, b) =>
          levelDistance(a.level, level) - levelDistance(b.level, level) ||
          a.displayOrder - b.displayOrder,
      )[0];
    return remaining[0] ?? null;
  }

  private assessmentState(
    attempt: { id: string; status: AssessmentStatus; itemCount: number; currentLevel: CefrLevel },
    item: AssessmentItem | null,
  ) {
    return {
      id: attempt.id,
      status: attempt.status,
      answered: attempt.itemCount,
      total: 22,
      estimatedMinutes: Math.max(1, Math.ceil((22 - attempt.itemCount) * 0.45)),
      currentLevel: attempt.currentLevel,
      nextItem: item ? publicAssessmentItem(item, attempt.itemCount + 1) : null,
    };
  }

  private evaluateObjective(item: AssessmentItem, answer: unknown) {
    const selected = Array.isArray(answer) ? answer.map(String) : [String(answer ?? '')];
    const expected = asStringArray(item.correctAnswers).sort();
    const actual = selected.sort();
    return {
      isCorrect:
        expected.length === actual.length &&
        expected.every((value, index) => value === actual[index]),
      provisional: false,
      evidence: { expected },
    };
  }

  private async evaluateExpression(userId: string, item: AssessmentItem, answer: unknown) {
    const text = String(answer ?? '').trim();
    if (text.length < 3)
      return {
        isCorrect: false,
        scores: zeroScores(),
        evidence: { note: '回答过短，无法证明场景表达能力' },
        provisional: true,
      };
    const prompt = `评估下面的旅行英语文字回答。不要评估发音、听力或真实口语流利度。按 0-100 返回五个分数，并给出简短中文证据。自然口语中的缩写、省略和短句只要清楚得体就不要扣分。\n题目：${item.prompt}\n评分目标：${JSON.stringify(item.rubric)}\n用户回答：${text}\n只返回 JSON：{"scores":{"vocabulary":0,"grammar":0,"sentenceBuilding":0,"taskCompletion":0,"naturalness":0},"evidence":["..."],"estimatedLevel":"A1|A2|B1|B2|C1"}`;
    try {
      const { scores, evidence } = await this.callAssessmentModel(userId, prompt);
      return {
        isCorrect: scores.taskCompletion >= 60,
        scores,
        evidence: { items: evidence },
        provisional: false,
      };
    } catch {
      const scores = heuristicExpression(text);
      return {
        isCorrect: scores.taskCompletion >= 60,
        scores,
        evidence: { note: 'AI 评分暂不可用，当前为基于回答完整度的临时结果' },
        provisional: true,
      };
    }
  }

  private async callTurnModel(userId: string, prompt: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await this.callStructured(userId, 'travel-scenario-turn', prompt);
        return normalizeTurn(value);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BadGatewayException('场景助手没有返回可用内容');
  }

  private async callAssessmentModel(userId: string, prompt: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return normalizeAssessmentEvaluation(
          await this.callStructured(userId, 'travel-assessment', prompt),
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BadGatewayException('测评模型没有返回可用内容');
  }

  private async callStructured(userId: string, purpose: string, prompt: string) {
    const audit = await this.prisma.aiCallAudit.create({
      data: { userId, purpose, promptVersion: 'travel-v1', status: AiCallStatus.PENDING },
    });
    const startedAt = Date.now();
    try {
      const response = await this.ai.generateForUser({ purpose, prompt }, userId);
      const value = parseCompletionJson(response);
      await this.prisma.aiCallAudit.update({
        where: { id: audit.id },
        data: {
          status: AiCallStatus.SUCCEEDED,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
      return value;
    } catch (error) {
      await this.prisma.aiCallAudit.update({
        where: { id: audit.id },
        data: {
          status: AiCallStatus.FAILED,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
          errorCode: safeErrorCode(error),
        },
      });
      throw error;
    }
  }

  private publicProfile(profile: {
    overallLevel: CefrLevel;
    confidence: ProfileConfidence;
    vocabularyScore: number;
    grammarScore: number;
    sentenceBuildingScore: number;
    taskCompletionScore: number;
    naturalnessScore: number;
    pronunciationScore: number | null;
    listeningScore: number | null;
    fluencyScore: number | null;
    provisional: boolean;
    assessedAt: Date | null;
  }) {
    return {
      overallLevel: profile.overallLevel,
      confidence: profile.confidence,
      provisional: profile.provisional,
      assessedAt: profile.assessedAt,
      dimensions: {
        vocabulary: profile.vocabularyScore,
        grammar: profile.grammarScore,
        sentenceBuilding: profile.sentenceBuildingScore,
        taskCompletion: profile.taskCompletionScore,
        naturalness: profile.naturalnessScore,
        pronunciation: profile.pronunciationScore,
        listening: profile.listeningScore,
        fluency: profile.fluencyScore,
      },
    };
  }

  private publicTemplate(template: {
    id: string;
    slug: string;
    category: ScenarioCategory;
    title: string;
    description: string;
    userRole: string;
    aiRole: string;
    minTurns: number;
    maxTurns: number;
    objectives: Prisma.JsonValue;
    starterPhrases: Prisma.JsonValue;
    grammarFrames: Prisma.JsonValue;
    difficultyVariants: Prisma.JsonValue;
  }) {
    return {
      id: template.id,
      slug: template.slug,
      category: template.category,
      categoryLabel: CATEGORY_LABELS[template.category],
      title: template.title,
      description: template.description,
      userRole: template.userRole,
      aiRole: template.aiRole,
      minTurns: template.minTurns,
      maxTurns: template.maxTurns,
      objectives: template.objectives,
      starterPhrases: template.starterPhrases,
      grammarFrames: template.grammarFrames,
      difficultyVariants: template.difficultyVariants,
    };
  }

  private publicSession(session: {
    id: string;
    templateId: string;
    level: CefrLevel;
    status: ScenarioSessionStatus;
    turnCount: number;
    startedAt: Date;
  }) {
    return {
      id: session.id,
      templateId: session.templateId,
      level: session.level,
      status: session.status,
      turnCount: session.turnCount,
      startedAt: session.startedAt,
    };
  }
  private publicTurn(turn: {
    id: string;
    role: ScenarioTurnRole;
    content: string;
    evaluation: Prisma.JsonValue | null;
    createdAt: Date;
  }) {
    return {
      id: turn.id,
      role: turn.role.toLowerCase(),
      content: turn.content,
      evaluation: turn.evaluation,
      createdAt: turn.createdAt,
    };
  }
  private publicAssessmentResult(response: {
    isCorrect: boolean | null;
    scores: Prisma.JsonValue | null;
    evidence: Prisma.JsonValue | null;
    provisional: boolean;
    item: { explanation: string | null };
  }) {
    return {
      isCorrect: response.isCorrect,
      scores: response.scores,
      evidence: response.evidence,
      explanation: response.item.explanation,
      provisional: response.provisional,
    };
  }
  private publicReport(report: {
    outcome: ScenarioOutcome;
    dimensionScores: Prisma.JsonValue;
    rewrites: Prisma.JsonValue;
    grammarFrames: Prisma.JsonValue;
    evidence: Prisma.JsonValue;
    vocabulary: Prisma.JsonValue;
    recommendation: string;
    createdAt: Date;
  }) {
    return {
      outcome: report.outcome,
      dimensions: report.dimensionScores,
      rewrites: report.rewrites,
      grammarFrames: report.grammarFrames,
      evidence: report.evidence,
      vocabulary: report.vocabulary,
      recommendation: report.recommendation,
      createdAt: report.createdAt,
    };
  }
  private publicPlan(plan: {
    id: string;
    planDate: Date;
    totalMinutes: number;
    items: Array<{
      id: string;
      type: PracticeItemType;
      position: number;
      minutes: number;
      title: string;
      reason: string;
      completedAt: Date | null;
      scenarioTemplate: Parameters<TravelService['publicTemplate']>[0] | null;
    }>;
  }) {
    return {
      id: plan.id,
      date: plan.planDate,
      totalMinutes: plan.totalMinutes,
      items: plan.items.map((item) => ({
        id: item.id,
        type: item.type,
        position: item.position,
        minutes: item.minutes,
        title: item.title,
        reason: item.reason,
        completedAt: item.completedAt,
        scenario: item.scenarioTemplate ? this.publicTemplate(item.scenarioTemplate) : null,
      })),
    };
  }
}

function publicAssessmentItem(item: AssessmentItem, ordinal: number) {
  return {
    id: item.id,
    type: item.type,
    level: item.level,
    dimension: item.dimension,
    scenario: item.scenario,
    prompt: item.prompt,
    options: item.options,
    ordinal,
  };
}
export function adaptLevel(level: CefrLevel, rate: number) {
  const index = LEVELS.indexOf(level);
  return LEVELS[
    Math.max(0, Math.min(LEVELS.length - 1, index + (rate >= 0.75 ? 1 : rate <= 0.25 ? -1 : 0)))
  ];
}
function levelDistance(left: CefrLevel, right: CefrLevel) {
  return Math.abs(LEVELS.indexOf(left) - LEVELS.indexOf(right));
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
function asProgress(value: unknown): Array<{ objective: string; completed: boolean }> {
  return Array.isArray(value)
    ? value
        .map((item) => ({
          objective: String((item as { objective?: unknown })?.objective ?? ''),
          completed: Boolean((item as { completed?: unknown })?.completed),
        }))
        .filter((item) => item.objective)
    : [];
}
export function mergeProgress(
  objectives: string[],
  previous: Array<{ objective: string; completed: boolean }>,
  current: Array<{ objective: string; completed: boolean }>,
) {
  return objectives.map((objective) => ({
    objective,
    completed: Boolean(
      previous.find((item) => item.objective === objective)?.completed ||
      current.find((item) => item.objective === objective)?.completed,
    ),
  }));
}
function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}
function zeroScores(): DimensionScores {
  return { vocabulary: 0, grammar: 0, sentenceBuilding: 0, taskCompletion: 0, naturalness: 0 };
}
function normalizeScores(value: unknown): DimensionScores {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const score = (key: string) => Math.round(Math.max(0, Math.min(100, Number(record[key]) || 0)));
  return {
    vocabulary: score('vocabulary'),
    grammar: score('grammar'),
    sentenceBuilding: score('sentenceBuilding'),
    taskCompletion: score('taskCompletion'),
    naturalness: score('naturalness'),
  };
}
function strictScores(value: unknown): DimensionScores {
  const record = requiredObject(value, 'scores');
  const score = (key: keyof DimensionScores) => {
    const current = record[key];
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0 || current > 100)
      invalidModelField(`scores.${key}`);
    return Math.round(current as number);
  };
  return {
    vocabulary: score('vocabulary'),
    grammar: score('grammar'),
    sentenceBuilding: score('sentenceBuilding'),
    taskCompletion: score('taskCompletion'),
    naturalness: score('naturalness'),
  };
}
function normalizeAssessmentEvaluation(value: unknown) {
  const record = requiredObject(value, '测评评分');
  const evidence = requiredArray(record.evidence, 'evidence')
    .slice(0, 5)
    .map((item, index) => requiredString(item, `evidence[${index}]`));
  if (!LEVELS.includes(record.estimatedLevel as CefrLevel)) invalidModelField('estimatedLevel');
  return {
    scores: strictScores(record.scores),
    evidence,
    estimatedLevel: record.estimatedLevel as CefrLevel,
  };
}
function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidModelField(field);
  return value as Record<string, unknown>;
}
function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalidModelField(field);
  return value as unknown[];
}
function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) invalidModelField(field);
  return value.trim();
}
function invalidModelField(field: string): never {
  throw new BadGatewayException(`模型响应字段无效：${field}`);
}
function scoreRecord(value: unknown) {
  return normalizeScores(value);
}
function weightedScore(scores: DimensionScores) {
  return (
    scores.vocabulary * 0.25 +
    scores.grammar * 0.25 +
    scores.sentenceBuilding * 0.2 +
    scores.taskCompletion * 0.2 +
    scores.naturalness * 0.1
  );
}
function average(values: number[]) {
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : 0;
}
function scoreLevel(score: number): CefrLevel {
  return score >= 85
    ? CefrLevel.C1
    : score >= 75
      ? CefrLevel.B2
      : score >= 60
        ? CefrLevel.B1
        : score >= 40
          ? CefrLevel.A2
          : CefrLevel.A1;
}
export function expressionEvidenceLevel(
  responses: Array<{ isCorrect: boolean | null; scores: unknown }>,
) {
  if (!responses.some((item) => item.isCorrect)) return CefrLevel.A1;
  return scoreLevel(average(responses.map((item) => weightedScore(scoreRecord(item.scores)))));
}
export function highestPassedObjectiveLevel(
  responses: Array<{ isCorrect: boolean | null; item: { level: CefrLevel; dimension?: string } }>,
) {
  let achieved: CefrLevel = CefrLevel.A1;
  for (const level of LEVELS) {
    const items = responses.filter((item) => item.item.level === level);
    const rate = items.length ? items.filter((item) => item.isCorrect).length / items.length : 0;
    const requiredDimensions = ['vocabulary', 'grammar'];
    const passesFoundations = requiredDimensions.every((dimension) =>
      items.some((item) => item.item.dimension === dimension && item.isCorrect),
    );
    if (rate < 0.75 || !passesFoundations) break;
    achieved = level;
  }
  return achieved;
}
function assessmentDimensions(
  responses: Array<{
    isCorrect: boolean | null;
    scores: Prisma.JsonValue | null;
    item: { dimension: string; type: AssessmentItemType };
  }>,
): DimensionScores {
  const keys: Array<keyof DimensionScores> = [
    'vocabulary',
    'grammar',
    'sentenceBuilding',
    'taskCompletion',
    'naturalness',
  ];
  const values = zeroScores();
  for (const key of keys) {
    const objective = responses.filter(
      (item) => item.item.type !== AssessmentItemType.FREE_RESPONSE && item.item.dimension === key,
    );
    const expression = responses
      .filter((item) => item.item.type === AssessmentItemType.FREE_RESPONSE)
      .map((item) => normalizeScores(item.scores)[key]);
    const objectiveScore = objective.length
      ? (objective.filter((item) => item.isCorrect).length / objective.length) * 100
      : null;
    values[key] = Math.round(
      objectiveScore === null
        ? average(expression)
        : expression.length
          ? objectiveScore * 0.7 + average(expression) * 0.3
          : objectiveScore,
    );
  }
  return values;
}
function profileFields(scores: DimensionScores) {
  return {
    vocabularyScore: scores.vocabulary,
    grammarScore: scores.grammar,
    sentenceBuildingScore: scores.sentenceBuilding,
    taskCompletionScore: scores.taskCompletion,
    naturalnessScore: scores.naturalness,
  };
}
export function profileSnapshotFields(profile: {
  vocabularyScore: number;
  grammarScore: number;
  sentenceBuildingScore: number;
  taskCompletionScore: number;
  naturalnessScore: number;
}) {
  return {
    vocabularyScore: profile.vocabularyScore,
    grammarScore: profile.grammarScore,
    sentenceBuildingScore: profile.sentenceBuildingScore,
    taskCompletionScore: profile.taskCompletionScore,
    naturalnessScore: profile.naturalnessScore,
  };
}
function heuristicExpression(text: string): DimensionScores {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter(Boolean);
  const polite = /\b(could|would|please|i'd like|may i)\b/i.test(text);
  const grammar =
    /\b(i|we|my|our)\b/i.test(text) &&
    /\b(am|have|has|would|could|is|are|need|want|like)\b/i.test(text);
  return {
    vocabulary: Math.min(75, 25 + words.length * 3),
    grammar: grammar ? 55 : 30,
    sentenceBuilding: Math.min(75, 30 + sentences.length * 15 + Math.min(words.length, 15)),
    taskCompletion: Math.min(75, 20 + sentences.length * 20),
    naturalness: polite ? 60 : 35,
  };
}
function parseCompletionJson(response: unknown) {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new BadGatewayException('模型响应缺少结构化内容');
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    throw new BadGatewayException('模型没有返回有效 JSON');
  }
}
function safeErrorCode(error: unknown) {
  return (error instanceof Error ? error.message : 'unknown').slice(0, 120);
}
export function normalizeTurn(value: unknown): TurnResult {
  const item = requiredObject(value, '场景回复');
  const reply = requiredString(item.reply, 'reply');
  const taskProgress = requiredArray(item.taskProgress, 'taskProgress').map((value, index) => {
    const row = requiredObject(value, `taskProgress[${index}]`);
    if (typeof row.completed !== 'boolean') invalidModelField(`taskProgress[${index}].completed`);
    return {
      objective: requiredString(row.objective, `taskProgress[${index}].objective`),
      completed: row.completed as boolean,
    };
  });
  let blockingCorrection: TurnResult['blockingCorrection'] = null;
  if (item.blockingCorrection !== null) {
    const row = requiredObject(item.blockingCorrection, 'blockingCorrection');
    blockingCorrection = {
      issue: requiredString(row.issue, 'blockingCorrection.issue'),
      hint: requiredString(row.hint, 'blockingCorrection.hint'),
      natural: requiredString(row.natural, 'blockingCorrection.natural'),
      frame: requiredString(row.frame, 'blockingCorrection.frame'),
      explanation: requiredString(row.explanation, 'blockingCorrection.explanation'),
    };
  }
  const feedbackTypes = new Set(['grammar', 'collocation', 'naturalness', 'politeness']);
  const deferredFeedback = requiredArray(item.deferredFeedback, 'deferredFeedback')
    .slice(0, 4)
    .map((value, index) => {
      const row = requiredObject(value, `deferredFeedback[${index}]`);
      const type = requiredString(row.type, `deferredFeedback[${index}].type`);
      if (!feedbackTypes.has(type)) invalidModelField(`deferredFeedback[${index}].type`);
      return {
        type,
        original: requiredString(row.original, `deferredFeedback[${index}].original`),
        natural: requiredString(row.natural, `deferredFeedback[${index}].natural`),
        explanation: requiredString(row.explanation, `deferredFeedback[${index}].explanation`),
      };
    });
  const vocabulary = requiredArray(item.vocabulary, 'vocabulary')
    .slice(0, 5)
    .map((value, index) => {
      const row = requiredObject(value, `vocabulary[${index}]`);
      if (row.type !== 'WORD' && row.type !== 'PHRASE')
        invalidModelField(`vocabulary[${index}].type`);
      return {
        text: requiredString(row.text, `vocabulary[${index}].text`),
        type: row.type as 'WORD' | 'PHRASE',
        meaning: requiredString(row.meaning, `vocabulary[${index}].meaning`),
        example: requiredString(row.example, `vocabulary[${index}].example`),
      };
    });
  const skillCodes = requiredArray(item.skillCodes, 'skillCodes')
    .slice(0, 3)
    .map((value, index) => requiredString(value, `skillCodes[${index}]`));
  if (typeof item.sessionShouldEnd !== 'boolean') invalidModelField('sessionShouldEnd');
  return {
    reply,
    taskProgress,
    blockingCorrection,
    deferredFeedback,
    vocabulary,
    scores: strictScores(item.scores),
    skillCodes,
    sessionShouldEnd: item.sessionShouldEnd as boolean,
  };
}
function scenarioPrompt(
  template: {
    title: string;
    description: string;
    userRole: string;
    aiRole: string;
    minTurns: number;
    maxTurns: number;
    objectives: Prisma.JsonValue;
    starterPhrases: Prisma.JsonValue;
    grammarFrames: Prisma.JsonValue;
    difficultyVariants: Prisma.JsonValue;
  },
  level: CefrLevel,
  history: Array<{ role: string; content: string }>,
  turn: number,
  progress: Prisma.JsonValue | null,
) {
  return `你是 Lexloop 旅行场景中的「${template.aiRole}」，学习者是「${template.userRole}」。场景：${template.title}——${template.description}。学习者等级：${level}。该等级要求：${JSON.stringify((template.difficultyVariants as Record<string, unknown>)[level])}。固定目标：${JSON.stringify(template.objectives)}。当前目标进度：${JSON.stringify(progress)}。当前为第 ${turn} 个用户回合，范围 ${template.minTurns}-${template.maxTurns} 回合。\n对话历史：${JSON.stringify(history)}\n\n要求：使用国际通用、自然、礼貌的日常英语继续扮演角色，不使用过时、文学化或考试腔表达，不无故提升难度。先判断用户是否完成目标。只有错误导致意思不清、关键事实相反或无法推进任务时，才设置 blockingCorrection；普通口语缩写、省略和可理解的小错误放入 deferredFeedback，不打断。回复应简短并自然追问。候选生词优先选择可整体调用的口语短语。不要声称评估发音、听力或真实流利度。\n只返回 JSON：{"reply":"角色英文回复","taskProgress":[{"objective":"与固定目标原文一致","completed":true}],"blockingCorrection":null或{"issue":"中文说明","hint":"一步中文提示","natural":"自然英文说法","frame":"可替换句型骨架","explanation":"简短中文语法解释"},"deferredFeedback":[{"type":"grammar|collocation|naturalness|politeness","original":"用户原表达","natural":"更自然英文","explanation":"中文解释"}],"vocabulary":[{"text":"单词或短语","type":"WORD|PHRASE","meaning":"中文语境义","example":"自然英文例句"}],"scores":{"vocabulary":0,"grammar":0,"sentenceBuilding":0,"taskCompletion":0,"naturalness":0},"skillCodes":["polite-request|clarification|explain-problem|negotiate|tactful-escalation"],"sessionShouldEnd":false}`;
}
function openingFor(category: ScenarioCategory) {
  const openings: Record<ScenarioCategory, string> = {
    AIRPORT: 'Good morning. How can I help you with your flight today?',
    HOTEL: 'Welcome. How can I help you today?',
    RESTAURANT: 'Hi there. Are you ready to order, or would you like a little more time?',
    SHOPPING: 'Hi! Let me know if I can help you find anything.',
    TRANSPORT: 'Hello. Where are you trying to get to?',
    HELP: 'Hello. You look like you need some help. What happened?',
  };
  return openings[category];
}
function averageDimensions(values: DimensionScores[]): DimensionScores {
  if (!values.length) return zeroScores();
  return {
    vocabulary: average(values.map((item) => item.vocabulary)),
    grammar: average(values.map((item) => item.grammar)),
    sentenceBuilding: average(values.map((item) => item.sentenceBuilding)),
    taskCompletion: average(values.map((item) => item.taskCompletion)),
    naturalness: average(values.map((item) => item.naturalness)),
  };
}
function uniqueVocabulary(values: TurnResult['vocabulary']) {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = item.text.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function blend(previous: number, current: number) {
  return previous === 0 ? current : Math.round(previous * 0.7 + current * 0.3);
}
function skillForCategory(category: ScenarioCategory) {
  return category === ScenarioCategory.HELP
    ? 'explain-problem'
    : category === ScenarioCategory.AIRPORT || category === ScenarioCategory.TRANSPORT
      ? 'clarification'
      : 'polite-request';
}
function nextLevel(level: CefrLevel) {
  return LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + 1)];
}
function isStrongScenario(outcome: ScenarioOutcome, scores: DimensionScores) {
  return (
    outcome === ScenarioOutcome.SUCCESS &&
    scores.grammar >= 70 &&
    scores.sentenceBuilding >= 70 &&
    scores.taskCompletion >= 70
  );
}
