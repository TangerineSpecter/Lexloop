import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OutputService } from '../src/modules/practice/output.service';
import { ConfusionService } from '../src/modules/practice/confusion.service';

const token = 'a'.repeat(64);
function outputFixture(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'submission',
    status: 'PROCESSING',
    answer: 'The effect may affect my plans.',
    createdAt: new Date(),
    workerTokenHash: createHash('sha256').update(token).digest('hex'),
    challenge: {
      userId: 'owner',
      prompt: 'Write a sentence.',
      targets: [{ bookWordId: 'word', word: 'effect', meaning: '结果' }],
    },
    ...overrides,
  };
  const tx = {
    $queryRaw: vi.fn(),
    outputSubmission: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    outputSubmission: { findFirst: vi.fn().mockResolvedValue(row), updateMany: vi.fn() },
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const models = { selectedProvider: vi.fn() };
  const evidence = { record: vi.fn() };
  const service = new OutputService(
    prisma as never,
    { get: vi.fn() } as never,
    models as never,
    evidence as never,
    {} as never,
  );
  return { service, prisma, models, evidence, tx };
}

describe('output ownership and exactly-once completion', () => {
  it('scopes public reads to the authenticated owner and never exposes task credentials', async () => {
    const f = outputFixture({ feedback: null, error: null });
    const result = await f.service.submission('owner', 'submission');
    expect(f.prisma.outputSubmission.findFirst).toHaveBeenCalledWith({
      where: { id: 'submission', challenge: { userId: 'owner' } },
    });
    expect(result).not.toHaveProperty('workerTokenHash');
    expect(result).not.toHaveProperty('leaseToken');
  });
  it('rejects invalid worker authorization before looking up a task', async () => {
    const f = outputFixture();
    await expect(f.service.claim('submission', 'user-jwt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(f.prisma.outputSubmission.findFirst).not.toHaveBeenCalled();
  });
  it('does not invoke a provider or apply evidence again for completed jobs', async () => {
    const f = outputFixture({ status: 'COMPLETED' });
    await expect(f.service.claim('submission', token)).resolves.toEqual({ done: true });
    await expect(f.service.complete('submission', token, 'old-lease', {})).resolves.toEqual({
      done: true,
    });
    expect(f.models.selectedProvider).not.toHaveBeenCalled();
    expect(f.evidence.record).not.toHaveBeenCalled();
  });
  it('does not apply evidence from an expired processing lease', async () => {
    const f = outputFixture();
    await expect(
      f.service.complete('submission', token, 'stale-lease', {
        grammarScore: 80,
        coherenceScore: 80,
        correctedText: 'The effect is clear.',
        comments: [],
        words: [{ bookWordId: 'word', used: true, correct: true, feedback: '搭配正确' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.evidence.record).not.toHaveBeenCalled();
  });
  it('rejects expired capabilities before returning model configuration', async () => {
    const f = outputFixture({ createdAt: new Date(Date.now() - 16 * 60_000) });
    await expect(f.service.claim('submission', token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(f.models.selectedProvider).not.toHaveBeenCalled();
  });
});

describe('contrast submission validation', () => {
  const answers = ['affect', 'effect', 'affect', 'effect'].map((selected, i) => ({
    questionId: `affect-effect-${i + 1}`,
    selected,
  }));
  it('rejects duplicate questions and answers outside the group before writing any evidence', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new ConfusionService(prisma as never, {} as never);
    await expect(
      service.submit(
        'owner',
        'affect-effect',
        [answers[0], answers[0], answers[2], answers[3]],
        'request-id',
        1000,
      ),
    ).rejects.toThrow();
    await expect(
      service.submit(
        'owner',
        'affect-effect',
        [{ ...answers[0], selected: 'invented' }, ...answers.slice(1)],
        'request-id',
        1000,
      ),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('replays a saved result without creating another attempt or learning event', async () => {
    const results = answers.map((row) => ({
      ...row,
      answer: row.selected,
      correct: true,
      explanation: '语境正确。',
    }));
    const tx = {
      $queryRaw: vi.fn(),
      confusionAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'saved',
          groupId: 'affect-effect',
          correctCount: 4,
          total: 4,
          answers: results,
        }),
        create: vi.fn(),
      },
      learningEvent: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)) };
    const evidence = { record: vi.fn() };
    const service = new ConfusionService(prisma as never, evidence as never);
    const result = await service.submit('owner', 'affect-effect', answers, 'request-id', 1000);
    expect(result.correctCount).toBe(4);
    expect(tx.confusionAttempt.create).not.toHaveBeenCalled();
    expect(tx.learningEvent.create).not.toHaveBeenCalled();
    expect(evidence.record).not.toHaveBeenCalled();
    await expect(
      service.submit(
        'owner',
        'affect-effect',
        [{ ...answers[0], selected: 'effect' }, ...answers.slice(1)],
        'request-id',
        1000,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
