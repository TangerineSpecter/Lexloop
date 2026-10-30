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

describe('MistakesService.detail', () => {
  it('uses a scoped stable cursor to page only the authenticated user’s attempts', async () => {
    const attempts = Array.from({ length: 21 }, (_, index) => ({
      id: `attempt-${index}`,
      isCorrect: index % 2 === 0,
      selectedAnswer: { answer: `answer-${index}`, question: null },
      responseTimeMs: 900,
      createdAt: new Date('2026-10-28T00:00:00.000Z'),
      item: null,
    }));
    const prisma = {
      weaknessSignal: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'signal-1',
          userId: 'user-1',
          bookWordId: 'word-1',
          questionType: 'MEANING_RECOGNITION',
          status: WeaknessStatus.ACTIVE,
          wrongCount: 4,
          consecutiveCorrect: 0,
          lastWrongAt: new Date('2026-10-28T00:00:00.000Z'),
          lastAttemptAt: new Date('2026-10-28T00:00:00.000Z'),
          resolvedAt: null,
          ignoredAt: null,
          bookWord: {
            contextMeaning: null,
            word: { text: 'steady', meaning: '稳定的' },
            book: { title: 'Test book' },
          },
        }),
      },
      wordReviewAttempt: { findMany: vi.fn().mockResolvedValue(attempts) },
    };

    const cursor = Buffer.from(
      JSON.stringify({
        userId: 'user-1',
        weaknessId: 'signal-1',
        id: 'attempt-20',
        createdAt: '2026-10-28T00:00:00.000Z',
        anchor: {
          id: 'attempt-41',
          createdAt: '2026-10-28T00:00:00.000Z',
        },
      }),
    ).toString('base64url');
    const result = await new MistakesService(prisma as any).detail(
      'user-1',
      'signal-1',
      cursor,
      'older',
    );

    expect(prisma.weaknessSignal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'signal-1', userId: 'user-1' } }),
    );
    expect(prisma.wordReviewAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          bookWordId: 'word-1',
          questionType: 'MEANING_RECOGNITION',
          OR: [
            { createdAt: { lt: new Date('2026-10-28T00:00:00.000Z') } },
            {
              createdAt: new Date('2026-10-28T00:00:00.000Z'),
              id: { lt: 'attempt-20' },
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(result.attemptPageSize).toBe(20);
    expect(result.attemptHasOlder).toBe(true);
    expect(result.attemptHasNewer).toBe(true);
    expect(result.olderAttemptCursor).toBeTruthy();
    expect(result.newerAttemptCursor).toBeTruthy();
    expect(result.attempts).toHaveLength(20);
    expect(result.attempts[0]).toMatchObject({
      id: 'attempt-0',
      selectedAnswer: 'answer-0',
      question: null,
    });
    await expect(
      new MistakesService(prisma as any).detail('user-2', 'signal-1', cursor, 'older'),
    ).rejects.toThrow('关联作答分页游标无效');
  });

  it('keeps a signal visible when its historical question snapshot is unavailable', async () => {
    const prisma = {
      weaknessSignal: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'signal-1',
          userId: 'user-1',
          bookWordId: 'word-1',
          questionType: 'MEANING_RECOGNITION',
          status: WeaknessStatus.ACTIVE,
          wrongCount: 1,
          consecutiveCorrect: 0,
          lastWrongAt: new Date('2026-10-28T00:00:00.000Z'),
          lastAttemptAt: new Date('2026-10-28T00:00:00.000Z'),
          resolvedAt: null,
          ignoredAt: null,
          bookWord: {
            contextMeaning: null,
            word: { text: 'steady', meaning: '稳定的' },
            book: { title: 'Test book' },
          },
        }),
      },
      wordReviewAttempt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'attempt-1',
            isCorrect: false,
            selectedAnswer: null,
            responseTimeMs: null,
            createdAt: new Date('2026-10-28T00:00:00.000Z'),
            item: null,
          },
        ]),
      },
    };

    const result = await new MistakesService(prisma as any).detail('user-1', 'signal-1');

    expect(result.attempts[0]).toMatchObject({
      id: 'attempt-1',
      selectedAnswer: null,
      question: null,
    });
    expect(result.attemptHasOlder).toBe(false);
    expect(result.attemptHasNewer).toBe(false);
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
