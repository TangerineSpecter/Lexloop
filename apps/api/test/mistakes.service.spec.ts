import { describe, expect, it, vi } from 'vitest';
import {
  StudyPlanItemSource,
  StudyPlanPurpose,
  StudyPlanStatus,
  WeaknessStatus,
} from '@prisma/client';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

function transaction(existing: any = null) {
  return {
    weaknessSignal: {
      findUnique: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

const input = { userId: 'user-1', bookWordId: 'word-1', questionType: 'MEANING_RECOGNITION' };

describe('MistakesService.recordAttempt', () => {
  const service = new MistakesService({} as any);

  it('does not create a weakness for an always-correct answer', async () => {
    const tx = transaction();
    await service.recordAttempt(tx, { ...input, isCorrect: true });
    expect(tx.weaknessSignal.create).not.toHaveBeenCalled();
  });

  it('creates an active weakness on the first wrong answer', async () => {
    const tx = transaction();
    await service.recordAttempt(tx, { ...input, isCorrect: false });
    expect(tx.weaknessSignal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(input) }),
    );
  });

  it('increments errors and reactivates an ignored weakness', async () => {
    const tx = transaction({ consecutiveCorrect: 1, status: WeaknessStatus.IGNORED });
    await service.recordAttempt(tx, { ...input, isCorrect: false });
    expect(tx.weaknessSignal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WeaknessStatus.ACTIVE,
          consecutiveCorrect: 0,
          ignoredAt: null,
        }),
      }),
    );
  });

  it('keeps a weakness active after one correct answer', async () => {
    const tx = transaction({ consecutiveCorrect: 0, status: WeaknessStatus.ACTIVE });
    await service.recordAttempt(tx, { ...input, isCorrect: true });
    expect(tx.weaknessSignal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: WeaknessStatus.RESOLVED }),
      }),
    );
    expect(tx.weaknessSignal.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consecutiveCorrect: 1 }) }),
    );
  });

  it('resolves a weakness after two consecutive correct answers', async () => {
    const tx = transaction({ consecutiveCorrect: 1, status: WeaknessStatus.ACTIVE });
    await service.recordAttempt(tx, { ...input, isCorrect: true });
    expect(tx.weaknessSignal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ consecutiveCorrect: 2, status: WeaknessStatus.RESOLVED }),
      }),
    );
  });

  it('uses question type as part of the unique weakness key', async () => {
    const tx = transaction();
    await service.recordAttempt(tx, {
      ...input,
      questionType: 'READING_COMPREHENSION',
      isCorrect: false,
    });
    expect(tx.weaknessSignal.findUnique).toHaveBeenCalledWith({
      where: {
        userId_bookWordId_questionType: { ...input, questionType: 'READING_COMPREHENSION' },
      },
    });
  });
});

describe('MistakesService.list', () => {
  it('paginates word ids in the database before loading signal details', async () => {
    const prisma = {
      weaknessSignal: {
        groupBy: vi.fn().mockResolvedValue([{ bookWordId: 'word-2' }]),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'signal-2',
            bookWordId: 'word-2',
            questionType: 'MEANING_RECOGNITION',
            status: WeaknessStatus.ACTIVE,
            wrongCount: 2,
            consecutiveCorrect: 0,
            lastWrongAt: new Date('2026-09-12'),
            lastAttemptAt: new Date('2026-09-12'),
            resolvedAt: null,
            ignoredAt: null,
            bookWord: { word: { text: 'loop', meaning: 'n. 循环' }, book: { title: '测试词书' } },
          },
        ]),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ count: 3 }]),
    };
    const result = await new MistakesService(prisma as any).list('user-1', {
      page: 2,
      pageSize: 1,
    });
    expect(prisma.weaknessSignal.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 1 }),
    );
    expect(prisma.weaknessSignal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookWordId: { in: ['word-2'] } }),
      }),
    );
    expect(result).toMatchObject({ total: 3, hasMore: true });
  });
});

describe('MistakesService.createPracticePlan', () => {
  it('reuses the same unfinished plan for concurrent requests with the same selection in any order', async () => {
    let activePlan: { id: string; items: Array<{ bookWordId: string }> } | null = null;
    let transactionQueue = Promise.resolve();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
      studyPlan: {
        findFirst: vi.fn(async () => activePlan),
        create: vi.fn(
          async () =>
            (activePlan = {
              id: 'plan-1',
              items: [{ bookWordId: 'word-1' }, { bookWordId: 'word-2' }],
            }),
        ),
      },
      weaknessSignal: {
        findMany: vi.fn().mockResolvedValue([
          { bookWordId: 'word-1', questionType: 'MEANING_RECOGNITION' },
          { bookWordId: 'word-2', questionType: 'MEANING_RECOGNITION' },
        ]),
      },
      studyPlanItem: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const serializedPlan = {
      id: 'plan-1',
      mode: 'GROUP',
      purpose: StudyPlanPurpose.WEAKNESS,
      status: StudyPlanStatus.GENERATING,
      createdAt: new Date(),
      generatedContent: null,
      items: [
        {
          id: 'item-1',
          bookWordId: 'word-1',
          source: StudyPlanItemSource.REVIEW,
          groupIndex: 0,
          targetQuestionType: 'MEANING_RECOGNITION',
          completedAt: null,
          bookWord: { word: { text: 'loop', meaning: 'n. 循环' } },
        },
        {
          id: 'item-2',
          bookWordId: 'word-2',
          source: StudyPlanItemSource.REVIEW,
          groupIndex: 0,
          targetQuestionType: 'MEANING_RECOGNITION',
          completedAt: null,
          bookWord: { word: { text: 'flow', meaning: 'n. 流动' } },
        },
      ],
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof tx) => Promise<string>) => {
        const current = transactionQueue.then(() => operation(tx));
        transactionQueue = current.then(
          () => undefined,
          () => undefined,
        );
        return current;
      }),
      studyPlan: { findFirstOrThrow: vi.fn().mockResolvedValue(serializedPlan) },
    };
    const service = new MistakesService(prisma as any);

    const [first, second] = await Promise.all([
      service.createPracticePlan('user-1', ['word-1', 'word-2']),
      service.createPracticePlan('user-1', ['word-2', 'word-1']),
    ]);

    expect(first.id).toBe('plan-1');
    expect(second.id).toBe('plan-1');
    expect(tx.studyPlan.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not silently apply a different selection to an existing unfinished plan', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
      studyPlan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'existing-plan',
          items: [{ bookWordId: 'existing-word' }],
        }),
        create: vi.fn(),
      },
      weaknessSignal: { findMany: vi.fn() },
      studyPlanItem: { createMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof tx) => Promise<string>) => operation(tx)),
      studyPlan: { findFirstOrThrow: vi.fn() },
    };
    const service = new MistakesService(prisma as any);

    await expect(service.createPracticePlan('user-1', ['new-word'])).rejects.toThrow(
      '已有薄弱项专项包含其他选择，本次选择未应用',
    );
    expect(tx.studyPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', purpose: StudyPlanPurpose.WEAKNESS }),
        include: { items: { select: { bookWordId: true } } },
      }),
    );
    expect(tx.studyPlan.create).not.toHaveBeenCalled();
    expect(tx.weaknessSignal.findMany).not.toHaveBeenCalled();
    expect(prisma.studyPlan.findFirstOrThrow).not.toHaveBeenCalled();
  });
});
