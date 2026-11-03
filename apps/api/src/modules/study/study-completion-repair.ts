import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, ProgressivePracticeStage } from '@prisma/client';
import { lockUserWordProgress } from './user-word-progress-lock';
import { hasInvalidStoredAnswerKey } from './answer-key-integrity';

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function selectionBelongs(
  question: Prisma.JsonValue | null,
  type: string | null,
  selected: Prisma.JsonValue | null,
) {
  if (
    hasInvalidStoredAnswerKey(question) ||
    !question ||
    typeof question !== 'object' ||
    Array.isArray(question) ||
    question.type !== type ||
    !Array.isArray(selected) ||
    !selected.length ||
    selected.some((value) => typeof value !== 'string') ||
    new Set(selected).size !== selected.length
  )
    return false;
  const answers = selected as string[];
  if (type !== 'WORD_MATCHING')
    return answers.every((answer) => (question.options as string[]).includes(answer));
  const pairs = question.pairs as Array<{ left: string; right: string }>;
  const left = new Set<string>(),
    right = new Set<string>();
  return (
    answers.length <= pairs.length &&
    answers.every((answer) => {
      const separator = answer.lastIndexOf('=>');
      const a = answer.slice(0, separator),
        b = answer.slice(separator + 2);
      if (
        separator <= 0 ||
        left.has(a) ||
        right.has(b) ||
        !pairs.some((pair) => pair.left === a) ||
        !pairs.some((pair) => pair.right === b)
      )
        return false;
      left.add(a);
      right.add(b);
      return true;
    })
  );
}

const stages: ProgressivePracticeStage[] = ['FOUNDATION', 'CONTEXT', 'TRANSFER'];
export type CompletionPreview = {
  version: 1;
  planId: string;
  userId: string | null;
  classification: 'ELIGIBLE' | 'NOT_APPLICABLE' | 'MANUAL_REVIEW';
  reasons: string[];
  evidenceDigest: string | null;
  itemCount: number;
  proposed: {
    status: 'COMPLETED';
    completedAt: string;
    path: { id: string; before: ProgressivePracticeStage; after: ProgressivePracticeStage } | null;
  } | null;
};

/** Operator-only metadata repair. Never grades answers or writes scheduling evidence. */
export class StudyCompletionRepair {
  constructor(private readonly db: PrismaClient) {}

  async scan(limit = 50, afterId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('limit must be 1..100');
    return this.db.studyPlan.findMany({
      where: {
        status: 'ACTIVE',
        items: { none: { completedAt: null } },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });
  }

  async preview(planId: string) {
    return this.db.$transaction((tx) => this.inspect(tx, planId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async inspect(tx: Prisma.TransactionClient, planId: string): Promise<CompletionPreview> {
    const plan = await tx.studyPlan.findUnique({
      where: { id: planId },
      include: {
        replacesPlan: { select: { id: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            attempts: { orderBy: { id: 'asc' } },
          },
        },
      },
    });
    const result: CompletionPreview = {
      version: 1,
      planId,
      userId: plan?.userId ?? null,
      classification: 'NOT_APPLICABLE',
      reasons: [],
      evidenceDigest: null,
      itemCount: plan?.items.length ?? 0,
      proposed: null,
    };
    if (!plan || plan.status !== 'ACTIVE') return { ...result, reasons: ['NOT_ACTIVE'] };
    if (plan.items.some((item) => !item.completedAt))
      return { ...result, reasons: ['PARTIAL_COMPLETION'] };
    const progressRows = await tx.userWordProgress.findMany({
      where: { userId: plan.userId, bookWordId: { in: plan.items.map((item) => item.bookWordId) } },
      orderBy: { id: 'asc' },
      select: { id: true, bookWordId: true, totalAttempts: true },
    });
    result.classification = 'MANUAL_REVIEW';
    if (!plan.items.length) result.reasons.push('EMPTY_PLAN');
    if (!plan.startedAt || !plan.generatedAt || plan.completedAt)
      result.reasons.push('PLAN_TIMESTAMPS_INCONSISTENT');
    if (plan.replacementPlanId || plan.replacesPlan)
      result.reasons.push('REPLACEMENT_CHAIN_REQUIRES_REVIEW');
    const content = plan.generatedContent as {
      groups?: Array<{ index: number; questions?: Array<{ bookWordId: string }> }>;
    } | null;
    const groups = content?.groups;
    if (
      !Array.isArray(groups) ||
      groups.length < 2 ||
      groups.some(
        (group) => !group || !Number.isInteger(group.index) || !Array.isArray(group.questions),
      ) ||
      new Set(groups.map((g) => g?.index)).size !== groups.length
    )
      result.reasons.push('MATERIAL_GROUPS_UNVERIFIED');
    else {
      const references: string[] = [];
      for (const group of groups) {
        const items = plan.items.filter((item) => item.groupIndex === group.index);
        const ids = Array.isArray(group.questions) ? group.questions.map((q) => q?.bookWordId) : [];
        references.push(...ids);
        if (
          !items.length ||
          ids.length !== items.length ||
          ids.some(
            (id) => typeof id !== 'string' || !items.some((item) => item.bookWordId === id),
          ) ||
          new Set(ids).size !== ids.length
        )
          result.reasons.push('MATERIAL_ITEM_MISMATCH');
        if (new Set(items.map((item) => item.completedAt?.getTime())).size !== 1)
          result.reasons.push('GROUP_COMPLETION_TIME_MISMATCH');
      }
      if (references.length !== plan.items.length) result.reasons.push('MATERIAL_ITEM_MISMATCH');
    }
    const now = Date.now();
    for (const item of plan.items) {
      if (
        !item.completedAt ||
        item.completedAt.getTime() > now ||
        !plan.startedAt ||
        item.completedAt < plan.startedAt ||
        !plan.generatedAt ||
        plan.startedAt < plan.generatedAt
      )
        result.reasons.push('ITEM_TIMESTAMPS_INCONSISTENT');
      const attempt = item.attempts[0];
      if (
        item.attempts.length !== 1 ||
        !attempt ||
        attempt.userId !== plan.userId ||
        attempt.bookWordId !== item.bookWordId ||
        !Array.isArray(attempt.selectedAnswer) ||
        !attempt.selectedAnswer.length ||
        attempt.selectedAnswer.some((answer) => typeof answer !== 'string') ||
        !item.completedAt ||
        !plan.generatedAt ||
        attempt.createdAt < plan.generatedAt ||
        attempt.adventureActionId !== null ||
        !selectionBelongs(item.question, attempt.questionType, attempt.selectedAnswer) ||
        attempt.createdAt.getTime() > now
      )
        result.reasons.push('ATTEMPT_EVIDENCE_UNVERIFIED');
      if (
        !item.question ||
        typeof item.question !== 'object' ||
        Array.isArray(item.question) ||
        item.question.bookWordId !== item.bookWordId
      )
        result.reasons.push('QUESTION_SNAPSHOT_UNVERIFIED');
      const progress = progressRows.find((row) => row.bookWordId === item.bookWordId);
      if (!progress || progress.totalAttempts < 1)
        result.reasons.push('PROGRESS_EVIDENCE_UNVERIFIED');
    }
    let path: NonNullable<CompletionPreview['proposed']>['path'] = null;
    const track =
      plan.purpose === 'PROGRESSIVE'
        ? await tx.progressivePracticeProgress.findUnique({
            where: {
              userId_trackVersion: {
                userId: plan.userId,
                trackVersion: plan.progressiveVersion ?? -1,
              },
            },
          })
        : null;
    if (plan.purpose === 'PROGRESSIVE') {
      if (
        plan.progressiveVersion !== 1 ||
        !plan.progressiveStage ||
        !track ||
        stages.indexOf(track.highestUnlockedStage) < stages.indexOf(plan.progressiveStage)
      )
        result.reasons.push('PROGRESSIVE_PATH_REQUIRES_REVIEW');
      else if (
        track.highestUnlockedStage === plan.progressiveStage &&
        plan.progressiveStage !== 'TRANSFER'
      )
        path = {
          id: track.id,
          before: track.highestUnlockedStage,
          after: stages[stages.indexOf(plan.progressiveStage) + 1],
        };
    } else if (
      plan.purpose !== 'NORMAL' ||
      plan.progressiveStage !== null ||
      plan.progressiveVersion !== null
    )
      result.reasons.push('PLAN_PURPOSE_REQUIRES_REVIEW');
    result.reasons = [...new Set(result.reasons)];
    if (result.reasons.length) return result;
    result.classification = 'ELIGIBLE';
    result.proposed = {
      status: 'COMPLETED',
      completedAt: new Date(
        Math.max(...plan.items.map((item) => item.completedAt!.getTime())),
      ).toISOString(),
      path,
    };
    result.evidenceDigest = createHash('sha256')
      .update(canonical({ plan, track, progressRows }))
      .digest('hex');
    return result;
  }

  async apply(manifest: CompletionPreview) {
    if (
      manifest?.version !== 1 ||
      manifest.classification !== 'ELIGIBLE' ||
      !manifest.proposed ||
      !/^[a-f0-9]{64}$/.test(manifest.evidenceDigest ?? '')
    )
      throw new Error('An eligible preview manifest is required');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${manifest.userId}, 0)) IS NULL`;
            await tx.$queryRaw`SELECT "id" FROM "StudyPlan" WHERE "id" = ${manifest.planId} FOR UPDATE`;
            const receipt = await tx.studyPlanCompletionRepair.findUnique({
              where: { planId: manifest.planId },
            });
            if (receipt) {
              const plan = await tx.studyPlan.findUnique({ where: { id: manifest.planId } });
              if (
                receipt.evidenceDigest !== manifest.evidenceDigest ||
                canonical(receipt.after) !== canonical(manifest.proposed) ||
                plan?.userId !== manifest.userId ||
                plan.status !== 'COMPLETED' ||
                plan.completedAt?.toISOString() !== manifest.proposed!.completedAt
              )
                throw new Error(
                  'Repair receipt or current metadata differs; manual review required',
                );
              return { status: 'ALREADY_APPLIED', receiptId: receipt.id };
            }
            await tx.$queryRaw`SELECT "id" FROM "StudyPlanItem" WHERE "planId" = ${manifest.planId} ORDER BY "id" FOR UPDATE`;
            const items = await tx.studyPlanItem.findMany({
              where: { planId: manifest.planId },
              select: { bookWordId: true },
            });
            await lockUserWordProgress(
              tx,
              manifest.userId!,
              items.map((item) => item.bookWordId),
            );
            const current = await this.inspect(tx, manifest.planId);
            if (canonical(current) !== canonical(manifest))
              throw new Error('Preview is stale or evidence is insufficient; preview again');
            await tx.studyPlan.update({
              where: { id: manifest.planId },
              data: { status: 'COMPLETED', completedAt: new Date(current.proposed!.completedAt) },
            });
            const path = current.proposed!.path;
            if (path) {
              const changed = await tx.progressivePracticeProgress.updateMany({
                where: { id: path.id, highestUnlockedStage: path.before },
                data: { highestUnlockedStage: path.after },
              });
              if (changed.count !== 1) throw new Error('Path changed; preview again');
            }
            const saved = await tx.studyPlanCompletionRepair.create({
              data: {
                planId: manifest.planId,
                evidenceDigest: manifest.evidenceDigest!,
                before: {
                  status: 'ACTIVE',
                  completedAt: null,
                  path: path ? { id: path.id, stage: path.before } : null,
                },
                after: current.proposed!,
              },
            });
            return { status: 'APPLIED', receiptId: saved.id };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' ||
            (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))))
        )
          continue;
        throw error;
      }
    }
  }
}
