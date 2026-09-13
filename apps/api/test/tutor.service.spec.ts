import { describe, expect, it, vi } from 'vitest';
import { TutorService } from '../src/modules/ai/tutor.service';

function serviceWith(completedAt: Date | null) {
  const prisma = {
    studyPlan: {
      findFirst: vi.fn().mockResolvedValue({
        purpose: 'NORMAL',
        generatedContent: { groups: [{ index: 0, questions: [{ prompt: 'Choose one', options: ['A', 'B'], correctAnswers: ['SECRET'], explanation: 'SECRET_EXPLANATION', pairs: [{ left: 'left', right: 'SECRET_PAIR', tip: 'hint' }] }] }] },
        items: [{ completedAt, bookWord: { word: { text: 'word', meaning: '含义' } }, attempts: [] }],
      }),
    },
  };
  return new TutorService(prisma as any, {} as any, {} as any, {} as any);
}

describe('TutorService learning context', () => {
  it('removes answers, explanations and matching targets before submission', async () => {
    const context = await (serviceWith(null) as any).resolveContext('user-1', { type: 'STUDY_GROUP', planId: 'plan-1', groupIndex: 0 });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).toContain('Choose one');
    expect(context.submitted).toBe(false);
  });

  it('includes full answer context after submission', async () => {
    const context = await (serviceWith(new Date()) as any).resolveContext('user-1', { type: 'STUDY_GROUP', planId: 'plan-1', groupIndex: 0 });
    expect(JSON.stringify(context)).toContain('SECRET_EXPLANATION');
    expect(context.submitted).toBe(true);
  });
});

describe('TutorService streaming cleanup', () => {
  it('marks a pending call failed and refunds its original quota date when the consumer cancels', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"提示"}}]}\n\n'));
      },
      cancel,
    });
    const tx = {
      tutorMessage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      aiCallAudit: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: unknown) => typeof operation === 'function' ? operation(tx) : Promise.all(operation as Promise<unknown>[])),
      tutorDailyUsage: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const ai = { selectedChatCompletions: vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })) };
    const service = new TutorService(prisma as any, {} as any, ai as any, {} as any);
    const usageDate = new Date('2026-09-12T00:00:00.000Z');
    const stream = (service as any).streamAnswer('user-1', [], 'message-1', 'audit-1', { remaining: 29, usageDate });

    expect((await stream.next()).value).toContain('event: delta');
    await stream.return(undefined);

    expect(cancel).toHaveBeenCalled();
    expect(tx.tutorMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'message-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(prisma.tutorDailyUsage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-1', usageDate }),
    }));
  });
});
