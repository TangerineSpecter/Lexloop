import { PrismaClient, CefrLevel, ScenarioCategory, ScenarioTurnRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TravelService } from '../src/modules/travel/travel.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('travel scenario recovery', () => {
  it('returns the learner’s newest active session, pending retry, and saved feedback without writes or model calls', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const userIds: string[] = [];
    const templateId = `resume-${fixtureId}`;
    const sessionIds: string[] = [];

    try {
      const users = await Promise.all(
        ['one', 'two', 'empty'].map((label) =>
          prisma.user.create({
            data: {
              email: `travel-resume-${label}-${fixtureId}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
            },
            select: { id: true },
          }),
        ),
      );
      userIds.push(...users.map((user) => user.id));

      await prisma.scenarioTemplate.create({
        data: {
          id: templateId,
          slug: templateId,
          category: ScenarioCategory.HOTEL,
          title: 'Fixture hotel check-in',
          description: 'Confirm a reservation.',
          userRole: 'traveller',
          aiRole: 'receptionist',
          minTurns: 1,
          maxTurns: 6,
          objectives: ['Confirm a reservation'],
          starterPhrases: ['I have a reservation.'],
          grammarFrames: [],
          difficultyVariants: {
            A1: 'short',
            A2: 'clear',
            B1: 'natural',
            B2: 'detailed',
            C1: 'nuanced',
          },
        },
      });

      const olderSession = await prisma.scenarioSession.create({
        data: {
          userId: users[0].id,
          templateId,
          level: CefrLevel.A1,
          startedAt: new Date('2026-10-01T10:00:00.000Z'),
        },
        select: { id: true },
      });
      const latestSession = await prisma.scenarioSession.create({
        data: {
          userId: users[0].id,
          templateId,
          level: CefrLevel.A2,
          turnCount: 1,
          startedAt: new Date('2026-10-02T10:00:00.000Z'),
        },
        select: { id: true },
      });
      const otherUserSession = await prisma.scenarioSession.create({
        data: {
          userId: users[1].id,
          templateId,
          level: CefrLevel.A1,
          startedAt: new Date('2026-10-03T10:00:00.000Z'),
        },
        select: { id: true },
      });
      sessionIds.push(olderSession.id, latestSession.id, otherUserSession.id);

      await prisma.scenarioTurn.create({
        data: {
          sessionId: olderSession.id,
          role: ScenarioTurnRole.ASSISTANT,
          content: 'Older session content.',
        },
      });
      const answeredTurn = await prisma.scenarioTurn.create({
        data: {
          sessionId: latestSession.id,
          clientMessageId: 'answered-message-123',
          role: ScenarioTurnRole.USER,
          content: 'I want check in.',
          createdAt: new Date('2026-10-02T10:01:00.000Z'),
        },
        select: { id: true },
      });
      await prisma.scenarioTurn.create({
        data: {
          sessionId: latestSession.id,
          replyToTurnId: answeredTurn.id,
          role: ScenarioTurnRole.ASSISTANT,
          content: 'Certainly. May I have the name on the reservation?',
          evaluation: {
            taskProgress: [],
            blockingCorrection: null,
            deferredFeedback: [
              {
                type: 'politeness',
                original: 'I want check in.',
                natural: 'I’d like to check in.',
                explanation: 'Would like to softens a request.',
              },
            ],
            vocabulary: [],
            sessionShouldEnd: false,
          },
          createdAt: new Date('2026-10-02T10:02:00.000Z'),
        },
      });
      const pendingMessage = {
        clientMessageId: 'pending-message-123',
        content: 'Could you repeat the name?',
      };
      const pendingTurn = await prisma.scenarioTurn.create({
        data: {
          sessionId: latestSession.id,
          ...pendingMessage,
          role: ScenarioTurnRole.USER,
          createdAt: new Date('2026-10-02T10:03:00.000Z'),
        },
        select: { id: true },
      });
      await prisma.scenarioTurn.create({
        data: {
          sessionId: otherUserSession.id,
          clientMessageId: 'other-user-message-123',
          role: ScenarioTurnRole.USER,
          content: 'ACCOUNT_B_PRIVATE_MESSAGE',
        },
      });

      const before = await prisma.scenarioTurn.findMany({
        where: { sessionId: { in: sessionIds } },
        orderBy: [{ sessionId: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          sessionId: true,
          clientMessageId: true,
          replyToTurnId: true,
          content: true,
        },
      });
      const aiEvaluation = {
        reply: 'Certainly. I said the reservation is under Lee.',
        taskProgress: [{ objective: 'Confirm a reservation', completed: true }],
        blockingCorrection: null,
        deferredFeedback: [],
        vocabulary: [],
        scores: {
          vocabulary: 60,
          grammar: 60,
          sentenceBuilding: 60,
          taskCompletion: 60,
          naturalness: 60,
        },
        skillCodes: [],
        sessionShouldEnd: false,
      };
      const ai = {
        generateForUser: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(aiEvaluation) } }],
        }),
      };
      const service = new TravelService(
        prisma as never,
        ai as never,
        {
          get: vi.fn((key: string) => (key === 'TRAVEL_SCENARIO_DAILY_LIMIT' ? 40 : undefined)),
        } as never,
      );

      const recovered = await service.resumableScenario(users[0].id);
      expect(recovered?.session.id).toBe(latestSession.id);
      expect(recovered?.template.title).toBe('Fixture hotel check-in');
      expect(recovered?.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
      expect(recovered?.turns[1].evaluation).toMatchObject({
        deferredFeedback: [{ natural: 'I’d like to check in.' }],
      });
      expect(recovered?.pendingRetry).toEqual(pendingMessage);
      expect(JSON.stringify(recovered)).not.toContain('ACCOUNT_B_PRIVATE_MESSAGE');

      const otherUserRecovery = await service.resumableScenario(users[1].id);
      expect(JSON.stringify(otherUserRecovery)).toContain('ACCOUNT_B_PRIVATE_MESSAGE');
      expect(otherUserRecovery?.session.id).toBe(otherUserSession.id);
      expect(await service.resumableScenario(users[2].id)).toBeNull();
      expect(ai.generateForUser).not.toHaveBeenCalled();
      expect(
        await prisma.scenarioTurn.findMany({
          where: { sessionId: { in: sessionIds } },
          orderBy: [{ sessionId: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            sessionId: true,
            clientMessageId: true,
            replyToTurnId: true,
            content: true,
          },
        }),
      ).toEqual(before);

      const retried = await service.takeTurn(
        users[0].id,
        latestSession.id,
        pendingMessage.content,
        pendingMessage.clientMessageId,
      );
      expect(retried.turn.role).toBe('assistant');
      expect(retried.session.turnCount).toBe(2);
      expect(ai.generateForUser).toHaveBeenCalledTimes(1);

      const replayed = await service.takeTurn(
        users[0].id,
        latestSession.id,
        pendingMessage.content,
        pendingMessage.clientMessageId,
      );
      expect(replayed.turn.id).toBe(retried.turn.id);
      expect(ai.generateForUser).toHaveBeenCalledTimes(1);
      expect(
        await prisma.scenarioTurn.count({
          where: {
            sessionId: latestSession.id,
            role: ScenarioTurnRole.USER,
            clientMessageId: pendingMessage.clientMessageId,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.scenarioTurn.count({
          where: { replyToTurnId: pendingTurn.id, role: ScenarioTurnRole.ASSISTANT },
        }),
      ).toBe(1);
      expect(
        await prisma.scenarioDailyUsage.findFirst({
          where: { userId: users[0].id },
          select: { count: true },
        }),
      ).toEqual({ count: 1 });
    } finally {
      if (userIds.length) {
        await prisma.aiCallAudit.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.scenarioTemplate.deleteMany({ where: { id: templateId } });
      await prisma.$disconnect();
    }
  });
});
