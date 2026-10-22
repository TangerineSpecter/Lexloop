import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { LabService } from '../src/modules/learning-lab/lab.service';
import { foundationGrammar } from '../src/modules/learning-lab/lab.rules';

const token = 'a'.repeat(64);
function fixture(overrides = {}) {
  const row = {
    id: 'lesson1',
    userId: 'owner',
    kind: 'GRAMMAR',
    clientRequestId: 'request1',
    status: 'PROCESSING',
    input: { targets: [], evidence: [], level: 'B1' },
    content: null,
    answers: null,
    score: null,
    error: null,
    workerTokenHash: createHash('sha256').update(token).digest('hex'),
    leaseToken: 'lease',
    processingStartedAt: new Date(),
    createdAt: new Date(),
    completedAt: null,
    submittedAt: null,
    ...overrides,
  };
  const tx = {
    $queryRaw: vi.fn(),
    labLesson: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    aiCallAudit: { create: vi.fn() },
  };
  const prisma = {
    labLesson: {
      findFirst: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const models = {
    selectedProvider: vi.fn().mockResolvedValue({
      provider: 'OPENAI_COMPATIBLE',
      model: 'stub',
      baseUrl: 'http://localhost',
      apiKey: 'test',
    }),
  };
  return {
    row,
    tx,
    prisma,
    models,
    service: new LabService(prisma as never, models as never, {} as never),
  };
}
describe('learning lab ownership and leases', () => {
  it('scopes reads to the current user and excludes credentials and unsubmitted keys', async () => {
    const f = fixture({ status: 'READY', content: foundationGrammar() });
    const result = await f.service.detail('owner', 'lesson1');
    expect(f.prisma.labLesson.findFirst).toHaveBeenCalledWith({
      where: { id: 'lesson1', userId: 'owner' },
    });
    expect(result).not.toHaveProperty('workerTokenHash');
    expect(result).not.toHaveProperty('leaseToken');
    expect(result.content!.questions[0]).not.toHaveProperty('correctIndex');
  });
  it('rejects a foreign or missing lesson', async () => {
    const f = fixture();
    f.prisma.labLesson.findFirst.mockResolvedValue(null as never);
    await expect(f.service.detail('other', 'lesson1')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects invalid and expired capabilities before returning any model configuration', async () => {
    const f = fixture({ createdAt: new Date(Date.now() - 16 * 60_000) });
    await expect(f.service.claim('lesson1', 'jwt')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.prisma.labLesson.findFirst).not.toHaveBeenCalled();
    await expect(f.service.claim('lesson1', token)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.models.selectedProvider).not.toHaveBeenCalled();
  });
  it('waits on a live lease and never creates a second audit', async () => {
    const f = fixture();
    const result = await f.service.claim('lesson1', token);
    expect(result.waitUntil).toBeGreaterThan(Date.now());
    expect(result).not.toHaveProperty('provider');
    expect(f.tx.aiCallAudit.create).not.toHaveBeenCalled();
  });
  it('does not let a stale worker commit content', async () => {
    const f = fixture();
    await expect(
      f.service.complete('lesson1', token, 'old-lease', foundationGrammar()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.prisma.labLesson.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lesson1', status: 'PROCESSING', leaseToken: 'old-lease' },
      }),
    );
  });
  it('does not call a provider on completed job replay', async () => {
    const f = fixture({ status: 'READY' });
    await expect(f.service.claim('lesson1', token)).resolves.toEqual({ done: true });
    await expect(f.service.complete('lesson1', token, 'old', {})).resolves.toEqual({ done: true });
    expect(f.models.selectedProvider).not.toHaveBeenCalled();
  });
});

describe('grammar evidence provenance', () => {
  it('uses only saved feedback for the owner and keeps wrong drills while excluding style corrections and correct answers', async () => {
    const now = new Date();
    const grammar = foundationGrammar();
    const prisma = {
      outputChallenge: {
        findMany: vi.fn().mockResolvedValue([
          {
            challengeDate: now,
            submissions: [
              {
                id: 'output1',
                answer: 'Yesterday I meet her.',
                createdAt: now,
                feedback: {
                  grammarScore: 60,
                  correctedText: 'Yesterday I met her.',
                  comments: ['过去时间使用过去式。'],
                },
              },
              {
                id: 'output2',
                answer: 'I met her.',
                createdAt: now,
                feedback: {
                  grammarScore: 100,
                  correctedText: 'I met her.',
                  comments: ['可以丰富表达。'],
                },
              },
            ],
          },
        ]),
      },
      scenarioSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            template: { title: '机场' },
            turns: [
              {
                id: 'turn1',
                createdAt: now,
                evaluation: {
                  deferredFeedback: [
                    {
                      type: 'grammar',
                      original: 'He go there.',
                      natural: 'He goes there.',
                      explanation: '主谓一致。',
                    },
                    {
                      type: 'naturalness',
                      original: 'I want a ticket.',
                      natural: 'I would like a ticket.',
                      explanation: '更礼貌。',
                    },
                  ],
                },
              },
            ],
          },
        ]),
      },
      labLesson: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            {
              id: 'drill1',
              content: grammar,
              submittedAt: now,
              answers: grammar.questions.map((question, index) =>
                index ? question.correctIndex : 0,
              ),
            },
          ]),
      },
    };
    const service = new LabService(prisma as never, {} as never, {} as never);
    const evidence = await service.grammarEvidence('owner');
    expect(evidence.map((item) => item.id)).toEqual([
      'output-output1',
      'travel-turn1-0',
      'drill-drill1-q1',
    ]);
    expect(prisma.outputChallenge.findMany.mock.calls[0][0].where.userId).toBe('owner');
    expect(prisma.scenarioSession.findMany.mock.calls[0][0].where.userId).toBe('owner');
    expect(prisma.labLesson.findMany.mock.calls[0][0].where.userId).toBe('owner');
  });
});
