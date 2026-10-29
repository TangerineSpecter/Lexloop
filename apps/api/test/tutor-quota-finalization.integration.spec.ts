import {
  PrismaClient,
  TutorContextType,
  TutorMessageRole,
  TutorMessageStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TutorService } from '../src/modules/ai/tutor.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'tutor quota finalization in an isolated database',
  () => {
    let prisma: PrismaClient;
    let userId: string;
    let assistantMessageId: string;
    let auditId: string;
    const usageDate = new Date('2026-10-29T00:00:00.000Z');

    beforeEach(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await prisma.user.create({
        data: {
          email: `tutor-finalization-${randomUUID()}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      userId = user.id;

      const plan = await prisma.studyPlan.create({
        data: { userId },
        select: { id: true },
      });
      const conversation = await prisma.tutorConversation.create({
        data: {
          userId,
          contextType: TutorContextType.STUDY_GROUP,
          studyPlanId: plan.id,
          groupIndex: 0,
        },
        select: { id: true },
      });
      const assistantMessage = await prisma.tutorMessage.create({
        data: {
          conversationId: conversation.id,
          role: TutorMessageRole.ASSISTANT,
          status: TutorMessageStatus.PENDING,
          content: '',
        },
        select: { id: true },
      });
      assistantMessageId = assistantMessage.id;
      const audit = await prisma.aiCallAudit.create({
        data: { userId, purpose: 'tutor', status: 'PENDING' },
        select: { id: true },
      });
      auditId = audit.id;
      await prisma.tutorDailyUsage.create({ data: { userId, usageDate, count: 1 } });
    });

    afterEach(async () => {
      if (userId) {
        await prisma.aiCallAudit.deleteMany({ where: { userId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await prisma.$disconnect();
    });

    it('refunds once when duplicate cancellation finalizers race on the same pending answer', async () => {
      const service = new TutorService(prisma as never, {} as never, {} as never, {} as never);

      await Promise.all([
        (service as any).failPendingCall(
          userId,
          assistantMessageId,
          auditId,
          '回答已中断',
          'REQUEST_ABORTED',
          Date.now(),
          usageDate,
        ),
        (service as any).failPendingCall(
          userId,
          assistantMessageId,
          auditId,
          '回答已中断',
          'REQUEST_ABORTED',
          Date.now(),
          usageDate,
        ),
      ]);

      const [message, audit, usage] = await Promise.all([
        prisma.tutorMessage.findUniqueOrThrow({ where: { id: assistantMessageId } }),
        prisma.aiCallAudit.findUniqueOrThrow({ where: { id: auditId } }),
        prisma.tutorDailyUsage.findUniqueOrThrow({
          where: { userId_usageDate: { userId, usageDate } },
        }),
      ]);

      expect(message.status).toBe(TutorMessageStatus.FAILED);
      expect(audit.status).toBe('FAILED');
      expect(usage.count).toBe(0);
    });

    it('refunds the app quota if recent conversation context cannot be read before a model call', async () => {
      const readFailure = new Error('conversation history read failed');
      const ai = { selectedChatCompletions: vi.fn() };
      const service = new TutorService(
        prisma as never,
        { get: vi.fn().mockReturnValue(undefined) } as never,
        ai as never,
        {
          selectedProvider: vi
            .fn()
            .mockResolvedValue({ provider: 'OPENAI_COMPATIBLE', model: 'fixture-model' }),
        } as never,
      );
      vi.spyOn(service as never, 'resolveContext' as never).mockResolvedValue({} as never);
      vi.spyOn(service as never, 'ensureConversation' as never).mockResolvedValue({
        id: 'conversation-not-used',
      } as never);
      vi.spyOn(service as never, 'usageDate' as never).mockReturnValue(usageDate as never);
      const findMany = vi.spyOn(prisma.tutorMessage, 'findMany').mockRejectedValue(readFailure);

      try {
        await expect(
          service.prepareMessage(
            userId,
            { type: 'STUDY_GROUP', planId: 'plan-1', groupIndex: 0 },
            '给我一点提示',
          ),
        ).rejects.toBe(readFailure);
      } finally {
        findMany.mockRestore();
      }

      const [usage, messages, audits] = await Promise.all([
        prisma.tutorDailyUsage.findUniqueOrThrow({
          where: { userId_usageDate: { userId, usageDate } },
        }),
        prisma.tutorMessage.count({ where: { conversationId: 'conversation-not-used' } }),
        prisma.aiCallAudit.count({ where: { userId } }),
      ]);
      expect(usage.count).toBe(1);
      expect(messages).toBe(0);
      expect(audits).toBe(1);
      expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
    });

    it('keeps a generated answer completed and charged if disconnect arrives during finalization', async () => {
      let markCompletionStarted!: () => void;
      const completionStarted = new Promise<void>((resolve) => {
        markCompletionStarted = resolve;
      });
      let releaseCompletion!: () => void;
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      const databaseForService = {
        tutorMessage: prisma.tutorMessage,
        aiCallAudit: prisma.aiCallAudit,
        tutorDailyUsage: prisma.tutorDailyUsage,
        $transaction: async (operations: unknown) => {
          if (Array.isArray(operations)) {
            markCompletionStarted();
            await completionGate;
          }
          return prisma.$transaction(operations as never);
        },
      };
      const responseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"Look at the verb."}}]}\n\n',
            ),
          );
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      const ai = {
        selectedChatCompletions: vi
          .fn()
          .mockResolvedValue(
            new Response(responseBody, { headers: { 'content-type': 'text/event-stream' } }),
          ),
      };
      const service = new TutorService(
        databaseForService as never,
        {} as never,
        ai as never,
        {} as never,
      );
      const abortController = new AbortController();
      const stream = (service as any).streamAnswer(
        userId,
        [],
        assistantMessageId,
        auditId,
        { remaining: 29, usageDate },
        abortController.signal,
      ) as AsyncGenerator<string>;

      expect((await stream.next()).value).toContain('event: delta');
      const completion = stream.next();
      await completionStarted;
      abortController.abort();
      const disconnect = stream.return(undefined);
      releaseCompletion();

      expect((await completion).value).toContain('event: done');
      expect((await disconnect).done).toBe(true);

      const [message, audit, usage] = await Promise.all([
        prisma.tutorMessage.findUniqueOrThrow({ where: { id: assistantMessageId } }),
        prisma.aiCallAudit.findUniqueOrThrow({ where: { id: auditId } }),
        prisma.tutorDailyUsage.findUniqueOrThrow({
          where: { userId_usageDate: { userId, usageDate } },
        }),
      ]);

      expect(message).toMatchObject({
        status: TutorMessageStatus.COMPLETED,
        content: 'Look at the verb.',
      });
      expect(audit.status).toBe('SUCCEEDED');
      expect(usage.count).toBe(1);
      expect(ai.selectedChatCompletions).toHaveBeenCalledTimes(1);
    });
  },
);
