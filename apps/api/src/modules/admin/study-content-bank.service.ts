import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StudyPlanMode } from '@prisma/client';
import { studyQuestionFingerprint } from '../study/study-content-bank';
import { PrismaService } from '../../prisma/prisma.service';

export type StudyContentBankFilters = {
  page?: number;
  pageSize?: number;
  status?: 'active' | 'disabled' | 'all';
  mode?: StudyPlanMode;
  from?: string;
  to?: string;
  search?: string;
  feedback?: 'all' | 'negative';
};

type BankQuestion = Record<string, unknown> & { bookWordId?: string };
type BankMaterial = Record<string, unknown> & { questions?: BankQuestion[] };
type VoteAggregate = {
  contentCacheId: string;
  questionFingerprint: string;
  questionSnapshot: Prisma.JsonValue;
  rating: 'UP' | 'DOWN';
  reason: string | null;
  count: bigint;
  lastUpdatedAt: Date;
};
type HistoricalQuestionFeedback = {
  question: BankQuestion;
  feedback: { up: number; down: number; reasonCounts: Record<string, number> };
  lastUpdatedAt: Date;
};
const MAX_HISTORICAL_NEGATIVE_QUESTIONS = 10;

function questionsFromMaterial(material: Prisma.JsonValue): BankQuestion[] {
  if (!material || typeof material !== 'object' || Array.isArray(material)) return [];
  const questions = (material as BankMaterial).questions;
  return Array.isArray(questions)
    ? questions.filter(
        (question): question is BankQuestion =>
          Boolean(question) && typeof question === 'object' && !Array.isArray(question),
      )
    : [];
}

function dateBoundary(value: string, addDay = false) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new BadRequestException('题库日期筛选无效');
  if (addDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function validateRange(from?: string, to?: string) {
  for (const value of [from, to]) {
    if (value && dateBoundary(value).toISOString().slice(0, 10) !== value) {
      throw new BadRequestException('题库日期筛选无效');
    }
  }
  if (from && to && from > to) throw new BadRequestException('开始日期不能晚于结束日期');
}

@Injectable()
export class StudyContentBankService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: StudyContentBankFilters = {}) {
    validateRange(filters.from, filters.to);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, filters.pageSize ?? 20));
    const clauses: Prisma.Sql[] = [Prisma.sql`"isPublic" = TRUE`];
    if (filters.status === 'active') clauses.push(Prisma.sql`"isActive" = TRUE`);
    if (filters.status === 'disabled') clauses.push(Prisma.sql`"isActive" = FALSE`);
    if (filters.mode) clauses.push(Prisma.sql`"mode" = ${filters.mode}::"StudyPlanMode"`);
    if (filters.from) clauses.push(Prisma.sql`"createdAt" >= ${dateBoundary(filters.from)}`);
    if (filters.to) clauses.push(Prisma.sql`"createdAt" < ${dateBoundary(filters.to, true)}`);
    if (filters.feedback === 'negative') {
      clauses.push(Prisma.sql`EXISTS (
        SELECT 1
        FROM "public"."StudyContentQuestionFeedback" AS feedback
        WHERE feedback."contentCacheId" = "public"."StudyContentCache"."id"
          AND feedback."rating" = 'DOWN'::"StudyContentFeedbackRating"
      )`);
    }
    const search = filters.search?.trim();
    if (search) {
      const pattern = `%${search}%`;
      clauses.push(Prisma.sql`("material"::text ILIKE ${pattern} OR "signature" ILIKE ${pattern})`);
    }
    const where = Prisma.join(clauses, ' AND ');
    const rows = await this.prisma.$queryRaw<Array<{ id: string; total: bigint }>>(Prisma.sql`
      SELECT "id", COUNT(*) OVER() AS "total"
      FROM "public"."StudyContentCache"
      WHERE ${where}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `);
    const ids = rows.map((row) => row.id);
    const total =
      rows[0]?.total ??
      (
        await this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "total"
          FROM "public"."StudyContentCache"
          WHERE ${where}
        `)
      )[0]?.total ??
      0n;
    const [caches, quarantinedCount] = await Promise.all([
      ids.length
        ? this.prisma.studyContentCache.findMany({
            where: { id: { in: ids }, isPublic: true },
            select: {
              id: true,
              mode: true,
              material: true,
              hitCount: true,
              isActive: true,
              disabledAt: true,
              disabledReason: true,
              createdAt: true,
              updatedAt: true,
              _count: { select: { planItems: true } },
            },
          })
        : Promise.resolve([]),
      this.prisma.studyContentCache.count({ where: { isPublic: false } }),
    ]);
    const cacheById = new Map(caches.map((cache) => [cache.id, cache]));
    const orderedCaches = ids.flatMap((id) => {
      const cache = cacheById.get(id);
      return cache ? [cache] : [];
    });
    const aggregates = ids.length
      ? await this.prisma.$queryRaw<VoteAggregate[]>(Prisma.sql`
          SELECT "contentCacheId", "questionFingerprint", "questionSnapshot",
                 "rating"::text AS "rating", "reason"::text AS "reason",
                 COUNT(*)::bigint AS "count", MAX("updatedAt") AS "lastUpdatedAt"
          FROM "public"."StudyContentQuestionFeedback"
          WHERE "contentCacheId" IN (${Prisma.join(ids)})
          GROUP BY "contentCacheId", "questionFingerprint", "questionSnapshot", "rating", "reason"
        `)
      : [];
    const aggregatesByQuestion = new Map<string, VoteAggregate[]>();
    const historicalByCache = new Map<string, Map<string, HistoricalQuestionFeedback>>();
    const currentQuestionFingerprints = new Map(
      orderedCaches.map((cache) => [
        cache.id,
        new Set(questionsFromMaterial(cache.material).map(studyQuestionFingerprint)),
      ]),
    );
    const feedbackByCache = new Map<
      string,
      { current: { up: number; down: number }; older: { up: number; down: number } }
    >();
    for (const aggregate of aggregates) {
      const key = `${aggregate.contentCacheId}:${aggregate.questionFingerprint}`;
      const values = aggregatesByQuestion.get(key) ?? [];
      values.push(aggregate);
      aggregatesByQuestion.set(key, values);
      const summary = feedbackByCache.get(aggregate.contentCacheId) ?? {
        current: { up: 0, down: 0 },
        older: { up: 0, down: 0 },
      };
      const isCurrent = currentQuestionFingerprints
        .get(aggregate.contentCacheId)
        ?.has(aggregate.questionFingerprint);
      const snapshot = isCurrent ? summary.current : summary.older;
      snapshot[aggregate.rating === 'UP' ? 'up' : 'down'] += Number(aggregate.count);
      feedbackByCache.set(aggregate.contentCacheId, summary);

      if (!isCurrent) {
        const questionSnapshot = aggregate.questionSnapshot;
        if (
          !questionSnapshot ||
          typeof questionSnapshot !== 'object' ||
          Array.isArray(questionSnapshot)
        ) {
          continue;
        }
        const olderQuestions = historicalByCache.get(aggregate.contentCacheId) ?? new Map();
        const historical = olderQuestions.get(aggregate.questionFingerprint) ?? {
          question: questionSnapshot as BankQuestion,
          feedback: { up: 0, down: 0, reasonCounts: {} },
          lastUpdatedAt: aggregate.lastUpdatedAt,
        };
        historical.feedback[aggregate.rating === 'UP' ? 'up' : 'down'] += Number(aggregate.count);
        if (aggregate.rating === 'DOWN' && aggregate.reason) {
          historical.feedback.reasonCounts[aggregate.reason] =
            (historical.feedback.reasonCounts[aggregate.reason] ?? 0) + Number(aggregate.count);
        }
        if (aggregate.lastUpdatedAt > historical.lastUpdatedAt) {
          historical.lastUpdatedAt = aggregate.lastUpdatedAt;
          historical.question = questionSnapshot as BankQuestion;
        }
        olderQuestions.set(aggregate.questionFingerprint, historical);
        historicalByCache.set(aggregate.contentCacheId, olderQuestions);
      }
    }

    return {
      page,
      pageSize,
      total: Number(total),
      quarantinedCount,
      items: orderedCaches.map((cache) => {
        return {
          id: cache.id,
          mode: cache.mode,
          material: cache.material,
          reuseHits: cache.hitCount,
          planReferences: cache._count.planItems,
          isActive: cache.isActive,
          disabledAt: cache.disabledAt,
          disabledReason: cache.disabledReason,
          createdAt: cache.createdAt,
          updatedAt: cache.updatedAt,
          provenance: '生成模型来源未记录（题库未保存该字段）',
          feedbackSummary: feedbackByCache.get(cache.id) ?? {
            current: { up: 0, down: 0 },
            older: { up: 0, down: 0 },
          },
          historicalNegativeQuestionCount: Array.from(
            historicalByCache.get(cache.id)?.values() ?? [],
          ).filter((item) => item.feedback.down > 0).length,
          historicalNegativeQuestions: Array.from(historicalByCache.get(cache.id)?.values() ?? [])
            .filter((item) => item.feedback.down > 0)
            .sort((first, second) => second.lastUpdatedAt.getTime() - first.lastUpdatedAt.getTime())
            .slice(0, MAX_HISTORICAL_NEGATIVE_QUESTIONS)
            .map(({ question, feedback, lastUpdatedAt }) => ({
              question,
              feedback,
              lastUpdatedAt: lastUpdatedAt.toISOString(),
            })),
          questions: questionsFromMaterial(cache.material).map((question) => {
            const fingerprint = studyQuestionFingerprint(question);
            const votes = aggregatesByQuestion.get(`${cache.id}:${fingerprint}`) ?? [];
            const reasonCounts: Record<string, number> = {};
            let up = 0;
            let down = 0;
            for (const vote of votes) {
              const count = Number(vote.count);
              if (vote.rating === 'UP') up += count;
              else down += count;
              if (vote.rating === 'DOWN' && vote.reason) {
                reasonCounts[vote.reason] = (reasonCounts[vote.reason] ?? 0) + count;
              }
            }
            return { ...question, feedback: { up, down, reasonCounts } };
          }),
        };
      }),
    };
  }

  async setActive(id: string, isActive: boolean, reason: string | undefined, adminUserId: string) {
    const cleanReason = reason
      ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const result = await this.prisma.studyContentCache.updateMany({
      where: { id, isPublic: true },
      data: isActive
        ? { isActive: true, disabledAt: null, disabledReason: null, disabledByUserId: null }
        : {
            isActive: false,
            disabledAt: new Date(),
            disabledReason: cleanReason || '管理员停用',
            disabledByUserId: adminUserId,
          },
    });
    if (!result.count) throw new NotFoundException('公共题库材料不存在');
    return this.prisma.studyContentCache.findUniqueOrThrow({
      where: { id },
      select: { id: true, isPublic: true, isActive: true, disabledAt: true, disabledReason: true },
    });
  }
}
