import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  StudyContentFeedbackRating,
  StudyContentFeedbackReason,
  StudyPlanItemSource,
  StudyPlanMode,
  StudyPlanPurpose,
  StudyPlanGenerationPhase,
  StudyPlanStatus,
  WeaknessStatus,
  WordProgressState,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { AiService } from '../ai/ai.service';
import { AiModelConfigService } from '../admin/ai-model-config.service';
import { SystemLogService } from '../admin/system-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MISTAKE_CORRECTION_STREAK, MistakesService } from '../mistakes/mistakes.service';
import { reviewSchedule, unfamiliarityScore } from './review-scheduling';
import { lockUserWordProgress } from './user-word-progress-lock';
import { publicStudyContent, publicStudyQuestion } from './study-content';
import { studyQuestionFingerprint } from './study-content-bank';
import {
  getStudyContentClaimStatus,
  releaseStudyContentClaims,
  renewStudyContentClaims,
  STUDY_CONTENT_CLAIM_HEARTBEAT_MS,
  STUDY_CONTENT_CLAIM_LEASE_MS,
  STUDY_CONTENT_CLAIM_POLL_MS,
  STUDY_CONTENT_CLAIM_WAIT_MS,
  studyContentClaimWaitDeadline,
  tryClaimStudyContentSignatures,
} from './study-content-generation-claim';
import { lexicalFields, presentLexicalWord, type MeaningLine } from '../vocabulary/lexical';
import { chinaDateRange } from '../automatic-study-plan/automatic-study-plan.rules';
import {
  attachSystemLogDiagnostic,
  readSystemLogDiagnostic,
  type SystemLogDiagnostic,
  type SystemLogDiagnosticPhase,
} from '../../common/system-log-diagnostic';

const DAY = 86_400_000;
const MAX_DAILY_REVIEW_WORDS = 40;
const MAX_INDIVIDUAL_WORDS = 20;
const DUE_DRILL_WORD_LIMIT = 12;
const STUDY_CACHE_CANDIDATE_LIMIT = 20;
const PUBLIC_CACHE_OBSERVATION_DETAILS: Record<
  PublicCacheMissReason,
  { code: string; reason: string }
> = {
  NO_PUBLIC_MATERIAL: {
    code: 'STUDY_CACHE_MISS_NO_PUBLIC',
    reason: '匹配词目没有来源可确认的公共材料；未记录词条或题目。',
  },
  DISABLED_MATERIAL: {
    code: 'STUDY_CACHE_MISS_DISABLED',
    reason: '匹配材料只有停用版本；未记录词条或题目。',
  },
  FAMILIAR_MATERIAL: {
    code: 'STUDY_CACHE_MISS_FAMILIAR',
    reason: '匹配材料对应题目均已答对；未记录词条或题目。',
  },
  INVALID_MATERIAL: {
    code: 'STUDY_CACHE_MISS_INVALID',
    reason: '候选公共材料未通过内容校验或达到候选上限；未记录材料内容。',
  },
  CANDIDATE_LIMIT: {
    code: 'STUDY_CACHE_MISS_CANDIDATE_LIMIT',
    reason: '候选公共材料未通过内容校验或达到候选上限；未记录材料内容。',
  },
};
const PUBLIC_CACHE_REUSED_OBSERVATION = {
  code: 'STUDY_CACHE_REUSED',
  reason: '该计划复用了符合词目、模式、题型和当前熟悉度条件的公共材料；未记录题目内容。',
};
export const MAX_STUDY_QUESTION_REPAIR_ATTEMPTS = 3;
export const STUDY_GENERATION_REQUEST_TIMEOUT_MS = 90_000;
export const STUDY_GENERATION_TOTAL_TIMEOUT_MS = 6 * 60_000;
const SAFE_GENERATION_FAILURE =
  '学习计划生成失败；详细错误已隐藏。请稍后重试；如仍失败，请联系管理员查看错误日志。';
const SAFE_VALIDATION_ERROR_PATTERNS = [
  /^模型返回的阅读材料分组数量不正确$/,
  /^第 \d{1,3} 组 (?:内容不完整|必须为每个单词生成且只生成一道题|缺少中文逐句翻译、简化文本或语法提示)$/,
  /^单词 [\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'’'\-]{0,79} (?:的题型不受支持，请重新生成|缺少纯英文题干或可判定答案|必须生成 (?:WORD_MNEMONIC|MEANING_RECOGNITION|WORD_MATCHING|SYNONYM_REPLACEMENT|READING_COMPREHENSION) 题型的变式题|的解析必须使用中文|的匹配题只能使用配对内容，不能包含额外选项或答案列表|的选项必须恰有 4 个|的选项语言与题型不符|的选项不能重复|的选项语言、数量或唯一性不符合题型要求|的正确答案不符合题型要求|的匹配题必须包含 4 组唯一的中文释义和提示|的每个匹配短语都必须包含目标词)$/u,
  /^阅读材料未包含单词 [\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'’'\-]{0,79}$/u,
];
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
export type IndividualWordSelection = 'book' | 'mistakes' | 'random' | 'frequent' | 'due';
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
const GENERATED_QUESTION_TYPES = new Set<GeneratedQuestion['type']>([
  'WORD_MNEMONIC',
  'MEANING_RECOGNITION',
  'WORD_MATCHING',
  'SYNONYM_REPLACEMENT',
  'READING_COMPREHENSION',
]);
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
  publicEligible: boolean;
};
type PublicCacheMissReason =
  | 'NO_PUBLIC_MATERIAL'
  | 'DISABLED_MATERIAL'
  | 'FAMILIAR_MATERIAL'
  | 'INVALID_MATERIAL'
  | 'CANDIDATE_LIMIT';
type PublicCacheResolution = {
  cached: Array<ResolvedGroup | null>;
  invalidCacheIds: Map<number, string>;
  missReasons: Map<number, PublicCacheMissReason>;
};
type GradedAnswer = {
  isCorrect: boolean;
  questionType: GeneratedQuestion['type'];
  selectedAnswer: string[];
};
type RecoverablePlanCursor = { userId: string; id: string; createdAt: Date };

function encodeRecoverablePlanCursor(cursor: RecoverablePlanCursor) {
  return Buffer.from(
    JSON.stringify({
      userId: cursor.userId,
      id: cursor.id,
      createdAt: cursor.createdAt.toISOString(),
    }),
  ).toString('base64url');
}

function decodeRecoverablePlanCursor(value: string, expectedUserId: string): RecoverablePlanCursor {
  const invalid = () => new BadRequestException('学习计划游标无效，请重新加载');
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let decoded: unknown;
  try {
    const raw = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(raw).toString('base64url') !== value) throw invalid();
    decoded = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw invalid();
  const cursor = decoded as Record<string, unknown>;
  if (
    cursor.userId !== expectedUserId ||
    typeof cursor.id !== 'string' ||
    cursor.id.length < 1 ||
    cursor.id.length > 100 ||
    typeof cursor.createdAt !== 'string'
  ) {
    throw invalid();
  }
  const createdAt = new Date(cursor.createdAt);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt)
    throw invalid();
  return { userId: expectedUserId, id: cursor.id, createdAt };
}

const studyPlanInclude = (userId: string) =>
  ({
    items: {
      orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
      include: {
        bookWord: {
          include: {
            word: true,
            progress: { where: { userId }, select: { nextReviewAt: true, lastIntervalDays: true } },
            weaknesses: {
              where: { userId, status: WeaknessStatus.ACTIVE },
              select: { questionType: true, wrongCount: true, consecutiveCorrect: true },
            },
          },
        },
        contentCache: {
          select: {
            isPublic: true,
            questionFeedbacks: {
              where: { userId, withdrawnAt: null },
              orderBy: { updatedAt: 'desc' },
              take: 50,
              select: { questionFingerprint: true, rating: true, reason: true },
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

const usableMeaningLine = Prisma.sql`
  REGEXP_REPLACE(
    REGEXP_REPLACE(
      meaning_line.value,
      '^(adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)[.][[:space:]]*',
      '',
      'i'
    ),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  )
`;

const usableBookWordMeaning = Prisma.sql`
  EXISTS (
    SELECT 1
    FROM unnest(string_to_array(
      REPLACE(COALESCE(bw."contextMeaning", w."meaning"), E'\\r', ''),
      E'\\n'
    )) AS meaning_line(value)
    WHERE NULLIF(${usableMeaningLine}, '') IS NOT NULL
      AND LOWER(${usableMeaningLine}) NOT IN ('无', '暂无释义')
  )
`;

function hasUsableMeaning(raw: string | null | undefined) {
  return lexicalFields(raw).meanings.some((line) => {
    const value = line.text.trim();
    return value.length > 0 && value !== '无' && value !== '暂无释义';
  });
}

class StudyGroupCompletionAlreadyClaimed extends Error {}
class StudyPlanGenerationSuperseded extends Error {}

export class StudyQuestionValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly bookWordId: string,
    readonly fieldPath: string,
  ) {
    super(message);
    this.name = 'StudyQuestionValidationError';
  }
}

@Injectable()
export class StudyService {
  private readonly cacheClaimWaitTimeoutMs = STUDY_CONTENT_CLAIM_WAIT_MS;
  private readonly cacheClaimPollIntervalMs = STUDY_CONTENT_CLAIM_POLL_MS;
  private readonly cacheClaimHeartbeatMs = STUDY_CONTENT_CLAIM_HEARTBEAT_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly modelConfigs: AiModelConfigService,
    private readonly mistakes: MistakesService,
    @Optional() private readonly systemLogs?: SystemLogService,
  ) {}

  private observePublicCache(code: string, reason: string) {
    if (!this.systemLogs) return;
    void this.systemLogs
      .record({
        source: 'api',
        severity: 'info',
        kind: 'study.content-cache',
        code,
        method: 'POST',
        route: '/api/v1/study/plans/:planId/generate',
        reason,
      })
      .catch(() => undefined);
  }

  private async waitForPublicCacheClaim(signature: string, deadline: number) {
    while (Date.now() < deadline) {
      const status = await getStudyContentClaimStatus(this.prisma, signature);
      if (status === 'COOLDOWN') return 'COOLDOWN' as const;
      if (status === 'READY' || status === 'EXPIRED') return 'RETRY' as const;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(this.cacheClaimPollIntervalMs, remaining)),
        );
      }
    }
    return 'TIMEOUT' as const;
  }

  async createPlan(
    userId: string,
    requestedNewWordCount?: number,
    requestedMode: RequestedMode = 'group',
    requestedReviewWordCount?: number,
    selection?: IndividualWordSelection,
    skipReviewWordIds?: string[],
    automaticDateKey?: string,
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
      if (automaticDateKey) {
        const sameDay = await tx.studyPlan.findUnique({
          where: { userId_autoDateKey: { userId, autoDateKey: automaticDateKey } },
          select: { id: true },
        });
        if (sameDay) return sameDay.id;
      }
      const dayRange = automaticDateKey ? chinaDateRange(automaticDateKey) : null;
      const existing = await tx.studyPlan.findFirst({
        where: {
          userId,
          purpose: StudyPlanPurpose.NORMAL,
          OR: [
            { status: StudyPlanStatus.GENERATING },
            { status: StudyPlanStatus.ACTIVE, generatedContent: { not: Prisma.DbNull } },
            {
              status: StudyPlanStatus.FAILED,
              createdAt: {
                gte: dayRange?.start ?? startOfToday(),
                ...(dayRange ? { lt: dayRange.end } : {}),
              },
            },
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
      const skipIds =
        !selection || selection === 'due' ? sanitizeSkipReviewIds(skipReviewWordIds) : [];
      const picked = selection
        ? await selectIndividualWords(tx, userId, selection, requestedNewWordCount ?? 10, skipIds)
        : await selectDailyWords(
            tx,
            userId,
            requestedNewWordCount ?? user.defaultNewWordCount,
            requestedReviewWordCount,
            skipIds,
          );
      const ids = selection ? picked.orderedIds : shuffle(picked.orderedIds);
      if (!ids.length) {
        throw new BadRequestException(
          '当前选择范围没有带可用释义的单词；未创建计划，词条和复习排期未更改。请补充释义、调整选词来源或选择其他词表。',
        );
      }
      const groups = buildGroups(ids, mode);
      const created = await tx.studyPlan.create({
        data: {
          userId,
          mode,
          purpose: StudyPlanPurpose.NORMAL,
          status: StudyPlanStatus.GENERATING,
          ...(automaticDateKey ? { autoDateKey: automaticDateKey } : {}),
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
    let plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      include: {
        items: {
          orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
          include: { bookWord: { include: { word: true, book: true } } },
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
        generationPhase: StudyPlanGenerationPhase.PREPARING,
        generationStartedAt,
        generationError: null,
      },
    });
    if (!claim.count) return this.serializePlan(planId, userId);
    const claimedPlan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      include: {
        items: {
          orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
          include: { bookWord: { include: { word: true, book: true } } },
        },
      },
    });
    if (!claimedPlan) throw new NotFoundException('学习计划不存在');
    plan = claimedPlan;
    const missingMeaningItems = plan.items.filter(
      (item) => !hasUsableMeaning(item.bookWord.contextMeaning ?? item.bookWord.word.meaning),
    );
    if (missingMeaningItems.length) {
      const message =
        `${missingMeaningItems.length} 个词目前没有可用释义，未生成练习内容；` +
        '计划中的词条和复习排期未更改。补充释义后可重试，或创建其他计划。';
      await this.prisma.studyPlan.updateMany({
        where: { id: planId, userId, status: StudyPlanStatus.GENERATING, generationStartedAt },
        data: {
          status: StudyPlanStatus.FAILED,
          generationPhase: null,
          generationStartedAt: null,
          generationError: message,
        },
      });
      return this.serializePlan(planId, userId);
    }
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
      publicEligible: items.every(
        (item) => item.bookWord.book.kind === 'SYSTEM' && item.bookWord.book.ownerId === null,
      ),
    }));

    let generationPhase: SystemLogDiagnosticPhase = 'internal';
    let repairAttempts = 0;
    const generationDeadline = generationStartedAt.getTime() + STUDY_GENERATION_TOTAL_TIMEOUT_MS;
    let heldCacheSignatures: string[] = [];
    let cacheClaimToken: string | undefined;
    let cacheClaimFailureCode: string | undefined;
    let cacheClaimHeartbeat: ReturnType<typeof setInterval> | undefined;
    let providerRequestStarted = false;
    const cacheClaimAbortController = new AbortController();
    const generateWithBudget = async (request: Parameters<AiService['generateForUser']>[0]) => {
      const timeoutMs = studyGenerationRequestTimeoutMs(generationDeadline);
      if (!timeoutMs) {
        throw attachSystemLogDiagnostic(
          new Error('学习计划生成超过 6 分钟模型请求总时限；请稍后重试。'),
          {
            code: 'STUDY_GENERATION_TOTAL_TIMEOUT',
            phase: 'provider_request',
            fieldPath: 'request',
            reason: '学习计划模型请求总时限已用完；没有发起额外请求。',
          },
        );
      }
      if (cacheClaimAbortController.signal.aborted) {
        throw attachSystemLogDiagnostic(
          new Error('公共学习材料生成协同租约失效；已停止后续模型请求。'),
          {
            code: 'STUDY_CACHE_CLAIM_LOST',
            phase: 'provider_request',
            fieldPath: 'public_material_claim',
            reason: '公共材料生成协同租约失效；已停止本次后续模型请求。',
          },
        );
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        cacheClaimAbortController.signal,
      ]);
      try {
        providerRequestStarted = true;
        const response = await this.ai.generateForUser(request, userId, signal);
        if (signal.aborted) throw signal.reason;
        return response;
      } catch (error) {
        if (cacheClaimAbortController.signal.aborted) {
          throw attachSystemLogDiagnostic(
            new Error('公共学习材料生成协同租约失效；已停止后续模型请求。'),
            {
              code: 'STUDY_CACHE_CLAIM_LOST',
              phase: 'provider_request',
              fieldPath: 'public_material_claim',
              reason: '公共材料生成协同租约失效；已停止本次后续模型请求。',
            },
          );
        }
        if (!signal.aborted) throw error;
        const totalTimeout = Date.now() >= generationDeadline;
        throw attachSystemLogDiagnostic(
          new Error(
            totalTimeout
              ? '学习计划生成超过 6 分钟模型请求总时限；请稍后重试。'
              : '模型请求超过单次 90 秒响应时限；请稍后重试。',
          ),
          {
            code: totalTimeout
              ? 'STUDY_GENERATION_TOTAL_TIMEOUT'
              : 'STUDY_PROVIDER_REQUEST_TIMEOUT',
            phase: 'provider_request',
            fieldPath: 'request',
            reason: totalTimeout
              ? '学习计划模型请求总时限已用完；没有发起额外请求。'
              : '单次模型请求超过 90 秒响应时限；原始请求和响应内容已隐藏。',
          },
        );
      }
    };
    const setGenerationPhase = async (phase: StudyPlanGenerationPhase) => {
      const updated = await this.prisma.studyPlan.updateMany({
        where: { id: planId, userId, status: StudyPlanStatus.GENERATING, generationStartedAt },
        data: { generationPhase: phase },
      });
      if (!updated.count) throw new StudyPlanGenerationSuperseded();
    };
    try {
      const cacheLookupSpecs = groupSpec.map((spec) => ({
        spec,
        signature: contentSignature(plan.mode, spec.words, plan.purpose, spec.targetQuestionTypes),
      }));
      const signatures = [
        ...new Set(
          cacheLookupSpecs
            .filter(({ spec }) => spec.publicEligible)
            .map(({ signature }) => signature),
        ),
      ];
      const resolveCacheGroups = async (): Promise<PublicCacheResolution> => {
        // The plan selector already limits groups to new or due, non-mastered
        // words. An exact public material version with a missing/latest-wrong
        // answer is unfamiliar; fully correct versions are intentionally not
        // reused so a due word gets fresh material when needed.
        const cacheCandidates = signatures.length
          ? await this.prisma.$queryRaw<
              Array<{
                id: string;
                signature: string;
                material: Prisma.JsonValue;
                hasUnfamiliarQuestion: boolean;
                candidateCount: number;
              }>
            >(Prisma.sql`
            WITH ranked_cache AS (
              SELECT
                cache."id",
                cache."signature",
                cache."material",
                familiarity."hasUnfamiliarQuestion",
                COUNT(*) OVER (PARTITION BY cache."signature")::int AS "candidateCount",
                ROW_NUMBER() OVER (
                  PARTITION BY cache."signature"
                  ORDER BY familiarity."hasUnfamiliarQuestion" DESC,
                           cache."hitCount" DESC,
                           cache."createdAt" ASC
                ) AS candidate_rank
              FROM "public"."StudyContentCache" AS cache
              CROSS JOIN LATERAL (
                SELECT CASE
                  WHEN COALESCE(jsonb_typeof(cache."material"->'questions'), 'null') <> 'array'
                  THEN TRUE
                  WHEN jsonb_array_length(cache."material"->'questions') = 0 THEN TRUE
                  ELSE EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(cache."material"->'questions')
                      AS material_question(question)
                    LEFT JOIN LATERAL (
                      SELECT attempt."isCorrect"
                      FROM "public"."StudyPlanItem" AS item
                      JOIN "public"."StudyPlan" AS plan
                        ON plan."id" = item."planId"
                       AND plan."userId" = ${userId}
                      JOIN "public"."WordReviewAttempt" AS attempt
                        ON attempt."planItemId" = item."id"
                       AND attempt."userId" = ${userId}
                      WHERE item."contentCacheId" = cache."id"
                        AND item."bookWordId" = material_question.question->>'bookWordId'
                        AND item."question" = material_question.question
                      ORDER BY attempt."createdAt" DESC, attempt."id" DESC
                      LIMIT 1
                    ) AS latest_attempt ON TRUE
                    WHERE latest_attempt."isCorrect" IS DISTINCT FROM TRUE
                  )
                END AS "hasUnfamiliarQuestion"
              ) AS familiarity
              WHERE cache."mode" = ${plan.mode}::"StudyPlanMode"
                AND cache."isPublic" = TRUE
                AND cache."isActive" = TRUE
                AND cache."signature" IN (${Prisma.join(signatures)})
            )
            SELECT "id", "signature", "material", "hasUnfamiliarQuestion", "candidateCount"
            FROM ranked_cache
            WHERE candidate_rank <= ${STUDY_CACHE_CANDIDATE_LIMIT}
            ORDER BY "signature", candidate_rank
          `)
          : [];
        const cacheCandidatesBySignature = new Map<string, typeof cacheCandidates>();
        for (const candidate of cacheCandidates) {
          const matches = cacheCandidatesBySignature.get(candidate.signature) ?? [];
          matches.push(candidate);
          cacheCandidatesBySignature.set(candidate.signature, matches);
        }
        const invalidCacheIds = new Map<number, string>();
        const cached = cacheLookupSpecs.map(({ spec, signature }): ResolvedGroup | null => {
          if (!spec.publicEligible) return null;
          let firstInvalidCacheId: string | undefined;
          for (const cache of cacheCandidatesBySignature.get(signature) ?? []) {
            if (!cache.hasUnfamiliarQuestion) continue;
            const group = { ...(cache.material as unknown as GeneratedGroup), index: spec.index };
            try {
              validateGeneratedContent({ groups: [group] }, [spec]);
            } catch {
              firstInvalidCacheId ??= cache.id;
              continue;
            }
            return {
              cacheId: cache.id,
              signature,
              reused: true,
              publicEligible: true,
              group,
            };
          }
          if (firstInvalidCacheId) invalidCacheIds.set(spec.index, firstInvalidCacheId);
          return null;
        });
        const missReasons = new Map<number, PublicCacheMissReason>();
        const unresolved = cacheLookupSpecs.filter(
          ({ spec }, index) => spec.publicEligible && !cached[index],
        );
        const candidatesBySignature = new Map(
          [...cacheCandidatesBySignature.entries()].map(([signature, items]) => [
            signature,
            {
              items,
              total: items[0]?.candidateCount ?? 0,
            },
          ]),
        );
        const signaturesWithoutCandidates = [
          ...new Set(
            unresolved
              .filter(({ signature }) => !candidatesBySignature.has(signature))
              .map(({ signature }) => signature),
          ),
        ];
        const materialCounts = signaturesWithoutCandidates.length
          ? await this.prisma.$queryRaw<
              Array<{ signature: string; publicCount: number; activeCount: number }>
            >(Prisma.sql`
              SELECT
                "signature",
                COUNT(*)::int AS "publicCount",
                COUNT(*) FILTER (WHERE "isActive" = TRUE)::int AS "activeCount"
              FROM "public"."StudyContentCache"
              WHERE "mode" = ${plan.mode}::"StudyPlanMode"
                AND "isPublic" = TRUE
                AND "signature" IN (${Prisma.join(signaturesWithoutCandidates)})
              GROUP BY "signature"
            `)
          : [];
        const countsBySignature = new Map(materialCounts.map((row) => [row.signature, row]));
        for (const { spec, signature } of unresolved) {
          const candidateState = candidatesBySignature.get(signature);
          let reason: PublicCacheMissReason;
          if (candidateState) {
            if (candidateState.items.some((item) => item.hasUnfamiliarQuestion)) {
              reason =
                invalidCacheIds.has(spec.index) &&
                candidateState.total > STUDY_CACHE_CANDIDATE_LIMIT
                  ? 'CANDIDATE_LIMIT'
                  : 'INVALID_MATERIAL';
            } else {
              reason = 'FAMILIAR_MATERIAL';
            }
          } else {
            const counts = countsBySignature.get(signature);
            reason = counts?.publicCount
              ? counts.activeCount
                ? 'FAMILIAR_MATERIAL'
                : 'DISABLED_MATERIAL'
              : 'NO_PUBLIC_MATERIAL';
          }
          missReasons.set(spec.index, reason);
        }
        return { cached, invalidCacheIds, missReasons };
      };
      let cacheResolution = await resolveCacheGroups();
      let invalidCacheIds = cacheResolution.invalidCacheIds;
      let cached = cacheResolution.cached;
      const publicMissingSignatures = () =>
        [
          ...new Set(
            cacheLookupSpecs
              .filter(({ spec }, index) => spec.publicEligible && !cached[index])
              .map(({ signature }) => signature),
          ),
        ].sort();
      const claimWaitDeadline = studyContentClaimWaitDeadline(
        generationDeadline,
        Date.now(),
        this.cacheClaimWaitTimeoutMs,
      );
      const initiallyMissingSignatures = publicMissingSignatures();
      if (initiallyMissingSignatures.length) {
        cacheClaimToken = randomUUID();
        while (true) {
          const needed = publicMissingSignatures();
          if (!needed.length) break;
          if (Date.now() >= claimWaitDeadline) {
            throw attachSystemLogDiagnostic(
              new BadGatewayException(
                '等待相同公共学习材料超过时限；没有重复发起模型请求，请稍后重试。',
              ),
              {
                code: 'STUDY_CACHE_GENERATION_WAIT_TIMEOUT',
                phase: 'internal',
                fieldPath: 'public_material_claim',
                reason: '等待同一公共材料超过时限；已停止发起重复模型请求。',
              },
            );
          }
          if (
            await tryClaimStudyContentSignatures(
              this.prisma,
              needed,
              cacheClaimToken,
              new Date(),
              generationStartedAt,
            )
          ) {
            heldCacheSignatures = needed;
            break;
          }
          const statuses = await Promise.all(
            needed.map(async (signature) => ({
              signature,
              status: await getStudyContentClaimStatus(this.prisma, signature),
            })),
          );
          const blocked = statuses.find(({ status }) => status !== 'READY');
          const blockedSignature = blocked?.signature ?? needed[0];
          const status = blocked?.status ?? 'READY';
          await releaseStudyContentClaims(this.prisma, needed, cacheClaimToken);
          if (status === 'COOLDOWN') {
            throw attachSystemLogDiagnostic(
              new BadGatewayException(
                '同一公共学习材料刚生成失败，系统正在短暂冷却以避免重复请求；请稍后重试。',
              ),
              {
                code: 'STUDY_CACHE_GENERATION_COOLDOWN',
                phase: 'internal',
                fieldPath: 'public_material_claim',
                reason: '同一公共材料近期生成失败；处于短暂冷却期，未发起重复模型请求。',
              },
            );
          }
          if (status === 'BUSY') {
            await setGenerationPhase(StudyPlanGenerationPhase.WAITING_PUBLIC_CACHE);
          }
          const waited = await this.waitForPublicCacheClaim(
            blockedSignature ?? needed[0],
            claimWaitDeadline,
          );
          if (waited === 'TIMEOUT') {
            throw attachSystemLogDiagnostic(
              new BadGatewayException(
                '等待相同公共学习材料超过时限；没有重复发起模型请求，请稍后重试。',
              ),
              {
                code: 'STUDY_CACHE_GENERATION_WAIT_TIMEOUT',
                phase: 'internal',
                fieldPath: 'public_material_claim',
                reason: '等待同一公共材料超过时限；已停止发起重复模型请求。',
              },
            );
          }
          if (waited === 'COOLDOWN') {
            throw attachSystemLogDiagnostic(
              new BadGatewayException(
                '同一公共学习材料刚生成失败，系统正在短暂冷却以避免重复请求；请稍后重试。',
              ),
              {
                code: 'STUDY_CACHE_GENERATION_COOLDOWN',
                phase: 'internal',
                fieldPath: 'public_material_claim',
                reason: '同一公共材料近期生成失败；处于短暂冷却期，未发起重复模型请求。',
              },
            );
          }
        }
        cacheResolution = await resolveCacheGroups();
        cached = cacheResolution.cached;
        invalidCacheIds = cacheResolution.invalidCacheIds;
        const noLongerNeeded = heldCacheSignatures.filter(
          (signature) => !publicMissingSignatures().includes(signature),
        );
        if (noLongerNeeded.length) {
          await releaseStudyContentClaims(this.prisma, noLongerNeeded, cacheClaimToken);
          heldCacheSignatures = heldCacheSignatures.filter(
            (signature) => !noLongerNeeded.includes(signature),
          );
        }
        if (heldCacheSignatures.length) {
          let heartbeatInFlight = false;
          cacheClaimHeartbeat = setInterval(() => {
            if (heartbeatInFlight || cacheClaimAbortController.signal.aborted) return;
            heartbeatInFlight = true;
            void renewStudyContentClaims(this.prisma, heldCacheSignatures, cacheClaimToken!)
              .then((renewed) => {
                if (!renewed && !cacheClaimAbortController.signal.aborted) {
                  cacheClaimFailureCode = 'STUDY_CACHE_CLAIM_LOST';
                  cacheClaimAbortController.abort(new Error('Public study content claim expired'));
                }
              })
              .catch(() => {
                if (!cacheClaimAbortController.signal.aborted) {
                  cacheClaimFailureCode = 'STUDY_CACHE_CLAIM_LOST';
                  cacheClaimAbortController.abort(
                    new Error('Public study content claim unavailable'),
                  );
                }
              })
              .finally(() => {
                heartbeatInFlight = false;
              });
          }, this.cacheClaimHeartbeatMs);
          cacheClaimHeartbeat.unref?.();
        }
      }
      if (cached.some(Boolean)) {
        this.observePublicCache(
          PUBLIC_CACHE_REUSED_OBSERVATION.code,
          PUBLIC_CACHE_REUSED_OBSERVATION.reason,
        );
      }
      const observedMissReasons = new Set(cacheResolution.missReasons.values());
      for (const reason of observedMissReasons) {
        const observation = PUBLIC_CACHE_OBSERVATION_DETAILS[reason];
        this.observePublicCache(observation.code, observation.reason);
      }
      const missingSpecs = groupSpec.filter((_, index) => !cached[index]);
      let generatedMissing: GeneratedGroup[] = [];
      if (missingSpecs.length) {
        generationPhase = 'provider_request';
        if (!(await this.modelConfigs.selectedProvider(userId))) {
          throw new BadRequestException(
            '部分学习材料缺失或未通过内容校验，请先在阅读材料模型设置中选择可用的大模型',
          );
        }
        await setGenerationPhase(StudyPlanGenerationPhase.WAITING_MODEL);
        const response = await generateWithBudget({
          purpose: 'study-plan',
          prompt: generationPrompt(plan.mode, missingSpecs, plan.purpose),
          schema: {},
        });
        await setGenerationPhase(StudyPlanGenerationPhase.VALIDATING);
        generationPhase = 'content_parse';
        const generated = normalizeGeneratedContentFormatting(parseGeneratedContent(response));
        generationPhase = 'content_validation';
        const repaired = await validateAndRepairGeneratedContent(generated, missingSpecs, {
          onRepairAttempt: async (attempt) => {
            repairAttempts = attempt;
            generationPhase = 'content_validation';
            await setGenerationPhase(StudyPlanGenerationPhase.REPAIRING);
          },
          repairQuestion: async ({ error, word, group, question, attempt }) => {
            generationPhase = 'provider_request';
            const repairResponse = await generateWithBudget({
              purpose: 'study-plan-question-repair',
              prompt: questionRepairPrompt({
                word,
                targetQuestionType: groupSpec.find((spec) => spec.index === group.index)
                  ?.targetQuestionTypes?.[word.id],
                sentenceContext: group.sentences.map((sentence) => sentence.english),
                question,
                issue: safeQuestionRepairIssue(error.code),
                attempt,
              }),
              schema: {},
            });
            await setGenerationPhase(StudyPlanGenerationPhase.VALIDATING);
            generationPhase = 'content_parse';
            let repairedQuestion: GeneratedQuestion;
            try {
              repairedQuestion = parseGeneratedQuestionRepair(repairResponse, word.id);
            } catch (repairError) {
              const repairDiagnostic = readSystemLogDiagnostic(repairError);
              if (this.systemLogs && repairDiagnostic) {
                await this.systemLogs.record({
                  source: 'api',
                  kind: 'study.generation.repair',
                  ...repairDiagnostic,
                  attemptsMade: attempt,
                  maxAttempts: MAX_STUDY_QUESTION_REPAIR_ATTEMPTS,
                  reason: '局部修复响应结构无效；原题保留并使用剩余补救次数，未记录返回内容。',
                });
              }
              generationPhase = 'content_validation';
              return question;
            }
            generationPhase = 'content_validation';
            return repairedQuestion;
          },
        });
        repairAttempts = repaired.attempts;
        if (repairAttempts > 0 && this.systemLogs) {
          await this.systemLogs.record({
            source: 'api',
            kind: 'study.generation.repair',
            code: 'STUDY_QUESTION_REPAIR_COMPLETED',
            phase: 'content_validation',
            fieldPath: 'groups[].questions',
            attemptsMade: repairAttempts,
            maxAttempts: MAX_STUDY_QUESTION_REPAIR_ATTEMPTS,
            reason: '个别题目已通过有限局部修复；题目内容未写入日志。',
          });
        }
        generatedMissing = repaired.content.groups;
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
          publicEligible: spec.publicEligible,
        };
      });
      const generatedContent: GeneratedContent = { groups: resolved.map((item) => item.group) };
      generationPhase = 'content_validation';
      validateGeneratedContent(generatedContent, groupSpec);
      const generatedAt = new Date();
      await setGenerationPhase(StudyPlanGenerationPhase.SAVING);
      generationPhase = 'plan_persistence';
      await this.prisma.$transaction(async (tx) => {
        if (heldCacheSignatures.length && cacheClaimToken) {
          const lease = await tx.studyContentGenerationClaim.updateMany({
            where: {
              signature: { in: heldCacheSignatures },
              ownerToken: cacheClaimToken,
              leaseExpiresAt: { gt: generatedAt },
            },
            data: {
              leaseExpiresAt: new Date(generatedAt.getTime() + STUDY_CONTENT_CLAIM_LEASE_MS),
            },
          });
          if (lease.count !== heldCacheSignatures.length) {
            cacheClaimFailureCode = 'STUDY_CACHE_CLAIM_LOST';
            throw attachSystemLogDiagnostic(
              new Error('公共学习材料生成协同租约失效；已停止保存结果。'),
              {
                code: 'STUDY_CACHE_CLAIM_LOST',
                phase: 'plan_persistence',
                fieldPath: 'public_material_claim',
                reason: '公共材料生成协同租约失效；已停止本次后续模型请求。',
              },
            );
          }
        }
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
            generationPhase: null,
            generationStartedAt: null,
            generatedAt,
            status: StudyPlanStatus.ACTIVE,
          },
        });
        if (!finalized.count) throw new StudyPlanGenerationSuperseded();

        for (const resolvedGroup of resolved) {
          let cacheId = resolvedGroup.cacheId;
          if (resolvedGroup.publicEligible && cacheId) {
            await tx.studyContentCache.update({
              where: { id: cacheId },
              data: {
                hitCount: resolvedGroup.reused ? { increment: 1 } : 0,
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
          } else if (resolvedGroup.publicEligible) {
            const created = await tx.studyContentCache.create({
              data: {
                signature: resolvedGroup.signature,
                mode: plan.mode,
                material: { ...resolvedGroup.group, index: 0 } as unknown as Prisma.InputJsonValue,
                isPublic: true,
              },
            });
            cacheId = created.id;
          }
          for (const question of resolvedGroup.group.questions) {
            await tx.studyPlanItem.updateMany({
              where: { planId, bookWordId: question.bookWordId },
              data: {
                contentCacheId: resolvedGroup.publicEligible ? (cacheId ?? null) : null,
                question: question as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }
        const newWordIds = plan.items
          .filter((item) => item.source === StudyPlanItemSource.NEW)
          .map((item) => item.bookWordId)
          .sort();
        if (newWordIds.length && !plan.autoDateKey) {
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
        if (heldCacheSignatures.length && cacheClaimToken) {
          await tx.studyContentGenerationClaim.deleteMany({
            where: {
              signature: { in: heldCacheSignatures },
              ownerToken: cacheClaimToken,
            },
          });
        }
      });
      heldCacheSignatures = [];
      return this.serializePlan(planId, userId);
    } catch (error) {
      if (error instanceof StudyPlanGenerationSuperseded) {
        return this.serializePlan(planId, userId);
      }
      const baseDiagnostic =
        readSystemLogDiagnostic(error) ?? generationFailureDiagnostic(error, generationPhase);
      const diagnostic: SystemLogDiagnostic = {
        ...baseDiagnostic,
        ...(repairAttempts > 0
          ? { repairAttempts, maxRepairAttempts: MAX_STUDY_QUESTION_REPAIR_ATTEMPTS }
          : {}),
      };
      const message = safeGenerationFailureMessage(error, diagnostic, generationPhase);
      const failed = await this.prisma.studyPlan.updateMany({
        where: {
          id: planId,
          userId,
          status: StudyPlanStatus.GENERATING,
          generationStartedAt,
        },
        data: {
          status: StudyPlanStatus.FAILED,
          generationPhase: null,
          generationStartedAt: null,
          generationError: message.slice(0, 500),
        },
      });
      if (!failed.count) return this.serializePlan(planId, userId);
      if (error instanceof BadRequestException) throw new BadRequestException(message);
      throw attachSystemLogDiagnostic(
        new BadGatewayException(`学习计划生成失败：${message}`),
        diagnostic,
      );
    } finally {
      if (cacheClaimHeartbeat) clearInterval(cacheClaimHeartbeat);
      if (heldCacheSignatures.length && cacheClaimToken) {
        const failureCode =
          cacheClaimFailureCode ??
          (providerRequestStarted
            ? generationPhase === 'content_parse' || generationPhase === 'content_validation'
              ? 'STUDY_CACHE_VALIDATION_FAILED'
              : 'STUDY_CACHE_PROVIDER_FAILED'
            : undefined);
        await releaseStudyContentClaims(
          this.prisma,
          heldCacheSignatures,
          cacheClaimToken,
          failureCode,
        ).catch(() => undefined);
      }
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

  async listRecoverablePlans(userId: string, encodedCursor?: string, requestedPageSize = 20) {
    const pageSize = Math.min(50, Math.max(1, Math.trunc(requestedPageSize)));
    const cursor = encodedCursor ? decodeRecoverablePlanCursor(encodedCursor, userId) : null;
    const plans = await this.prisma.studyPlan.findMany({
      where: {
        userId,
        status: {
          in: [StudyPlanStatus.GENERATING, StudyPlanStatus.ACTIVE, StudyPlanStatus.FAILED],
        },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      select: {
        id: true,
        mode: true,
        purpose: true,
        status: true,
        createdAt: true,
        generationError: true,
        generationPhase: true,
        generationStartedAt: true,
        items: { select: { completedAt: true } },
      },
    });
    const hasMore = plans.length > pageSize;
    const page = plans.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map((plan) => ({
        id: plan.id,
        mode: plan.mode.toLowerCase(),
        purpose: plan.purpose.toLowerCase(),
        status: plan.status,
        createdAt: plan.createdAt,
        generationError: safeStoredGenerationError(plan.generationError),
        generationPhase: plan.status === StudyPlanStatus.GENERATING ? plan.generationPhase : null,
        generationStartedAt:
          plan.status === StudyPlanStatus.GENERATING ? plan.generationStartedAt : null,
        wordCount: plan.items.length,
        completed: plan.items.filter((item) => item.completedAt !== null).length,
      })),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeRecoverablePlanCursor({ userId, id: last.id, createdAt: last.createdAt })
          : null,
    };
  }

  async getPlan(userId: string, planId: string) {
    return this.serializePlan(planId, userId);
  }

  async ratePublicQuestion(
    userId: string,
    planId: string,
    bookWordId: string,
    rating: StudyContentFeedbackRating,
    reason?: StudyContentFeedbackReason,
  ) {
    const item = await this.prisma.studyPlanItem.findFirst({
      where: {
        planId,
        bookWordId,
        completedAt: { not: null },
        plan: { userId },
        attempts: { some: { userId } },
        contentCache: { is: { isPublic: true } },
      },
      select: { question: true, contentCacheId: true },
    });
    if (!item?.question || !item.contentCacheId) {
      throw new NotFoundException('只有完成并查看过的公共题目可以评价');
    }
    const questionFingerprint = studyQuestionFingerprint(item.question);
    const feedback = await this.prisma.studyContentQuestionFeedback.upsert({
      where: {
        userId_contentCacheId_questionFingerprint: {
          userId,
          contentCacheId: item.contentCacheId,
          questionFingerprint,
        },
      },
      create: {
        userId,
        contentCacheId: item.contentCacheId,
        questionFingerprint,
        questionSnapshot: item.question,
        rating,
        reason: rating === StudyContentFeedbackRating.DOWN ? (reason ?? null) : null,
        withdrawnAt: null,
      },
      update: {
        questionSnapshot: item.question,
        rating,
        reason: rating === StudyContentFeedbackRating.DOWN ? (reason ?? null) : null,
        withdrawnAt: null,
      },
      select: { rating: true, reason: true },
    });
    return { ...feedback, saved: true };
  }

  async withdrawPublicQuestionFeedback(userId: string, planId: string, bookWordId: string) {
    const item = await this.prisma.studyPlanItem.findFirst({
      where: {
        planId,
        bookWordId,
        completedAt: { not: null },
        plan: { userId },
        attempts: { some: { userId } },
        contentCache: { is: { isPublic: true } },
      },
      select: { question: true, contentCacheId: true },
    });
    if (!item?.question || !item.contentCacheId) {
      throw new NotFoundException('只有完成并查看过的公共题目可以撤回评价');
    }
    await this.prisma.studyContentQuestionFeedback.updateMany({
      where: {
        userId,
        contentCacheId: item.contentCacheId,
        questionFingerprint: studyQuestionFingerprint(item.question),
        withdrawnAt: null,
      },
      data: { withdrawnAt: new Date() },
    });
    // Return the target state so a retry after a lost response is idempotent.
    return { withdrawn: true };
  }

  async getGenerationStatus(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      select: {
        id: true,
        status: true,
        generationPhase: true,
        generationStartedAt: true,
        generationError: true,
      },
    });
    if (!plan) throw new NotFoundException('学习计划不存在');
    if (plan.status !== StudyPlanStatus.GENERATING) return this.serializePlan(planId, userId);
    return {
      id: plan.id,
      status: plan.status,
      generationPhase: plan.generationPhase,
      generationStartedAt: plan.generationStartedAt,
      generationError: safeStoredGenerationError(plan.generationError),
    };
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
      include: { bookWord: true, plan: { select: { autoDateKey: true } } },
    });
    if (!items.length) throw new NotFoundException('学习分组不存在或计划尚未生成完毕');
    if (items.some((item) => item.completedAt)) return this.serializePlan(planId, userId);
    if (items.length !== answers.length) throw new BadRequestException('答题结果与学习分组不匹配');
    const answersMatchGroup =
      new Set(answers.map((answer) => answer.bookWordId)).size === items.length &&
      answers.every((answer) => items.some((item) => item.bookWordId === answer.bookWordId));
    if (!answersMatchGroup) throw new BadRequestException('答题结果包含不属于当前分组的单词');

    const previousIntervals = new Map<string, number>();
    let committed = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        previousIntervals.clear();
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
        const automaticNewWordIds = items
          .filter((item) => item.plan.autoDateKey && item.source === StudyPlanItemSource.NEW)
          .map((item) => item.bookWordId);
        if (automaticNewWordIds.length) {
          await tx.userWordProgress.createMany({
            data: automaticNewWordIds.map((bookWordId) => ({
              userId,
              bookWordId,
              state: WordProgressState.LEARNING,
              firstLearnedAt: completedAt,
            })),
            skipDuplicates: true,
          });
        }
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
          previousIntervals.set(item.bookWordId, progress.lastIntervalDays);
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
      committed = true;
    } catch (error) {
      if (!(error instanceof StudyGroupCompletionAlreadyClaimed)) throw error;
    }
    const plan = await this.serializePlan(planId, userId);
    if (!committed) return plan;
    return {
      ...plan,
      words: plan.words.map((word) =>
        previousIntervals.has(word.id)
          ? { ...word, previousIntervalDays: previousIntervals.get(word.id) }
          : word,
      ),
    };
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
      lastIntervalDays: item.completedAt
        ? (item.bookWord.progress[0]?.lastIntervalDays ?? null)
        : null,
      activeWeaknesses: item.completedAt
        ? item.bookWord.weaknesses.map((signal) => ({
            ...signal,
            remainingCorrect: Math.max(0, MISTAKE_CORRECTION_STREAK - signal.consecutiveCorrect),
          }))
        : [],
      ...(item.contentCache?.isPublic
        ? {
            publicBankMaterial: true,
            questionFeedback:
              item.question && item.completedAt
                ? (item.contentCache.questionFeedbacks.find(
                    (feedback) =>
                      feedback.questionFingerprint === studyQuestionFingerprint(item.question),
                  ) ?? null)
                : null,
          }
        : {}),
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
      generationError: safeStoredGenerationError(plan.generationError),
      generationPhase: plan.status === StudyPlanStatus.GENERATING ? plan.generationPhase : null,
      generationStartedAt:
        plan.status === StudyPlanStatus.GENERATING ? plan.generationStartedAt : null,
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
      normalizeGeneratedLabel(pair.tip).includes(normalizeGeneratedLabel(pair.left)),
    )
  )
    return false;
  return (
    new Set(values.map((pair) => normalizeGeneratedLabel(pair.left))).size === values.length &&
    new Set(values.map((pair) => normalizeGeneratedLabel(pair.right))).size === values.length
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
5. WORD_MNEMONIC 是多选题：英文题干和 4 个英文候选项，围绕可靠的词根、词缀、派生词或形音义联想；correctAnswers 可多项，但每个正确选项只能列一次。解析用中文逐项说明关系，不得编造词源。
6. MEANING_RECOGNITION 是单选题：英文语境题干中必须自然出现目标词；4 个 options 必须是相近、同粒度的中文释义，正确项只对应当前语境，其他项是该词其他义项或合理近义干扰项。
7. WORD_MATCHING 的 prompt 是英文指令，pairs 必须恰有 4 组。left 是包含同一目标词的不同英文短语；right 是中文功能/语义描述，说明使用场景、用途或语义维度；tip 是中文补充说明，仅说明 right 强调的维度，绝不出现 left（即使改变大小写、空格或全角形式）、目标短语关键词或能直接推出答案的词。四组必须唯一配对，options 为空。
8. SYNONYM_REPLACEMENT 是单选题：英文语境题干中标出目标词；4 个 options 都是纯英文候选词或短语。正确项在当前句子的词义、词性、数和搭配上可直接替换；其余项必须是语义相关但不能替换的干扰项。不得附中文释义。
9. READING_COMPREHENSION 是单选题：英文问题和 4 个纯英文选项，必须依据本组英文文章考查目标词相关的细节、词义、推断或主旨，不考文章外知识，也不得附中文释义。
10. 所有题目的正确答案和解析必须与文章、目标词释义一致。explanation 必须使用自然中文，说明语境依据与干扰项为何不成立；界面会单独先展示正确答案，因此 explanation 不要重复答案或输出英文解析。optionNotes 为空数组或省略。
11. 输入分组若包含 targetQuestionTypes，则对应 bookWordId 必须严格生成指定题型；题目必须是新的语境和选项，不能复述历史原题。
12. 每道有选项的题目都必须提供 4 个彼此不同的选项；忽略首尾空白、连续空白、大小写和 Unicode 兼容形式后仍不能相同。`;
}

function parseGeneratedContent(response: unknown): GeneratedContent {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw attachSystemLogDiagnostic(new Error('模型响应缺少 JSON 内容'), {
      code: 'STUDY_RESPONSE_CONTENT_MISSING',
      phase: 'content_parse',
      fieldPath: 'choices[0].message.content',
      reason: '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
    });
  }
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as GeneratedContent;
  } catch {
    throw attachSystemLogDiagnostic(new Error('模型响应不是有效的 JSON 内容'), {
      code: 'STUDY_RESPONSE_CONTENT_INVALID_JSON',
      phase: 'content_parse',
      fieldPath: 'choices[0].message.content',
      reason: '模型接口已响应，但响应正文不是有效 JSON；原始内容已隐藏。',
    });
  }
}

function generationFailureDiagnostic(
  error: unknown,
  phase: SystemLogDiagnosticPhase,
): SystemLogDiagnostic {
  if (error instanceof StudyQuestionValidationError) {
    return {
      code: error.code,
      phase: 'content_validation',
      fieldPath: error.fieldPath,
      reason: '模型返回的学习材料未通过内容校验；原始内容和词条已隐藏。',
    };
  }
  const message = generationErrorText(error);
  const upstreamStatus = /上游 HTTP ([1-5]\d\d)/.exec(message)?.[1];
  if (upstreamStatus) {
    const param = /param: ([A-Za-z0-9_.\[\]-]{1,80})/.exec(message)?.[1];
    return {
      code: 'UPSTREAM_PROVIDER_ERROR',
      phase: 'provider_request',
      fieldPath: param ?? 'request',
      reason: '模型供应商未完成请求；原始响应正文已隐藏。',
    };
  }
  if (message.startsWith('AI Provider 无法连接')) {
    return {
      code: 'AI_PROVIDER_UNREACHABLE',
      phase: 'provider_request',
      fieldPath: 'request',
      reason: '模型供应商连接失败；地址和凭据未记录。',
    };
  }
  if (phase === 'response_parse') {
    return {
      code: 'AI_RESPONSE_JSON_INVALID',
      phase,
      fieldPath: 'response.body',
      reason: '模型接口已响应，但响应正文不是有效 JSON；原始内容已隐藏。',
    };
  }
  if (phase === 'content_parse') {
    return {
      code: 'STUDY_RESPONSE_CONTENT_INVALID',
      phase,
      fieldPath: 'choices[0].message.content',
      reason: '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
    };
  }
  if (phase === 'content_validation') {
    return {
      code: 'STUDY_CONTENT_VALIDATION_FAILED',
      phase,
      fieldPath: generationValidationFieldPath(message),
      reason: '模型返回的学习材料未通过内容校验；原始内容和词条已隐藏。',
    };
  }
  if (phase === 'plan_persistence') {
    return {
      code: 'STUDY_PLAN_SAVE_FAILED',
      phase,
      fieldPath: 'studyPlan.generatedContent',
      reason: '学习材料已校验，但学习计划保存失败；内部异常详情已隐藏。',
    };
  }
  return {
    code: 'STUDY_PLAN_GENERATION_FAILED',
    phase: 'internal',
    fieldPath: 'studyPlan.generation',
    reason: '学习计划生成失败；原始异常详情已隐藏。',
  };
}

function generationValidationFieldPath(message: string) {
  if (/分组数量|组内容不完整/.test(message)) return 'groups';
  if (/逐句翻译|简化文本|语法提示/.test(message)) return 'groups[].sentences';
  if (/题型/.test(message)) return 'groups[].questions[].type';
  if (/纯英文题干/.test(message)) return 'groups[].questions[].prompt';
  if (/解析必须/.test(message)) return 'groups[].questions[].explanation';
  if (/选项/.test(message)) return 'groups[].questions[].options';
  if (/正确答案|可判定答案/.test(message)) return 'groups[].questions[].correctAnswers';
  if (/匹配题/.test(message)) return 'groups[].questions[].pairs';
  if (/阅读材料未包含/.test(message)) return 'groups[].sentences[].english';
  return 'groups[].questions';
}

function safeGenerationFailureMessage(
  error: unknown,
  diagnostic: SystemLogDiagnostic,
  phase: SystemLogDiagnosticPhase,
) {
  const message = generationErrorText(error).trim();
  if (isSafeProviderFailureMessage(message) || isSafeKnownGenerationMessage(message)) {
    return message.slice(0, 500);
  }
  if (diagnostic.code === 'STUDY_CACHE_GENERATION_WAIT_TIMEOUT') {
    return '等待相同公共学习材料超过时限；没有重复发起模型请求，请稍后重试。';
  }
  if (diagnostic.code === 'STUDY_CACHE_GENERATION_COOLDOWN') {
    return '同一公共学习材料刚生成失败，系统正在短暂冷却以避免重复请求；请稍后重试。';
  }
  if (diagnostic.code === 'STUDY_CACHE_CLAIM_LOST') {
    return '公共学习材料协同状态已失效；已停止后续请求，请稍后重试。';
  }
  if (
    phase === 'content_validation' &&
    SAFE_VALIDATION_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return message.slice(0, 500);
  }
  switch (diagnostic.phase) {
    case 'response_parse':
      return '模型接口已响应，但响应正文无法解析；原始内容已隐藏，请稍后重试。';
    case 'content_parse':
      return diagnostic.code === 'STUDY_RESPONSE_CONTENT_INVALID_JSON'
        ? '模型接口已响应，但学习材料内容不是有效 JSON；原始内容已隐藏，请重试。'
        : '模型接口已响应，但未返回预期的学习材料字段；原始内容已隐藏，请重试。';
    case 'content_validation':
      return '模型接口已响应，但学习材料未通过内容校验；原始内容已隐藏，请重试。';
    case 'plan_persistence':
      return '学习材料已生成，但未能保存学习计划；内部异常详情已隐藏，请稍后重试。';
    case 'provider_request':
      return '模型请求未能完成；请检查模型设置。如仍失败，请联系管理员查看错误日志。';
    default:
      return SAFE_GENERATION_FAILURE;
  }
}

function safeStoredGenerationError(value: string | null | undefined) {
  const message = value?.trim();
  if (!message) return null;
  if (
    isSafeProviderFailureMessage(message) ||
    isSafeKnownGenerationMessage(message) ||
    SAFE_VALIDATION_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return message.slice(0, 500);
  }
  return SAFE_GENERATION_FAILURE;
}

function isSafeProviderFailureMessage(message: string) {
  if (
    message === 'AI Provider 无法连接，请检查 AI_BASE_URL 或稍后重试' ||
    message === 'AI Provider 无法连接，请检查模型配置或稍后重试'
  ) {
    return true;
  }
  const match =
    /^(.*?)（上游 HTTP ([1-5]\d\d)(?:；code: ([A-Za-z0-9_-]{1,64}))?(?:；param: ([A-Za-z0-9_.\[\]-]{1,80}))?）$/.exec(
      message,
    );
  return Boolean(
    match &&
    [
      '供应商错误响应过长，已隐藏原文。',
      '接口返回了非 JSON 错误响应；请检查 API 地址是否指向兼容接口。',
      '模型认证未通过，请检查已保存的 API Key 和供应商权限。',
      '接口或模型路由未找到，请检查 API 地址与模型配置。',
      '供应商处理请求超时。',
      '请求被限流或额度策略拒绝。',
      '供应商暂时无法处理请求。',
      '供应商未接受本次请求，请核对模型名称和请求参数。',
    ].includes(match[1]),
  );
}

function isSafeKnownGenerationMessage(message: string) {
  return (
    [
      'AI 服务尚未配置：请在 API 环境变量中设置 AI_API_KEY',
      '请先在阅读材料模型设置中选择可用的大模型',
      '当前默认词书没有带可用释义的未学词；原词条和学习进度未更改，请补充释义或选择其他词表。',
      '自动计划没有可用的已选模型，请在设置模型后重试。',
      '学习计划生成失败；详细错误已隐藏。请稍后重试；如仍失败，请联系管理员查看错误日志。',
      '模型接口已响应，但响应正文无法解析；原始内容已隐藏，请稍后重试。',
      '模型接口已响应，但学习材料内容不是有效 JSON；原始内容已隐藏，请重试。',
      '模型接口已响应，但未返回预期的学习材料字段；原始内容已隐藏，请重试。',
      '模型接口已响应，但学习材料未通过内容校验；原始内容已隐藏，请重试。',
      '学习材料已生成，但未能保存学习计划；内部异常详情已隐藏，请稍后重试。',
      '模型请求未能完成；请检查模型设置。如仍失败，请联系管理员查看错误日志。',
      '模型请求超过单次 90 秒响应时限；请稍后重试。',
      '学习计划生成超过 6 分钟模型请求总时限；请稍后重试。',
    ].includes(message) ||
    /^部分学习材料缺失或未通过内容校验，请先在阅读材料模型设置中选择可用的大模型$/.test(message) ||
    /^\d{1,4} 个词目前没有可用释义，未生成练习内容；计划中的词条和复习排期未更改。补充释义后可重试，或创建其他计划。$/.test(
      message,
    )
  );
}

function generationErrorText(error: unknown) {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const value = (response as { message?: unknown }).message;
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join('；');
    }
  }
  return error instanceof Error ? error.message : '';
}

export function studyGenerationRequestTimeoutMs(deadlineMs: number, nowMs = Date.now()) {
  const remainingMs = deadlineMs - nowMs;
  return remainingMs > 0 ? Math.min(STUDY_GENERATION_REQUEST_TIMEOUT_MS, remainingMs) : 0;
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
      if (!question || !GENERATED_QUESTION_TYPES.has(question.type))
        throw questionValidationError(
          word,
          '的题型不受支持，请重新生成学习计划',
          'STUDY_QUESTION_TYPE_INVALID',
          'groups[].questions[].type',
        );
      if (
        !containsEnglish(question.prompt) ||
        containsChinese(question.prompt) ||
        !Array.isArray(question.correctAnswers)
      )
        throw questionValidationError(
          word,
          '缺少纯英文题干或可判定答案',
          'STUDY_QUESTION_PROMPT_INVALID',
          'groups[].questions[].prompt',
        );
      const targetType = expectedGroup.targetQuestionTypes?.[word.id];
      if (targetType && question.type !== targetType)
        throw questionValidationError(
          word,
          `必须生成 ${targetType} 题型的变式题`,
          'STUDY_QUESTION_TYPE_MISMATCH',
          'groups[].questions[].type',
        );
      if (!containsChinese(question.explanation))
        throw questionValidationError(
          word,
          '的解析必须使用中文',
          'STUDY_QUESTION_EXPLANATION_INVALID',
          'groups[].questions[].explanation',
        );
      const isMatching = question.type === 'WORD_MATCHING';
      const isMnemonic = question.type === 'WORD_MNEMONIC';
      const expectsChineseOptions = question.type === 'MEANING_RECOGNITION';
      if (
        isMatching &&
        (!Array.isArray(question.options) ||
          question.options.length > 0 ||
          question.correctAnswers.length > 0)
      ) {
        throw questionValidationError(
          word,
          '的匹配题只能使用配对内容，不能包含额外选项或答案列表',
          'STUDY_QUESTION_MATCHING_OPTIONS_INVALID',
          'groups[].questions[].options',
        );
      }
      if (!isMatching && (!Array.isArray(question.options) || question.options.length !== 4)) {
        throw questionValidationError(
          word,
          '的选项必须恰有 4 个',
          'STUDY_QUESTION_OPTIONS_COUNT_INVALID',
          'groups[].questions[].options',
        );
      }
      if (
        !isMatching &&
        question.options.some((option) =>
          expectsChineseOptions
            ? !containsChinese(option)
            : !containsEnglish(option) || containsChinese(option),
        )
      ) {
        throw questionValidationError(
          word,
          '的选项语言与题型不符',
          'STUDY_QUESTION_OPTIONS_LANGUAGE_INVALID',
          'groups[].questions[].options',
        );
      }
      if (!isMatching && !hasUniqueOptions(question.options)) {
        throw questionValidationError(
          word,
          '的选项不能重复',
          'STUDY_QUESTION_OPTIONS_DUPLICATE',
          'groups[].questions[].options',
        );
      }
      if (
        (!isMatching &&
          (!question.correctAnswers.length ||
            question.correctAnswers.some((answer) => !question.options.includes(answer)))) ||
        (isMnemonic &&
          new Set(question.correctAnswers.map(normalizeGeneratedLabel)).size !==
            question.correctAnswers.length) ||
        (!isMnemonic && !isMatching && question.correctAnswers.length !== 1)
      ) {
        throw questionValidationError(
          word,
          '的正确答案不符合题型要求',
          'STUDY_QUESTION_ANSWER_INVALID',
          'groups[].questions[].correctAnswers',
        );
      }
      if (question.type === 'WORD_MATCHING' && !hasValidGeneratedMatchingPairs(question.pairs)) {
        throw questionValidationError(
          word,
          '的匹配题必须包含 4 组唯一的中文释义和提示',
          'STUDY_QUESTION_MATCHING_PAIRS_INVALID',
          'groups[].questions[].pairs',
        );
      }
      if (
        question.type === 'WORD_MATCHING' &&
        question.pairs?.some(
          (pair) => !new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'i').test(pair.left),
        )
      ) {
        throw questionValidationError(
          word,
          '的每个匹配短语都必须包含目标词',
          'STUDY_QUESTION_MATCHING_TARGET_MISSING',
          'groups[].questions[].pairs',
        );
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

function questionValidationError(word: PlanWord, suffix: string, code: string, fieldPath: string) {
  return new StudyQuestionValidationError(`单词 ${word.word} ${suffix}`, code, word.id, fieldPath);
}

function normalizeGeneratedContentFormatting(content: GeneratedContent): GeneratedContent {
  if (!Array.isArray(content?.groups)) return content;
  return {
    ...content,
    groups: content.groups.map((group) => ({
      ...group,
      questions: Array.isArray(group.questions)
        ? group.questions.map((question) => normalizeGeneratedQuestionFormatting(question))
        : group.questions,
    })),
  };
}

function normalizeGeneratedQuestionFormatting(question: GeneratedQuestion): GeneratedQuestion {
  if (!Array.isArray(question.options)) return question;
  const normalizedOptions = question.options.map(normalizeOptionWhitespace);
  const optionByNormalizedValue = new Map<string, string>();
  question.options.forEach((option, index) => {
    if (typeof option === 'string') {
      const key = normalizeGeneratedLabel(option);
      if (key && !optionByNormalizedValue.has(key)) {
        optionByNormalizedValue.set(key, normalizedOptions[index]);
      }
    }
  });
  const correctAnswers = Array.isArray(question.correctAnswers)
    ? question.correctAnswers.map((answer) => {
        if (typeof answer !== 'string') return answer;
        return (
          optionByNormalizedValue.get(normalizeGeneratedLabel(answer)) ??
          normalizeOptionWhitespace(answer)
        );
      })
    : question.correctAnswers;
  return {
    ...question,
    options: normalizedOptions,
    correctAnswers,
    ...(Array.isArray(question.optionNotes)
      ? { optionNotes: question.optionNotes.map(normalizeOptionWhitespace) }
      : {}),
  };
}

function normalizeOptionWhitespace(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : (value as string);
}

type RepairableQuestion = {
  error: StudyQuestionValidationError;
  word: PlanWord;
  group: GeneratedGroup;
  question: GeneratedQuestion;
  attempt: number;
};

type GeneratedContentRepairOptions = {
  onRepairAttempt: (attempt: number) => Promise<void>;
  repairQuestion: (input: RepairableQuestion) => Promise<GeneratedQuestion>;
};

export async function validateAndRepairGeneratedContent(
  input: GeneratedContent,
  expected: Array<{
    index: number;
    words: PlanWord[];
    targetQuestionTypes?: Record<string, string>;
  }>,
  options: GeneratedContentRepairOptions,
): Promise<{ content: GeneratedContent; attempts: number }> {
  const content = normalizeGeneratedContentFormatting(input);
  let attempts = 0;
  while (true) {
    try {
      validateGeneratedContent(content, expected);
      return { content, attempts };
    } catch (error) {
      if (!(error instanceof StudyQuestionValidationError)) throw error;
      if (attempts >= MAX_STUDY_QUESTION_REPAIR_ATTEMPTS) throw error;
      const expectedGroup = expected.find((group) =>
        group.words.some((word) => word.id === error.bookWordId),
      );
      const group = content.groups.find((candidate) => candidate.index === expectedGroup?.index);
      const word = expectedGroup?.words.find((candidate) => candidate.id === error.bookWordId);
      const question = group?.questions.find(
        (candidate) => candidate.bookWordId === error.bookWordId,
      );
      if (!expectedGroup || !group || !word || !question) throw error;
      attempts += 1;
      await options.onRepairAttempt(attempts);
      const repaired = await options.repairQuestion({
        error,
        word,
        group,
        question,
        attempt: attempts,
      });
      if (repaired.bookWordId !== word.id) {
        throw attachSystemLogDiagnostic(new Error('单题修复返回了不匹配的词条标识'), {
          code: 'STUDY_QUESTION_REPAIR_TARGET_MISMATCH',
          phase: 'content_parse',
          fieldPath: 'groups[].questions',
          reason: '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
        });
      }
      group.questions = group.questions.map((candidate) =>
        candidate.bookWordId === word.id ? repaired : candidate,
      );
      const formatted = normalizeGeneratedQuestionFormatting(repaired);
      group.questions = group.questions.map((candidate) =>
        candidate.bookWordId === word.id ? formatted : candidate,
      );
    }
  }
}

function safeQuestionRepairIssue(code: string) {
  const issues: Record<string, string> = {
    STUDY_QUESTION_OPTIONS_COUNT_INVALID: '选项数量错误',
    STUDY_QUESTION_OPTIONS_LANGUAGE_INVALID: '选项语言不符合指定题型',
    STUDY_QUESTION_OPTIONS_DUPLICATE: '选项经空白与 Unicode 兼容形式归一后仍须唯一',
    STUDY_QUESTION_ANSWER_INVALID: '正确答案必须与选项严格对应且数量符合题型',
    STUDY_QUESTION_EXPLANATION_INVALID: '解析必须使用中文',
    STUDY_QUESTION_PROMPT_INVALID: '题干必须是纯英文且含可判定答案',
    STUDY_QUESTION_TYPE_INVALID: '题型不受支持',
    STUDY_QUESTION_TYPE_MISMATCH: '题型必须符合既定题型',
    STUDY_QUESTION_MATCHING_OPTIONS_INVALID: '匹配题不可提供额外选项或答案列表',
    STUDY_QUESTION_MATCHING_PAIRS_INVALID: '匹配题必须提供四组唯一且符合语言要求的配对',
    STUDY_QUESTION_MATCHING_TARGET_MISSING: '每个匹配短语都必须包含目标词',
  };
  return issues[code] ?? '此题未通过内容校验';
}

export function questionRepairPrompt(input: {
  word: PlanWord;
  targetQuestionType?: string;
  sentenceContext: string[];
  question: GeneratedQuestion;
  issue: string;
  attempt: number;
}) {
  const questionRules =
    input.question.type === 'WORD_MATCHING'
      ? 'pairs 必须恰好 4 组且配对唯一，left 均含目标词；options 和 correctAnswers 必须为空数组。'
      : input.question.type === 'WORD_MNEMONIC'
        ? '提供恰好 4 个互不重复的纯英文 options；correctAnswers 可多项但至少一项，且每项必须与 options 原文一致、不重复；不编造词源。'
        : '提供恰好 4 个互不重复的选项和恰好 1 个与选项原文完全一致的 correctAnswers；' +
          (input.question.type === 'MEANING_RECOGNITION'
            ? '所有 options 都是中文释义。'
            : '所有 options 都是纯英文词或短语。');
  return (
    `只修复一题，不重新生成整组或其他内容。请只返回 JSON 对象，结构为 {"questions":[单个题目]}。\n` +
    `目标词条：${JSON.stringify(input.word)}\n` +
    `指定题型：${input.targetQuestionType ?? input.question.type}；必须保持题型 ${input.targetQuestionType ?? input.question.type}。\n` +
    `本组原有英文句子（仅作语境，不要改写）：${JSON.stringify(input.sentenceContext)}\n` +
    `待修题目：${JSON.stringify(input.question)}\n` +
    `校验问题：${input.issue}\n` +
    `这是本次计划第 ${input.attempt} 次局部修复。保留 bookWordId=${input.word.id} 和原题型 ${input.question.type}，不得改变题型。题型规则：${questionRules} 题干使用自然英文，解析使用中文；题目必须符合给定释义和语境，不增加无法支持的答案。不要返回分组、句子或其他题目。`
  );
}

function parseGeneratedQuestionRepair(
  response: unknown,
  expectedBookWordId: string,
): GeneratedQuestion {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw attachSystemLogDiagnostic(new Error('模型单题修复缺少 JSON 内容'), {
      code: 'STUDY_QUESTION_REPAIR_CONTENT_MISSING',
      phase: 'content_parse',
      fieldPath: 'choices[0].message.content',
      reason: '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      content
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    );
  } catch {
    throw attachSystemLogDiagnostic(new Error('模型单题修复不是有效 JSON'), {
      code: 'STUDY_QUESTION_REPAIR_INVALID_JSON',
      phase: 'content_parse',
      fieldPath: 'choices[0].message.content',
      reason: '模型接口已响应，但响应正文不是有效 JSON；原始内容已隐藏。',
    });
  }
  const questions =
    typeof parsed === 'object' && parsed !== null && 'questions' in parsed
      ? (parsed as { questions?: unknown }).questions
      : undefined;
  if (
    !Array.isArray(questions) ||
    questions.length !== 1 ||
    typeof questions[0] !== 'object' ||
    questions[0] === null ||
    !('bookWordId' in questions[0]) ||
    (questions[0] as { bookWordId?: unknown }).bookWordId !== expectedBookWordId
  ) {
    throw attachSystemLogDiagnostic(new Error('模型单题修复未返回指定题目'), {
      code: 'STUDY_QUESTION_REPAIR_TARGET_MISMATCH',
      phase: 'content_parse',
      fieldPath: 'groups[].questions',
      reason: '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
    });
  }
  return questions[0] as GeneratedQuestion;
}

export { unfamiliarityScore };

function hasUniqueOptions(options: unknown): boolean {
  if (!Array.isArray(options)) return false;
  const normalized = options.map(normalizeGeneratedLabel);
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length;
}

function normalizeGeneratedLabel(value: unknown) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
    : '';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type PlanWordPick = { orderedIds: string[]; reviewIds: string[] };

function sanitizeSkipReviewIds(ids: string[] | undefined) {
  if (!ids?.length) return [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= 40) break;
  }
  return next;
}

function skippedReviewClause(ids: string[]) {
  return ids.length
    ? Prisma.sql`AND progress."bookWordId" NOT IN (${Prisma.join(ids)})`
    : Prisma.empty;
}

async function selectDailyWords(
  tx: Prisma.TransactionClient,
  userId: string,
  newWordCount: number,
  requestedReviewWordCount?: number,
  skipReviewWordIds: string[] = [],
): Promise<PlanWordPick> {
  const [review, defaultBook] = await Promise.all([
    tx.$queryRaw<Array<{ bookWordId: string }>>(Prisma.sql`
      SELECT progress."bookWordId" AS "bookWordId"
      FROM "UserWordProgress" AS progress
      JOIN "VocabularyBookWord" AS bw ON bw."id" = progress."bookWordId"
      JOIN "VocabularyWord" AS w ON w."id" = bw."wordId"
      WHERE progress."userId" = ${userId}
        AND progress."state" = ${WordProgressState.REVIEWING}::"WordProgressState"
        AND progress."nextReviewAt" <= ${new Date()}
        AND NOT EXISTS (
          SELECT 1 FROM "UserMasteredWord" AS mastered
          WHERE mastered."userId" = ${userId} AND mastered."wordId" = w."id"
        )
        AND ${usableBookWordMeaning}
        ${skippedReviewClause(skipReviewWordIds)}
      ORDER BY progress."nextReviewAt" ASC, progress."lastReviewedAt" ASC, progress."bookWordId" ASC
      LIMIT ${requestedReviewWordCount ?? MAX_DAILY_REVIEW_WORDS}
    `),
    tx.userVocabularyBook.findFirst({
      where: { userId, isDefault: true },
      select: { bookId: true },
    }),
  ]);
  const reviewIds = review.map((item) => item.bookWordId);
  const newWords = defaultBook
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT bw."id" AS "id"
        FROM "VocabularyBookWord" AS bw
        JOIN "VocabularyWord" AS w ON w."id" = bw."wordId"
        WHERE bw."bookId" = ${defaultBook.bookId}
          AND NOT EXISTS (
            SELECT 1 FROM "UserWordProgress" AS progress
            WHERE progress."userId" = ${userId} AND progress."bookWordId" = bw."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "UserMasteredWord" AS mastered
            WHERE mastered."userId" = ${userId} AND mastered."wordId" = w."id"
          )
          AND ${usableBookWordMeaning}
        ORDER BY bw."position" ASC, bw."id" ASC
        LIMIT ${newWordCount}
      `)
    : [];
  const newIds = newWords.map((item) => item.id).filter((id) => !reviewIds.includes(id));
  return { orderedIds: [...reviewIds, ...newIds], reviewIds };
}

async function selectIndividualWords(
  tx: Prisma.TransactionClient,
  userId: string,
  selection: IndividualWordSelection,
  count: number,
  skipReviewWordIds: string[] = [],
): Promise<PlanWordPick> {
  if (selection === 'due') {
    const limit = Math.min(count, DUE_DRILL_WORD_LIMIT);
    const rows = await tx.$queryRaw<Array<{ bookWordId: string }>>(Prisma.sql`
      SELECT progress."bookWordId" AS "bookWordId"
      FROM "UserWordProgress" AS progress
      JOIN "VocabularyBookWord" AS bw ON bw."id" = progress."bookWordId"
      JOIN "VocabularyWord" AS w ON w."id" = bw."wordId"
      WHERE progress."userId" = ${userId}
        AND progress."state" = ${WordProgressState.REVIEWING}::"WordProgressState"
        AND progress."nextReviewAt" <= ${new Date()}
        AND NOT EXISTS (
          SELECT 1 FROM "UserMasteredWord" AS mastered
          WHERE mastered."userId" = ${userId} AND mastered."wordId" = w."id"
        )
        AND ${usableBookWordMeaning}
        ${skippedReviewClause(skipReviewWordIds)}
      ORDER BY progress."nextReviewAt" ASC, progress."lastReviewedAt" ASC, progress."bookWordId" ASC
      LIMIT ${limit}
    `);
    const ids = rows.map((row) => row.bookWordId);
    if (!ids.length) {
      throw new BadRequestException(
        '今天没有带可用释义的到期词；未创建快练，复习排期未更改。可以先完成一组学习，或等已安排的复习到期。',
      );
    }
    return { orderedIds: ids, reviewIds: ids };
  }

  if (selection === 'mistakes') {
    const signals = await tx.$queryRaw<Array<{ bookWordId: string }>>(Prisma.sql`
      WITH ranked_signals AS (
        SELECT
          signal."bookWordId",
          signal."wrongCount",
          signal."lastWrongAt",
          ROW_NUMBER() OVER (
            PARTITION BY signal."bookWordId"
            ORDER BY signal."wrongCount" DESC, signal."lastWrongAt" DESC, signal."questionType" ASC
          ) AS word_rank
        FROM "WeaknessSignal" AS signal
        JOIN "VocabularyBookWord" AS bw ON bw."id" = signal."bookWordId"
        JOIN "VocabularyWord" AS w ON w."id" = bw."wordId"
        WHERE signal."userId" = ${userId}
          AND signal."status" = ${WeaknessStatus.ACTIVE}::"WeaknessStatus"
          AND NOT EXISTS (
            SELECT 1 FROM "UserMasteredWord" AS mastered
            WHERE mastered."userId" = ${userId} AND mastered."wordId" = w."id"
          )
          AND ${usableBookWordMeaning}
      )
      SELECT "bookWordId"
      FROM ranked_signals
      WHERE word_rank = 1
      ORDER BY "wrongCount" DESC, "lastWrongAt" DESC, "bookWordId" ASC
      LIMIT ${count}
    `);
    const ids = signals.map((item) => item.bookWordId);
    if (!ids.length) {
      throw new BadRequestException(
        '错题来源当前没有带可用释义的待练习词；原错题和复习排期未更改，请补充释义或选择其他来源。',
      );
    }
    return { orderedIds: ids, reviewIds: ids };
  }

  const defaultBook = await tx.userVocabularyBook.findFirst({
    where: { userId, isDefault: true },
    select: { bookId: true },
  });
  if (!defaultBook) throw new BadRequestException('请先选择一本默认词书');

  let ids: string[] = [];
  if (selection === 'book') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT bw."id" AS "id"
      FROM "VocabularyBookWord" AS bw
      JOIN "VocabularyWord" AS w ON w."id" = bw."wordId"
      WHERE bw."bookId" = ${defaultBook.bookId}
        AND NOT EXISTS (
          SELECT 1 FROM "UserWordProgress" AS progress
          WHERE progress."userId" = ${userId} AND progress."bookWordId" = bw."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "UserMasteredWord" AS mastered
          WHERE mastered."userId" = ${userId} AND mastered."wordId" = w."id"
        )
        AND ${usableBookWordMeaning}
      ORDER BY bw."position" ASC, bw."id" ASC
      LIMIT ${count}
    `);
    ids = rows.map((row) => row.id);
    if (!ids.length) {
      throw new BadRequestException(
        '当前默认词书没有带可用释义的未学词；原词条和学习进度未更改，请补充释义或选择其他词表。',
      );
    }
    return { orderedIds: ids, reviewIds: [] };
  }

  if (selection === 'random') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT bw.id
      FROM "VocabularyBookWord" bw
      JOIN "VocabularyWord" w ON w.id = bw."wordId"
      WHERE bw."bookId" = ${defaultBook.bookId}
        AND ${usableBookWordMeaning}
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
        AND ${usableBookWordMeaning}
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
  if (!ids.length) {
    throw new BadRequestException(
      '当前默认词书没有带可用释义的待练习词；原词条和学习进度未更改，请补充释义或选择其他来源。',
    );
  }
  const progressed = await tx.userWordProgress.findMany({
    where: { userId, bookWordId: { in: ids } },
    select: { bookWordId: true },
  });
  const reviewIds = progressed.map((item) => item.bookWordId);
  return { orderedIds: ids, reviewIds };
}
