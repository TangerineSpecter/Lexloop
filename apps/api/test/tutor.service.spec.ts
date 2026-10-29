import { describe, expect, it, vi } from 'vitest';
import { TutorService } from '../src/modules/ai/tutor.service';

function serviceWith(completedAt: Date | null) {
  const prisma = {
    studyPlan: {
      findFirst: vi.fn().mockResolvedValue({
        purpose: 'NORMAL',
        generatedContent: {
          groups: [
            {
              index: 0,
              questions: [
                {
                  prompt: 'Choose one',
                  options: ['A', 'B'],
                  correctAnswers: ['SECRET'],
                  explanation: 'SECRET_EXPLANATION',
                  pairs: [{ left: 'left', right: 'SECRET_PAIR', tip: 'hint' }],
                },
              ],
            },
          ],
        },
        items: [
          { completedAt, bookWord: { word: { text: 'word', meaning: '含义' } }, attempts: [] },
        ],
      }),
    },
  };
  return new TutorService(prisma as any, {} as any, {} as any, {} as any);
}

describe('TutorService learning context', () => {
  it('removes answers, explanations and matching targets before submission', async () => {
    const context = await (serviceWith(null) as any).resolveContext('user-1', {
      type: 'STUDY_GROUP',
      planId: 'plan-1',
      groupIndex: 0,
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).toContain('Choose one');
    expect(context.submitted).toBe(false);
  });

  it('includes full answer context after submission', async () => {
    const context = await (serviceWith(new Date()) as any).resolveContext('user-1', {
      type: 'STUDY_GROUP',
      planId: 'plan-1',
      groupIndex: 0,
    });
    expect(JSON.stringify(context)).toContain('SECRET_EXPLANATION');
    expect(context.submitted).toBe(true);
  });
});

describe('TutorService streaming cleanup', () => {
  it('marks a pending call failed and refunds its original quota date when the consumer cancels', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"提示"}}]}\n\n'),
        );
      },
      cancel,
    });
    const tx = {
      tutorMessage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiCallAudit: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: unknown) =>
        typeof operation === 'function'
          ? operation(tx)
          : Promise.all(operation as Promise<unknown>[]),
      ),
      tutorDailyUsage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const ai = {
      selectedChatCompletions: vi
        .fn()
        .mockResolvedValue(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        ),
    };
    const service = new TutorService(prisma as any, {} as any, ai as any, {} as any);
    const usageDate = new Date('2026-09-12T00:00:00.000Z');
    const stream = (service as any).streamAnswer('user-1', [], 'message-1', 'audit-1', {
      remaining: 29,
      usageDate,
    });

    expect((await stream.next()).value).toContain('event: delta');
    await stream.return(undefined);

    expect(cancel).toHaveBeenCalled();
    expect(tx.tutorMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'message-1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(prisma.tutorDailyUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', usageDate }),
      }),
    );
  });

  it('passes the disconnect signal to the provider and keeps a partial answer while refunding once', async () => {
    const abortController = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"先看句子里的"}}]}\n\n'),
        );
      },
    });
    const tx = {
      tutorMessage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiCallAudit: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: unknown) =>
        typeof operation === 'function'
          ? operation(tx)
          : Promise.all(operation as Promise<unknown>[]),
      ),
      tutorDailyUsage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const ai = {
      selectedChatCompletions: vi.fn(
        async (_request: unknown, _userId: string, signal?: AbortSignal) => {
          signal?.addEventListener(
            'abort',
            () => bodyController?.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
          return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        },
      ),
    };
    const service = new TutorService(prisma as any, {} as any, ai as any, {} as any);
    const usageDate = new Date('2026-09-12T00:00:00.000Z');
    const stream = (service as any).streamAnswer(
      'user-1',
      [],
      'message-1',
      'audit-1',
      { remaining: 29, usageDate },
      abortController.signal,
    );

    expect((await stream.next()).value).toContain('先看句子里的');
    const pendingRead = stream.next();
    abortController.abort();
    expect((await pendingRead).done).toBe(true);

    expect(ai.selectedChatCompletions).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      abortController.signal,
    );
    expect(tx.tutorMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.tutorMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'message-1', status: 'PENDING' },
        data: { content: '先看句子里的', status: 'FAILED' },
      }),
    );
    expect(tx.aiCallAudit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'audit-1' },
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'REQUEST_ABORTED' }),
      }),
    );
    expect(prisma.tutorDailyUsage.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.tutorDailyUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', usageDate }),
      }),
    );
  });

  it('does not call the provider when the request was already disconnected before streaming', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const tx = {
      tutorMessage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiCallAudit: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: unknown) =>
        typeof operation === 'function'
          ? operation(tx)
          : Promise.all(operation as Promise<unknown>[]),
      ),
      tutorDailyUsage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const ai = { selectedChatCompletions: vi.fn() };
    const service = new TutorService(prisma as any, {} as any, ai as any, {} as any);
    const stream = (service as any).streamAnswer(
      'user-1',
      [],
      'message-1',
      'audit-1',
      { remaining: 29, usageDate: new Date() },
      abortController.signal,
    );

    expect((await stream.next()).done).toBe(true);
    expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
    expect(tx.tutorMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.tutorDailyUsage.updateMany).toHaveBeenCalledTimes(1);
  });
});
