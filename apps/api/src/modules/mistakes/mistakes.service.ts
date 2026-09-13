import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StudyPlanItemSource, StudyPlanMode, StudyPlanPurpose, StudyPlanStatus, WeaknessStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type Transaction = Prisma.TransactionClient;
type ListQuery = { status?: 'active' | 'ignored' | 'resolved'; questionType?: string; page?: number; pageSize?: number };

@Injectable()
export class MistakesService {
  constructor(private readonly prisma: PrismaService) {}

  async recordAttempt(tx: Transaction, input: { userId: string; bookWordId: string; questionType: string; isCorrect: boolean; at?: Date }) {
    const at = input.at ?? new Date();
    const key = { userId_bookWordId_questionType: { userId: input.userId, bookWordId: input.bookWordId, questionType: input.questionType } };
    const existing = await tx.weaknessSignal.findUnique({ where: key });
    if (!existing) {
      if (input.isCorrect) return;
      await tx.weaknessSignal.create({ data: { userId: input.userId, bookWordId: input.bookWordId, questionType: input.questionType, lastWrongAt: at, lastAttemptAt: at } });
      return;
    }
    if (!input.isCorrect) {
      await tx.weaknessSignal.update({ where: key, data: { status: WeaknessStatus.ACTIVE, wrongCount: { increment: 1 }, consecutiveCorrect: 0, lastWrongAt: at, lastAttemptAt: at, resolvedAt: null, ignoredAt: null } });
      return;
    }
    const consecutiveCorrect = existing.consecutiveCorrect + 1;
    await tx.weaknessSignal.update({ where: key, data: { consecutiveCorrect, lastAttemptAt: at, ...(consecutiveCorrect >= 2 ? { status: WeaknessStatus.RESOLVED, resolvedAt: at, ignoredAt: null } : {}) } });
  }

  async list(userId: string, query: ListQuery) {
    const status = (query.status ?? 'active').toUpperCase() as WeaknessStatus;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
    const where: Prisma.WeaknessSignalWhereInput = { userId, status, ...(query.questionType ? { questionType: query.questionType } : {}) };
    const [rankedWords, totals] = await Promise.all([
      this.prisma.weaknessSignal.groupBy({
        by: ['bookWordId'],
        where,
        orderBy: [
          { _min: { consecutiveCorrect: 'asc' } },
          { _max: { wrongCount: 'desc' } },
          { _max: { lastWrongAt: 'desc' } },
          { bookWordId: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "bookWordId")::int AS "count"
        FROM "WeaknessSignal"
        WHERE "userId" = ${userId}
          AND "status" = CAST(${status} AS "WeaknessStatus")
          ${query.questionType ? Prisma.sql`AND "questionType" = ${query.questionType}` : Prisma.empty}
      `),
    ]);
    const bookWordIds = rankedWords.map(item => item.bookWordId);
    const signals = await this.prisma.weaknessSignal.findMany({
      where: { ...where, bookWordId: { in: bookWordIds } },
      orderBy: [{ consecutiveCorrect: 'asc' }, { wrongCount: 'desc' }, { lastWrongAt: 'desc' }],
      include: { bookWord: { include: { word: true, book: true } } },
    });
    const grouped = new Map<string, typeof signals>();
    for (const signal of signals) grouped.set(signal.bookWordId, [...(grouped.get(signal.bookWordId) ?? []), signal]);
    const selected = bookWordIds.map(id => grouped.get(id)).filter((group): group is typeof signals => Boolean(group?.length));
    const total = totals[0]?.count ?? 0;
    return {
      items: selected.map(group => ({
        bookWordId: group[0].bookWordId,
        word: group[0].bookWord.word.text,
        part: part(group[0].bookWord.word.meaning),
        meaning: meaning(group[0].bookWord.word.meaning),
        bookTitle: group[0].bookWord.book.title,
        severity: Math.max(...group.map(item => Math.min(100, item.wrongCount * 18 + (item.consecutiveCorrect ? 5 : 20)))),
        lastWrongAt: group.reduce((latest, item) => item.lastWrongAt > latest ? item.lastWrongAt : latest, group[0].lastWrongAt),
        weaknesses: group.map(this.serializeSignal),
      })),
      page, pageSize, total, hasMore: page * pageSize < total,
    };
  }

  async detail(userId: string, id: string) {
    const signal = await this.prisma.weaknessSignal.findFirst({ where: { id, userId }, include: { bookWord: { include: { word: true, book: true } } } });
    if (!signal) throw new NotFoundException('薄弱项不存在');
    const attempts = await this.prisma.wordReviewAttempt.findMany({ where: { userId, bookWordId: signal.bookWordId, questionType: signal.questionType }, orderBy: { createdAt: 'desc' }, take: 50, include: { item: true } });
    return {
      ...this.serializeSignal(signal), bookWordId: signal.bookWordId, word: signal.bookWord.word.text,
      part: part(signal.bookWord.word.meaning), meaning: meaning(signal.bookWord.word.meaning), bookTitle: signal.bookWord.book.title,
      attempts: attempts.map(attempt => ({ id: attempt.id, isCorrect: attempt.isCorrect, selectedAnswer: attempt.selectedAnswer, responseTimeMs: attempt.responseTimeMs, createdAt: attempt.createdAt, question: attempt.item?.question ?? null })),
    };
  }

  async setStatus(userId: string, id: string, status: 'ACTIVE' | 'IGNORED') {
    const signal = await this.prisma.weaknessSignal.findFirst({ where: { id, userId } });
    if (!signal) throw new NotFoundException('薄弱项不存在');
    if (signal.status === WeaknessStatus.RESOLVED) throw new BadRequestException('已纠正的薄弱项不能手动修改状态');
    return this.prisma.weaknessSignal.update({ where: { id }, data: { status, ignoredAt: status === 'IGNORED' ? new Date() : null } });
  }

  async createPracticePlan(userId: string, requestedBookWordIds: string[]) {
    const bookWordIds = [...new Set(requestedBookWordIds)];
    if (bookWordIds.length !== requestedBookWordIds.length) throw new BadRequestException('薄弱词不能重复');
    const planId = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`weakness-plan:${userId}`}))`);
      const existing = await tx.studyPlan.findFirst({
        where: { userId, purpose: StudyPlanPurpose.WEAKNESS, status: { in: [StudyPlanStatus.GENERATING, StudyPlanStatus.ACTIVE, StudyPlanStatus.FAILED] } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return existing.id;
      const signals = await tx.weaknessSignal.findMany({ where: { userId, status: WeaknessStatus.ACTIVE, bookWordId: { in: bookWordIds } }, orderBy: [{ consecutiveCorrect: 'asc' }, { wrongCount: 'desc' }, { lastWrongAt: 'desc' }] });
      const selected = bookWordIds.map(bookWordId => signals.find(signal => signal.bookWordId === bookWordId)).filter(Boolean) as typeof signals;
      if (selected.length !== bookWordIds.length) throw new BadRequestException('所选单词不再是待巩固状态，请刷新后重试');
      const plan = await tx.studyPlan.create({ data: { userId, purpose: StudyPlanPurpose.WEAKNESS, mode: StudyPlanMode.GROUP, status: StudyPlanStatus.GENERATING } });
      await tx.studyPlanItem.createMany({ data: selected.map((signal, index) => ({ planId: plan.id, bookWordId: signal.bookWordId, source: StudyPlanItemSource.REVIEW, groupIndex: Math.floor(index / 3), targetQuestionType: signal.questionType })) });
      return plan.id;
    });
    return this.serializePracticePlan(userId, planId);
  }

  private serializeSignal = (signal: { id: string; questionType: string; status: WeaknessStatus; wrongCount: number; consecutiveCorrect: number; lastWrongAt: Date; lastAttemptAt: Date; resolvedAt: Date | null; ignoredAt: Date | null }) => ({
    id: signal.id, questionType: signal.questionType, status: signal.status.toLowerCase(), wrongCount: signal.wrongCount, consecutiveCorrect: signal.consecutiveCorrect,
    lastWrongAt: signal.lastWrongAt, lastAttemptAt: signal.lastAttemptAt, resolvedAt: signal.resolvedAt, ignoredAt: signal.ignoredAt,
  });

  private async serializePracticePlan(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findFirstOrThrow({ where: { id: planId, userId }, include: { items: { orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }], include: { bookWord: { include: { word: true } } } } } });
    return {
      id: plan.id, mode: plan.mode.toLowerCase(), purpose: plan.purpose.toLowerCase(), status: plan.status, createdAt: plan.createdAt,
      wordCount: plan.items.length, completed: plan.items.filter(item => item.completedAt).length,
      groupCount: new Set(plan.items.map(item => item.groupIndex)).size, content: plan.generatedContent,
      words: plan.items.map(item => ({ id: item.bookWordId, word: item.bookWord.word.text, part: part(item.bookWord.word.meaning), meaning: meaning(item.bookWord.word.meaning), source: item.source, groupIndex: item.groupIndex, targetQuestionType: item.targetQuestionType, completed: Boolean(item.completedAt) })),
    };
  }
}

function part(value: string | null) { return value?.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i)?.[1] ?? ''; }
function meaning(value: string | null) { const raw = value ?? '暂无释义'; return raw.slice(raw.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i)?.[0].length ?? 0); }
