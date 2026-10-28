import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StudyPlanItemSource,
  StudyPlanMode,
  StudyPlanPurpose,
  StudyPlanStatus,
  WeaknessStatus,
  WordProgressState,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { AiService } from '../ai/ai.service';
import { AiModelConfigService } from '../admin/ai-model-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MISTAKE_CORRECTION_STREAK, MistakesService } from '../mistakes/mistakes.service';
import { reviewSchedule, unfamiliarityScore } from './review-scheduling';
import { lockUserWordProgress } from './user-word-progress-lock';
import { publicStudyContent, publicStudyQuestion } from './study-content';
import { lexicalFields, presentLexicalWord, type MeaningLine } from '../vocabulary/lexical';

const DAY = 86_400_000;
const MAX_DAILY_REVIEW_WORDS = 40;
const MAX_INDIVIDUAL_WORDS = 20;
const EXAM_QUESTION_CYCLE = [
  'MEANING_RECOGNITION',
  'MEANING_RECOGNITION',
  'WORD_MATCHING',
  'WORD_MATCHING',
  'MEANING_RECOGNITION',
  'SYNONYM_REPLACEMENT',
  'WORD_MATCHING',
  'SYNONYM_REPLACEMENT',
  'MEANING_RECOGNITION',
  'READING_COMPREHENSION',
] as const;
export type IndividualWordSelection = 'book' | 'mistakes' | 'random' | 'frequent';
const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};
const modeMap = {
  group: StudyPlanMode.GROUP,
  individual: StudyPlanMode.INDIVIDUAL,
  exam: StudyPlanMode.EXAM,
} as const;
type RequestedMode = keyof typeof modeMap;
type PlanWord = {
  id: string;
  word: string;
  part: string;
  meaning: string;
  senses?: MeaningLine[];
  cefrLevel?: string | null;
};
type GeneratedQuestion = {
  bookWordId: string;
  type:
    | 'WORD_MNEMONIC'
    | 'MEANING_RECOGNITION'
    | 'WORD_MATCHING'
    | 'SYNONYM_REPLACEMENT'
    | 'READING_COMPREHENSION';
  prompt: string;
  options: string[];
  correctAnswers: string[];
  explanation: string;
  optionNotes?: string[];
  pairs?: Array<{ left: string; right: string; tip?: string }>;
};
type GeneratedGroup = {
  index: number;
  title: string;
  wordOccurrences: Record<string, number>;
  sentences: Array<{ english: string; chinese: string; simplified: string; grammar?: string }>;
  questions: GeneratedQuestion[];
};
type GeneratedContent = { groups: GeneratedGroup[] };
type ResolvedGroup = {
  group: GeneratedGroup;
  cacheId?: string;
  signature: string;
  reused: boolean;
};
type GradedAnswer = {
  isCorrect: boolean;
  questionType: GeneratedQuestion['type'];
  selectedAnswer: string[];
};

const studyPlanInclude = (userId: string) =>
  ({
    items: {
      orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
      include: {
        bookWord: {
          include: {
            word: true,
            progress: { where: { userId }, select: { nextReviewAt: true } },
            weaknesses: {
              where: { userId, status: WeaknessStatus.ACTIVE },
              select: { questionType: true, wrongCount: true, consecutiveCorrect: true },
            },
          },
        },
        attempts: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    },
  }) satisfies Prisma.StudyPlanInclude;

type StudyPlanWithItems = Prisma.StudyPlanGetPayload<{
  include: ReturnType<typeof studyPlanInclude>;
}>;

class StudyGroupCompletionAlreadyClaimed extends Error {}
class StudyPlanGenerationSuperseded extends Error {}

@Injectable()
export class StudyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly modelConfigs: AiModelConfigService,
    private readonly mistakes: MistakesService,
  ) {}

  async createPlan(
    userId: string,
    requestedNewWordCount?: number,
    requestedMode: RequestedMode = 'group',
    requestedReviewWordCount?: number,
    selection?: IndividualWordSelection,
  ) {
    const mode = modeMap[requestedMode];
    if (!mode) throw new BadRequestException('不支持的学习模式');
    if (
      requestedReviewWordCount !== undefined &&
      (!Number.isInteger(requestedReviewWordCount) ||
        requestedReviewWordCount < 0 ||
        requestedReviewWordCount > MAX_DAILY_REVIEW_WORDS)
    ) {
      throw new BadRequestException(`本次复习数量必须在 0 到 ${MAX_DAILY_REVIEW_WORDS} 之间`);
    }
    if (selection && mode !== StudyPlanMode.INDIVIDUAL) {
      throw new BadRequestException('选词来源只适用于独立单词模式');
    }
    if (selection) {
      const count = requestedNewWordCount ?? 10;
      if (!Number.isInteger(count) || count < 1 || count > MAX_INDIVIDUAL_WORDS) {
        throw new BadRequestException(`独立单词每次可选 1 到 ${MAX_INDIVIDUAL_WORDS} 个`);
      }
    }
    const planId = await this.prisma.$transaction(async (tx) => {
      // Serialize normal-plan creation per account across API processes. The
      // existing-plan check must run after acquiring the transaction lock.
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0)) IS NULL
      `);
      const existing = await tx.studyPlan.findFirst({
        where: {
          userId,
          purpose: StudyPlanPurpose.NORMAL,
          OR: [
            { status: StudyPlanStatus.GENERATING },
            { status: StudyPlanStatus.ACTIVE, generatedContent: { not: Prisma.DbNull } },
            { status: StudyPlanStatus.FAILED, createdAt: { gte: startOfToday() } },
          ],
        },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      });
      if (existing?.items.length) return existing.id;

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { defaultNewWordCount: true },
      });
      const picked = selection
        ? await selectIndividualWords(tx, userId, selection, requestedNewWordCount ?? 10)
        : await selectDailyWords(
            tx,
            userId,
            requestedNewWordCount ?? user.defaultNewWordCount,
            requestedReviewWordCount,
          );
      const ids = selection ? picked.orderedIds : shuffle(picked.orderedIds);
      if (!ids.length) throw new BadRequestException('当前没有可加入学习计划的单词');
      const groups = buildGroups(ids, mode);
      const created = await tx.studyPlan.create({
        data: {
          userId,
          mode,
          purpose: StudyPlanPurpose.NORMAL,
          status: StudyPlanStatus.GENERATING,
        },
      });
      let examIndex = 0;
      await tx.studyPlanItem.createMany({
        data: groups.flatMap((group, groupIndex) =>
          group.map((bookWordId) => ({
            planId: created.id,
            bookWordId,
            source: picked.reviewIds.includes(bookWordId)
              ? StudyPlanItemSource.REVIEW
              : StudyPlanItemSource.NEW,
            groupIndex,
            ...(mode === StudyPlanMode.EXAM
              ? { targetQuestionType: examQuestionType(examIndex++) }
              : {}),
          })),
        ),
      });
      return created.id;
    });
    return this.serializePlan(planId, userId);
  }

  async generatePlan(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      include: {
        items: {
          orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
          include: { bookWord: { include: { word: true } } },
        },
      },
    });
    if (!plan) throw new NotFoundException('学习计划不存在');
    if (plan.status === StudyPlanStatus.ACTIVE || plan.status === StudyPlanStatus.COMPLETED)
      return this.serializePlan(planId, userId);
    const generationStartedAt = new Date();
    const staleBefore = new Date(generationStartedAt.getTime() - 10 * 60 * 1000);
    const claim = await this.prisma.studyPlan.updateMany({
      where: {
        id: planId,
        userId,
        status: { in: [StudyPlanStatus.GENERATING, StudyPlanStatus.FAILED] },
        OR: [{ generationStartedAt: null }, { generationStartedAt: { lt: staleBefore } }],
      },
      data: {
        status: StudyPlanStatus.GENERATING,
        generationStartedAt,
        generationError: null,
      },
    });
    if (!claim.count) return this.serializePlan(planId, userId);
    const grouped = plan.items.reduce((result, item) => {
      const current = result.get(item.groupIndex) ?? [];
      current.push(item);
      result.set(item.groupIndex, current);
      return result;
    }, new Map<number, typeof plan.items>());
    const words = plan.items.map((item) => {
      const lexical = lexicalFields(item.bookWord.contextMeaning ?? item.bookWord.word.meaning);
      return {
        id: item.bookWordId,
        word: item.bookWord.word.text,
        part: lexical.part,
        meaning: lexical.meaning,
        senses: lexical.meanings,
        cefrLevel: item.bookWord.word.cefrLevel,
      };
    });
    const groupSpec = [...grouped.entries()].map(([index, items]) => ({
      index,
      words: items.map((item) => words.find((word) => word.id === item.bookWordId)!),
      targetQuestionTypes: Object.fromEntries(
        items
          .filter((item) => item.targetQuestionType)
          .map((item) => [item.bookWordId, item.targetQuestionType!]),
      ),
    }));

    try {
      const invalidCacheIds = new Map<number, string>();
      const cached = await Promise.all(
        groupSpec.map(async (spec): Promise<ResolvedGroup | null> => {
          const signature = contentSignature(
            plan.mode,
            spec.words,
            plan.purpose,
            spec.targetQuestionTypes,
          );
          const cache = await this.prisma.studyContentCache.findFirst({
            where: {
              signature,
              mode: plan.mode,
              // A cache entry is reusable when this user has never answered a
              // question from it. Other users' attempts do not block reuse.
              planItems: { none: { attempts: { some: { userId } } } },
            },
            orderBy: [{ hitCount: 'desc' }, { createdAt: 'asc' }],
          });
          if (!cache) return null;
          const group = { ...(cache.material as unknown as GeneratedGroup), index: spec.index };
          try {
            validateGeneratedContent({ groups: [group] }, [spec]);
          } catch {
            invalidCacheIds.set(spec.index, cache.id);
            return null;
          }
          return {
            cacheId: cache.id,
            signature,
            reused: true,
            group,
          };
        }),
      );
      const missingSpecs = groupSpec.filter((_, index) => !cached[index]);
      let generatedMissing: GeneratedGroup[] = [];
      if (missingSpecs.length) {
        if (!(await this.modelConfigs.selectedProvider(userId))) {
          throw new BadRequestException(
            '部分学习材料缺失或未通过内容校验，请先在阅读材料模型设置中选择可用的大模型',
          );
        }
        const response = await this.ai.generateForUser(
          {
            purpose: 'study-plan',
            prompt: generationPrompt(plan.mode, missingSpecs, plan.purpose),
            schema: {},
          },
          userId,
        );
        const generated = parseGeneratedContent(response);
        validateGeneratedContent(generated, missingSpecs);
        generatedMissing = generated.groups;
      }
      const resolved = groupSpec.map((spec, index): ResolvedGroup => {
        const cache = cached[index];
        if (cache) return cache;
        const group = generatedMissing.find((item) => item.index === spec.index)!;
        const passage = group.sentences.map((sentence) => sentence.english).join(' ');
        group.wordOccurrences = Object.fromEntries(
          spec.words.map((word) => [
            word.word,
            passage.match(new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'gi'))?.length ?? 0,
          ]),
        );
        return {
          group,
          cacheId: invalidCacheIds.get(spec.index),
          signature: contentSignature(
            plan.mode,
            spec.words,
            plan.purpose,
            spec.targetQuestionTypes,
          ),
          reused: false,
        };
      });
      const generatedContent: GeneratedContent = { groups: resolved.map((item) => item.group) };
      validateGeneratedContent(generatedContent, groupSpec);
      const generatedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const finalized = await tx.studyPlan.updateMany({
          where: {
            id: planId,
            userId,
            status: StudyPlanStatus.GENERATING,
            generationStartedAt,
          },
          data: {
            generatedContent: generatedContent as unknown as Prisma.InputJsonValue,
            generationError: null,
            generationStartedAt: null,
            generatedAt,
            status: StudyPlanStatus.ACTIVE,
          },
        });
        if (!finalized.count) throw new StudyPlanGenerationSuperseded();

        for (const resolvedGroup of resolved) {
          let cacheId = resolvedGroup.cacheId;
          if (cacheId) {
            await tx.studyContentCache.update({
              where: { id: cacheId },
              data: {
                hitCount: { increment: 1 },
                lastUsedAt: new Date(),
                ...(!resolvedGroup.reused
                  ? {
                      material: {
                        ...resolvedGroup.group,
                        index: 0,
                      } as unknown as Prisma.InputJsonValue,
                    }
                  : {}),
              },
            });
          } else {
            const created = await tx.studyContentCache.create({
              data: {
                signature: resolvedGroup.signature,
                mode: plan.mode,
                material: { ...resolvedGroup.group, index: 0 } as unknown as Prisma.InputJsonValue,
              },
            });
            cacheId = created.id;
          }
          for (const question of resolvedGroup.group.questions) {
            await tx.studyPlanItem.updateMany({
              where: { planId, bookWordId: question.bookWordId },
              data: {
                contentCacheId: cacheId,
                question: question as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }
        const newWordIds = plan.items
          .filter((item) => item.source === StudyPlanItemSource.NEW)
          .map((item) => item.bookWordId);
        if (newWordIds.length) {
          await tx.userWordProgress.createMany({
            data: newWordIds.map((bookWordId) => ({
              userId,
              bookWordId,
              state: WordProgressState.LEARNING,
              firstLearnedAt: generatedAt,
            })),
            skipDuplicates: true,
          });
        }
      });
      return this.serializePlan(planId, userId);
    } catch (error) {
      if (error instanceof StudyPlanGenerationSuperseded) {
        return this.serializePlan(planId, userId);
      }
      const message = error instanceof Error ? error.message : '大模型未返回有效的学习内容';
      const failed = await this.prisma.studyPlan.updateMany({
        where: {
          id: planId,
          userId,
          status: StudyPlanStatus.GENERATING,
          generationStartedAt,
        },
        data: {
          status: StudyPlanStatus.FAILED,
          generationStartedAt: null,
          generationError: message.slice(0, 500),
        },
      });
      if (!failed.count) return this.serializePlan(planId, userId);
      if (error instanceof BadRequestException) throw error;
      throw new BadGatewayException(`学习计划生成失败：${message}`);
    }
  }

  async listPlans(userId: string) {
    const plans = await this.prisma.studyPlan.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: studyPlanInclude(userId),
    });
    return plans.map((plan) => this.serializePlanRecord(plan));
  }

  async listCompletedPlans(userId: string, requestedPage = 1, requestedPageSize = 20) {
    const page = Math.max(1, requestedPage);
    const pageSize = Math.min(50, Math.max(1, requestedPageSize));
    const plans = await this.prisma.studyPlan.findMany({
      where: { userId, status: StudyPlanStatus.COMPLETED },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
      include: studyPlanInclude(userId),
    });
    const hasMore = plans.length > pageSize;
    return {
      items: plans.slice(0, pageSize).map((plan) => this.serializePlanRecord(plan)),
      hasMore,
    };
  }

  async getCompletedPlanReview(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId, status: StudyPlanStatus.COMPLETED },
      include: studyPlanInclude(userId),
    });
    if (!plan) throw new NotFoundException('已完成学习记录不存在');
    return this.serializePlanRecord(plan, true);
  }

  async completeGroup(
    userId: string,
    planId: string,
    groupIndex: number,
    answers: Array<{ bookWordId: string; selectedAnswer: string[]; responseTimeMs?: number }>,
  ) {
    const items = await this.prisma.studyPlanItem.findMany({
      where: {
        planId,
        groupIndex,
        plan: { userId, status: { in: [StudyPlanStatus.ACTIVE, StudyPlanStatus.COMPLETED] } },
      },
      include: { bookWord: true },
    });
    if (!items.length) throw new NotFoundException('学习分组不存在或计划尚未生成完毕');
    if (items.some((item) => item.completedAt)) return this.serializePlan(planId, userId);
    if (items.length !== answers.length) throw new BadRequestException('答题结果与学习分组不匹配');
    const answersMatchGroup =
      new Set(answers.map((answer) => answer.bookWordId)).size === items.length &&
      answers.every((answer) => items.some((item) => item.bookWordId === answer.bookWordId));
    if (!answersMatchGroup) throw new BadRequestException('答题结果包含不属于当前分组的单词');

    try {
      await this.prisma.$transaction(async (tx) => {
        const completedAt = new Date();
        const claimed = await tx.studyPlanItem.updateMany({
          where: {
            id: { in: items.map((item) => item.id) },
            completedAt: null,
            plan: { userId, status: StudyPlanStatus.ACTIVE },
          },
          data: { completedAt },
        });
        if (claimed.count !== items.length) throw new StudyGroupCompletionAlreadyClaimed();

        await tx.studyPlan.updateMany({
          where: { id: planId, startedAt: null },
          data: { startedAt: completedAt },
        });
        await lockUserWordProgress(
          tx,
          userId,
          items.map((item) => item.bookWordId),
        );
        for (const item of items) {
          const answer = answers.find((value) => value.bookWordId === item.bookWordId)!;
          const graded = gradeQuestion(item.question, answer.selectedAnswer);
          const progress = await tx.userWordProgress.findUniqueOrThrow({
            where: { userId_bookWordId: { userId, bookWordId: item.bookWordId } },
          });
          await tx.wordReviewAttempt.create({
            data: {
              userId,
              bookWordId: item.bookWordId,
              planItemId: item.id,
              isCorrect: graded.isCorrect,
              questionType: graded.questionType,
              selectedAnswer: graded.selectedAnswer,
              responseTimeMs:
                answer.responseTimeMs == null
                  ? undefined
                  : Math.max(0, Math.min(3_600_000, answer.responseTimeMs)),
            },
          });
          await this.mistakes.recordAttempt(tx, {
            userId,
            bookWordId: item.bookWordId,
            questionType: graded.questionType,
            isCorrect: graded.isCorrect,
          });
          await tx.userWordProgress.update({
            where: { id: progress.id },
            data: this.schedule(progress, graded.isCorrect),
          });
        }
        const left = await tx.studyPlanItem.count({ where: { planId, completedAt: null } });
        if (!left) {
          await tx.studyPlan.update({
            where: { id: planId },
            data: { status: StudyPlanStatus.COMPLETED, completedAt },
          });
        }
      });
    } catch (error) {
      if (!(error instanceof StudyGroupCompletionAlreadyClaimed)) throw error;
    }
    return this.serializePlan(planId, userId);
  }

  private schedule(
    progress: {
      reviewCount: number;
      totalAttempts: number;
      correctAttempts: number;
      consecutiveCorrect: number;
      lastIntervalDays: number;
      postponedCount: number;
      lastReviewedAt: Date | null;
      nextReviewAt: Date | null;
    },
    correct: boolean,
  ) {
    return reviewSchedule(progress, correct);
  }

  private async serializePlan(planId: string, userId: string) {
    const plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      include: studyPlanInclude(userId),
    });
    if (!plan) throw new NotFoundException('学习计划不存在');
    return this.serializePlanRecord(plan);
  }

  private serializePlanRecord(plan: StudyPlanWithItems, includeSelectedAnswers = false) {
    const itemsByGroup = new Map<number, typeof plan.items>();
    for (const item of plan.items) {
      const groupItems = itemsByGroup.get(item.groupIndex) ?? [];
      groupItems.push(item);
      itemsByGroup.set(item.groupIndex, groupItems);
    }
    const submittedGroups = new Set(
      [...itemsByGroup]
        .filter(
          ([, groupItems]) => groupItems.length > 0 && groupItems.every((item) => item.completedAt),
        )
        .map(([groupIndex]) => groupIndex),
    );
    const items = plan.items.map((item) => ({
      id: item.bookWordId,
      ...presentLexicalWord(item.bookWord.word, item.bookWord.contextMeaning),
      source: item.source,
      groupIndex: item.groupIndex,
      question: publicStudyQuestion(item.question, submittedGroups.has(item.groupIndex)),
      targetQuestionType: item.targetQuestionType,
      completed: Boolean(item.completedAt),
      result: item.attempts[0]?.isCorrect,
      ...(item.completedAt && item.attempts[0] && item.bookWord.sourceExample?.trim()
        ? {
            savedContext: {
              scenario: item.bookWord.sourceScenario?.trim() || null,
              example: item.bookWord.sourceExample.trim(),
            },
          }
        : {}),
      ...(includeSelectedAnswers &&
      submittedGroups.has(item.groupIndex) &&
      isStringAnswerArray(item.attempts[0]?.selectedAnswer)
        ? { selectedAnswer: item.attempts[0]!.selectedAnswer as string[] }
        : {}),
      nextReviewAt: item.completedAt ? (item.bookWord.progress[0]?.nextReviewAt ?? null) : null,
      activeWeaknesses: item.completedAt
        ? item.bookWord.weaknesses.map((signal) => ({
            ...signal,
            remainingCorrect: Math.max(0, MISTAKE_CORRECTION_STREAK - signal.consecutiveCorrect),
          }))
        : [],
    }));
    const attempts = plan.items.flatMap((item) => item.attempts);
    const blocksNewPlanCreation =
      plan.purpose === StudyPlanPurpose.NORMAL &&
      items.length > 0 &&
      (plan.status === StudyPlanStatus.GENERATING ||
        (plan.status === StudyPlanStatus.ACTIVE && plan.generatedContent !== null) ||
        (plan.status === StudyPlanStatus.FAILED && plan.createdAt >= startOfToday()));
    const typeStats = Object.values(
      attempts.reduce<Record<string, { type: string; total: number; correct: number }>>(
        (result, attempt) => {
          const type = attempt.questionType ?? 'OTHER';
          const row = result[type] ?? { type, total: 0, correct: 0 };
          row.total++;
          if (attempt.isCorrect) row.correct++;
          result[type] = row;
          return result;
        },
        {},
      ),
    );
    return {
      id: plan.id,
      mode: plan.mode.toLowerCase(),
      purpose: plan.purpose.toLowerCase(),
      status: plan.status,
      blocksNewPlanCreation,
      generationError: plan.generationError,
      generatedAt: plan.generatedAt,
      createdAt: plan.createdAt,
      completedAt: plan.completedAt,
      wordCount: items.length,
      groupCount: new Set(items.map((item) => item.groupIndex)).size,
      completed: items.filter((item) => item.completed).length,
      content: publicStudyContent(plan.generatedContent, submittedGroups),
      summary: {
        totalQuestions: attempts.length,
        correctQuestions: attempts.filter((attempt) => attempt.isCorrect).length,
        durationSeconds: Math.round(
          attempts.reduce((sum, attempt) => sum + (attempt.responseTimeMs ?? 0), 0) / 1000,
        ),
        typeStats,
      },
      words: items,
    };
  }
}

function isStringAnswerArray(value: Prisma.JsonValue | null | undefined): value is string[] {
  return Array.isArray(value) && value.every((answer) => typeof answer === 'string');
}

function buildGroups(ids: string[], mode: StudyPlanMode) {
  if (mode === StudyPlanMode.INDIVIDUAL) return ids.map((id) => [id]);
  const groups: string[][] = [];
  let cursor = 0;
  while (cursor < ids.length) {
    const remaining = ids.length - cursor;
    if (remaining <= 5) {
      if (remaining === 1 && groups.length) groups[groups.length - 1].push(ids[cursor]);
      else groups.push(ids.slice(cursor));
      break;
    }
    let size = 2 + Math.floor(Math.random() * 4);
    if (remaining - size === 1) size = size === 2 ? 3 : size - 1;
    groups.push(ids.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function shuffle<T>(values: T[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function gradeQuestion(questionValue: unknown, selectedValue: unknown): GradedAnswer {
  if (!questionValue || typeof questionValue !== 'object' || Array.isArray(questionValue)) {
    throw new BadRequestException('题目数据无效，请重新生成学习计划');
  }
  const question = questionValue as Partial<GeneratedQuestion>;
  const supportedTypes: GeneratedQuestion['type'][] = [
    'WORD_MNEMONIC',
    'MEANING_RECOGNITION',
    'WORD_MATCHING',
    'SYNONYM_REPLACEMENT',
    'READING_COMPREHENSION',
  ];
  if (
    !question.type ||
    !supportedTypes.includes(question.type) ||
    !Array.isArray(selectedValue) ||
    selectedValue.some((value) => typeof value !== 'string')
  ) {
    throw new BadRequestException('答题结果格式无效');
  }
  if (
    question.type === 'WORD_MATCHING' &&
    (!Array.isArray(question.pairs) ||
      question.pairs.some(
        (pair) => !pair || typeof pair.left !== 'string' || typeof pair.right !== 'string',
      ))
  ) {
    throw new BadRequestException('配对题缺少可判定的正确答案，请重新生成学习计划');
  }
  const expected =
    question.type === 'WORD_MATCHING'
      ? question.pairs!.map((pair) => `${pair.left}=>${pair.right}`)
      : question.correctAnswers;
  if (
    !Array.isArray(expected) ||
    !expected.length ||
    expected.some((value) => typeof value !== 'string')
  ) {
    throw new BadRequestException('题目缺少可判定的正确答案，请重新生成学习计划');
  }
  const selectedAnswer = [...selectedValue].sort();
  const correctAnswers = [...expected].sort();
  return {
    questionType: question.type,
    selectedAnswer,
    isCorrect:
      selectedAnswer.length === correctAnswers.length &&
      correctAnswers.every((value, index) => value === selectedAnswer[index]),
  };
}

export function hasValidGeneratedMatchingPairs(pairs: unknown) {
  if (!Array.isArray(pairs) || pairs.length !== 4) return false;
  const values = pairs as Array<{ left?: unknown; right?: unknown; tip?: unknown }>;
  if (
    values.some(
      (pair) =>
        typeof pair.left !== 'string' ||
        !pair.left.trim() ||
        typeof pair.right !== 'string' ||
        !/[\u3400-\u9fff]/.test(pair.right) ||
        typeof pair.tip !== 'string' ||
        !/[\u3400-\u9fff]/.test(pair.tip),
    )
  )
    return false;
  if (
    values.some((pair) =>
      (pair.tip as string).toLowerCase().includes((pair.left as string).toLowerCase()),
    )
  )
    return false;
  return (
    new Set(values.map((pair) => (pair.left as string).trim())).size === values.length &&
    new Set(values.map((pair) => (pair.right as string).trim())).size === values.length
  );
}

export function contentSignature(
  mode: StudyPlanMode,
  words: PlanWord[],
  purpose: StudyPlanPurpose = StudyPlanPurpose.NORMAL,
  targetQuestionTypes: Record<string, string> = {},
) {
  const hasKnownCefrLevel = words.some((word) => Boolean(word.cefrLevel));
  const canonicalWords = [...words]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((word) => ({
      id: word.id,
      word: word.word,
      part: word.part,
      meaning: word.meaning,
      ...(word.cefrLevel ? { cefrLevel: word.cefrLevel } : {}),
    }));
  if (
    !hasKnownCefrLevel &&
    purpose === StudyPlanPurpose.NORMAL &&
    !Object.keys(targetQuestionTypes).length
  ) {
    return createHash('sha256')
      .update(JSON.stringify({ version: 3, mode, words: canonicalWords }))
      .digest('hex');
  }
  const canonicalTargetQuestionTypes = Object.fromEntries(
    Object.entries(targetQuestionTypes).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: hasKnownCefrLevel ? 5 : 4,
        mode,
        purpose,
        words: canonicalWords,
        targetQuestionTypes: canonicalTargetQuestionTypes,
      }),
    )
    .digest('hex');
}

export function examQuestionType(index: number) {
  return EXAM_QUESTION_CYCLE[index % EXAM_QUESTION_CYCLE.length];
}

export function generationPrompt(
  mode: StudyPlanMode,
  groups: Array<{ index: number; words: PlanWord[]; targetQuestionTypes?: Record<string, string> }>,
  purpose: StudyPlanPurpose = StudyPlanPurpose.NORMAL,
) {
  const exam = mode === StudyPlanMode.EXAM;
  const label =
    purpose === StudyPlanPurpose.WEAKNESS
      ? '薄弱词专项'
      : exam
        ? '应试语境'
        : mode === StudyPlanMode.INDIVIDUAL
          ? '独立单词'
          : '随机分组';
  return `为 Lexloop 生成一份${label}学习计划。
输入分组：${JSON.stringify(groups)}
难度参考规则：
- 输入中每个词条的 cefrLevel 只描述该词条，不代表学习者水平。若有已知级别，保持目标词及其释义准确，并让周围词汇和句法对该级别的学习材料保持可理解；不要据此宣称或推断学习者的 CEFR 水平。
- 同组目标词级别不同时，不要让最高级目标词抬高整篇材料的难度；用更常见的周边词汇和清晰句式托住较难目标词。
- cefrLevel 为 null 或缺失时，级别未知，不要猜测或补造级别；周围文本优先使用常见词汇和清晰句式。
${
  exam
    ? `
应试语境补充规则：
- 材料必须原创。禁止复述、翻译、改写或仿写任何真实试卷、真题原文、版权阅读篇章或听力原文。
- 语境贴近阅读、完形或翻译题里的新闻、学术或校园场景，但句子、题干和选项都要新写。
- 输入里的 targetQuestionTypes 是本题型配比，必须严格使用，不要改成其他题型，也不要使用 WORD_MNEMONIC。
- MEANING_RECOGNITION 优先考查熟词僻义：正确项对应当前语境里较不常用或易混的义项，干扰项使用该词更常见的义项。senses 里列出的各词性都要考虑。
- WORD_MATCHING 考查同一目标词的固定搭配，以及不同搭配下的语义差别。
- SYNONYM_REPLACEMENT 考查在当前应试句子里可以原样替换的近义表达。
- READING_COMPREHENSION 只依据本组原创短文考查词义或细节。
`
    : ''
}

必须只返回以下 JSON 结构：
{"groups":[{"index":0,"title":"英文短标题","wordOccurrences":{"word":2},"sentences":[{"english":"英文句子","chinese":"完整中文翻译","simplified":"除目标单词保留英文外，其余内容翻成中文的中英混合句","grammar":"中文语法结构提示"}],"questions":[{"bookWordId":"输入中的 id","type":"WORD_MNEMONIC|MEANING_RECOGNITION|WORD_MATCHING|SYNONYM_REPLACEMENT|READING_COMPREHENSION","prompt":"题干","options":["选项"],"correctAnswers":["正确选项原文"],"explanation":"中文简明解析","optionNotes":["与 options 对齐的中文提示"],"pairs":[{"left":"包含目标词的英文单词或短语","right":"中文功能或语义描述","tip":"补充说明该释义侧重的语境或功能"}]}]}]}

规则：
1. 每组 2–4 个自然、连贯且难度适中的英文句子，全文尽量不超过 90 个英文单词；独立单词材料尽量不超过 55 个英文单词。
2. 每组每个目标单词必须至少自然出现一次，并准确填写 wordOccurrences；不要为了次数生硬重复。
3. 每个英文句子必须有逐句 chinese、simplified 和 grammar。simplified 中目标单词保持英文原样，其余译成自然中文；grammar 用中文简要说明句子主干或目标词作用。
4. 每个目标单词恰好生成一道题，bookWordId 必须来自输入；${exam ? '题型以 targetQuestionTypes 为准。' : '五种题型轮换使用。'}所有题干 prompt 必须是自然英文、包含明确提问，且目标词要出现在题干或对应英文阅读材料中。
5. WORD_MNEMONIC 是多选题：英文题干和 4 个英文候选项，围绕可靠的词根、词缀、派生词或形音义联想；correctAnswers 可多项。解析用中文逐项说明关系，不得编造词源。
6. MEANING_RECOGNITION 是单选题：英文语境题干中必须自然出现目标词；4 个 options 必须是相近、同粒度的中文释义，正确项只对应当前语境，其他项是该词其他义项或合理近义干扰项。
7. WORD_MATCHING 的 prompt 是英文指令，pairs 必须恰有 4 组。left 是包含同一目标词的不同英文短语；right 是中文功能/语义描述，说明使用场景、用途或语义维度；tip 是中文补充说明，仅说明 right 强调的维度，绝不出现 left、目标短语关键词或能直接推出答案的词。四组必须唯一配对，options 为空。
8. SYNONYM_REPLACEMENT 是单选题：英文语境题干中标出目标词；4 个 options 都是纯英文候选词或短语。正确项在当前句子的词义、词性、数和搭配上可直接替换；其余项必须是语义相关但不能替换的干扰项。不得附中文释义。
9. READING_COMPREHENSION 是单选题：英文问题和 4 个纯英文选项，必须依据本组英文文章考查目标词相关的细节、词义、推断或主旨，不考文章外知识，也不得附中文释义。
10. 所有题目的正确答案和解析必须与文章、目标词释义一致。explanation 必须使用自然中文，说明语境依据与干扰项为何不成立；界面会单独先展示正确答案，因此 explanation 不要重复答案或输出英文解析。optionNotes 为空数组或省略。
11. 输入分组若包含 targetQuestionTypes，则对应 bookWordId 必须严格生成指定题型；题目必须是新的语境和选项，不能复述历史原题。
12. 每道有选项的题目都必须提供 4 个彼此不同的选项；忽略首尾空白、连续空白、大小写和 Unicode 兼容形式后仍不能相同。`;
}

function parseGeneratedContent(response: unknown): GeneratedContent {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型响应缺少 JSON 内容');
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned) as GeneratedContent;
}

function containsEnglish(value: unknown) {
  return typeof value === 'string' && /[A-Za-z]{3,}/.test(value);
}

function containsChinese(value: unknown) {
  return typeof value === 'string' && /[\u3400-\u9fff]/.test(value);
}

export function validateGeneratedContent(
  content: GeneratedContent,
  expected: Array<{
    index: number;
    words: PlanWord[];
    targetQuestionTypes?: Record<string, string>;
  }>,
) {
  if (!Array.isArray(content.groups) || content.groups.length !== expected.length)
    throw new Error('模型返回的阅读材料分组数量不正确');
  for (const expectedGroup of expected) {
    const group = content.groups.find((item) => item.index === expectedGroup.index);
    if (
      !group ||
      !Array.isArray(group.sentences) ||
      !group.sentences.length ||
      !Array.isArray(group.questions)
    )
      throw new Error(`第 ${expectedGroup.index + 1} 组内容不完整`);
    if (
      group.questions.length !== expectedGroup.words.length ||
      new Set(group.questions.map((question) => question.bookWordId)).size !==
        expectedGroup.words.length
    ) {
      throw new Error(`第 ${expectedGroup.index + 1} 组必须为每个单词生成且只生成一道题`);
    }
    if (
      group.sentences.some(
        (sentence) =>
          !sentence.english?.trim() ||
          !sentence.chinese?.trim() ||
          !sentence.simplified?.trim() ||
          !/[\u3400-\u9fff]/.test(sentence.grammar ?? ''),
      )
    ) {
      throw new Error(`第 ${expectedGroup.index + 1} 组缺少中文逐句翻译、简化文本或语法提示`);
    }
    for (const word of expectedGroup.words) {
      const question = group.questions.find((item) => item.bookWordId === word.id);
      if (!question || !containsEnglish(question.prompt) || !Array.isArray(question.correctAnswers))
        throw new Error(`单词 ${word.word} 缺少英文题干或可判定答案`);
      const targetType = expectedGroup.targetQuestionTypes?.[word.id];
      if (targetType && question.type !== targetType)
        throw new Error(`单词 ${word.word} 必须生成 ${targetType} 题型的变式题`);
      if (!containsChinese(question.explanation))
        throw new Error(`单词 ${word.word} 的解析必须使用中文`);
      const isMatching = question.type === 'WORD_MATCHING';
      const isMnemonic = question.type === 'WORD_MNEMONIC';
      const expectsChineseOptions = question.type === 'MEANING_RECOGNITION';
      if (
        !isMatching &&
        (!Array.isArray(question.options) ||
          question.options.length !== 4 ||
          question.options.some((option) =>
            expectsChineseOptions ? !containsChinese(option) : !containsEnglish(option),
          ) ||
          !hasUniqueOptions(question.options))
      ) {
        throw new Error(`单词 ${word.word} 的选项语言、数量或唯一性不符合题型要求`);
      }
      if (
        (!isMatching &&
          (!question.correctAnswers.length ||
            question.correctAnswers.some((answer) => !question.options.includes(answer)))) ||
        (!isMnemonic && !isMatching && question.correctAnswers.length !== 1)
      ) {
        throw new Error(`单词 ${word.word} 的正确答案不符合题型要求`);
      }
      if (question.type === 'WORD_MATCHING' && !hasValidGeneratedMatchingPairs(question.pairs)) {
        throw new Error(`单词 ${word.word} 的匹配题必须包含 4 组唯一的中文释义和提示`);
      }
      if (
        question.type === 'WORD_MATCHING' &&
        question.pairs?.some(
          (pair) => !new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'i').test(pair.left),
        )
      ) {
        throw new Error(`单词 ${word.word} 的每个匹配短语都必须包含目标词`);
      }
      if (
        !group.sentences.some((sentence) =>
          new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'i').test(sentence.english),
        )
      )
        throw new Error(`阅读材料未包含单词 ${word.word}`);
    }
  }
}

export { unfamiliarityScore };

function hasUniqueOptions(options: unknown): boolean {
  if (!Array.isArray(options)) return false;
  const normalized = options.map((option) =>
    typeof option === 'string'
      ? option.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
      : '',
  );
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type PlanWordPick = { orderedIds: string[]; reviewIds: string[] };

async function selectDailyWords(
  tx: Prisma.TransactionClient,
  userId: string,
  newWordCount: number,
  requestedReviewWordCount?: number,
): Promise<PlanWordPick> {
  const [review, defaultBook] = await Promise.all([
    tx.userWordProgress.findMany({
      where: {
        userId,
        state: WordProgressState.REVIEWING,
        nextReviewAt: { lte: new Date() },
        bookWord: { word: { masteredBy: { none: { userId } } } },
      },
      orderBy: [{ nextReviewAt: 'asc' }, { lastReviewedAt: 'asc' }, { bookWordId: 'asc' }],
      take: requestedReviewWordCount ?? MAX_DAILY_REVIEW_WORDS,
      select: { bookWordId: true },
    }),
    tx.userVocabularyBook.findFirst({
      where: { userId, isDefault: true },
      select: { bookId: true },
    }),
  ]);
  const reviewIds = review.map((item) => item.bookWordId);
  const newWords = defaultBook
    ? await tx.vocabularyBookWord.findMany({
        where: {
          bookId: defaultBook.bookId,
          progress: { none: { userId } },
          word: { masteredBy: { none: { userId } } },
        },
        orderBy: { position: 'asc' },
        take: newWordCount,
        select: { id: true },
      })
    : [];
  const newIds = newWords.map((item) => item.id).filter((id) => !reviewIds.includes(id));
  return { orderedIds: [...reviewIds, ...newIds], reviewIds };
}

async function selectIndividualWords(
  tx: Prisma.TransactionClient,
  userId: string,
  selection: IndividualWordSelection,
  count: number,
): Promise<PlanWordPick> {
  if (selection === 'mistakes') {
    const signals = await tx.weaknessSignal.findMany({
      where: {
        userId,
        status: WeaknessStatus.ACTIVE,
        bookWord: { word: { masteredBy: { none: { userId } } } },
      },
      orderBy: [{ wrongCount: 'desc' }, { lastWrongAt: 'desc' }, { bookWordId: 'asc' }],
      select: { bookWordId: true },
      take: 100,
    });
    const ids = [...new Set(signals.map((item) => item.bookWordId))].slice(0, count);
    if (!ids.length) throw new BadRequestException('错题本里还没有可练习的待巩固词');
    return { orderedIds: ids, reviewIds: ids };
  }

  const defaultBook = await tx.userVocabularyBook.findFirst({
    where: { userId, isDefault: true },
    select: { bookId: true },
  });
  if (!defaultBook) throw new BadRequestException('请先选择一本默认词书');

  let ids: string[] = [];
  if (selection === 'book') {
    const rows = await tx.vocabularyBookWord.findMany({
      where: {
        bookId: defaultBook.bookId,
        progress: { none: { userId } },
        word: { masteredBy: { none: { userId } } },
      },
      orderBy: { position: 'asc' },
      take: count,
      select: { id: true },
    });
    ids = rows.map((row) => row.id);
    if (!ids.length) throw new BadRequestException('当前默认词书没有还没学过的词');
    return { orderedIds: ids, reviewIds: [] };
  }

  if (selection === 'random') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT bw.id
      FROM "VocabularyBookWord" bw
      JOIN "VocabularyWord" w ON w.id = bw."wordId"
      WHERE bw."bookId" = ${defaultBook.bookId}
        AND NOT EXISTS (
          SELECT 1 FROM "UserMasteredWord" m
          WHERE m."userId" = ${userId} AND m."wordId" = w.id
        )
      ORDER BY random()
      LIMIT ${count}
    `);
    ids = rows.map((row) => row.id);
  } else {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT bw.id
      FROM "VocabularyBookWord" bw
      JOIN "VocabularyWord" w ON w.id = bw."wordId"
      LEFT JOIN "UserWordProgress" p
        ON p."bookWordId" = bw.id AND p."userId" = ${userId}
      WHERE bw."bookId" = ${defaultBook.bookId}
        AND NOT EXISTS (
          SELECT 1 FROM "UserMasteredWord" m
          WHERE m."userId" = ${userId} AND m."wordId" = w.id
        )
      ORDER BY
        COALESCE(w."spokenPriority", 0) DESC,
        COALESCE(p."totalAttempts", 0) DESC,
        CASE w."cefrLevel"::text
          WHEN 'A1' THEN 0
          WHEN 'A2' THEN 1
          WHEN 'B1' THEN 2
          WHEN 'B2' THEN 3
          WHEN 'C1' THEN 4
          ELSE 5
        END ASC,
        bw.position ASC
      LIMIT ${count}
    `);
    ids = rows.map((row) => row.id);
  }
  if (!ids.length) throw new BadRequestException('当前默认词书没有可练习的词');
  const progressed = await tx.userWordProgress.findMany({
    where: { userId, bookWordId: { in: ids } },
    select: { bookWordId: true },
  });
  const reviewIds = progressed.map((item) => item.bookWordId);
  return { orderedIds: ids, reviewIds };
}
