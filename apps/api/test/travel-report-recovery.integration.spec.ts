import {
  CefrLevel,
  PrismaClient,
  ScenarioCategory,
  ScenarioOutcome,
  ScenarioSessionStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TravelService } from '../src/modules/travel/travel.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('travel report recovery', () => {
  it('returns only the current learner’s newest saved report without writes or model calls', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const templateId = `report-recovery-${fixtureId}`;
    const userIds: string[] = [];

    try {
      const users = await Promise.all(
        ['one', 'two', 'empty'].map((label) =>
          prisma.user.create({
            data: {
              email: `travel-report-${label}-${fixtureId}@example.invalid`,
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
          description: 'Confirm an existing reservation.',
          userRole: 'traveller',
          aiRole: 'receptionist',
          minTurns: 1,
          maxTurns: 6,
          objectives: ['Confirm a reservation'],
          starterPhrases: ['I have a reservation.'],
          grammarFrames: [
            {
              intent: 'Confirm a reservation',
              natural: 'I have a reservation under…',
              frame: 'I have a reservation under + name',
              explanation: 'Use under to give the booking name.',
            },
          ],
          difficultyVariants: {
            A1: 'short',
            A2: 'clear',
            B1: 'natural',
            B2: 'detailed',
            C1: 'nuanced',
          },
        },
      });

      const sessions = await Promise.all(
        [
          { user: users[0], label: 'older-a', at: '2026-10-01T10:00:00.000Z', outcome: 'old' },
          {
            user: users[0],
            label: 'latest-a',
            at: '2026-10-02T10:00:00.000Z',
            outcome: 'A_PRIVATE_LATEST_REPORT',
          },
          {
            user: users[1],
            label: 'latest-b',
            at: '2026-10-03T10:00:00.000Z',
            outcome: 'B_PRIVATE_REPORT',
          },
        ].map(async (fixture) => {
          const completedAt = new Date(fixture.at);
          const session = await prisma.scenarioSession.create({
            data: {
              userId: fixture.user.id,
              templateId,
              level: CefrLevel.A1,
              status: ScenarioSessionStatus.COMPLETED,
              completedAt,
              startedAt: completedAt,
            },
            select: { id: true },
          });
          await prisma.scenarioReport.create({
            data: {
              sessionId: session.id,
              outcome: ScenarioOutcome.PARTIAL,
              dimensionScores: {
                vocabulary: 61,
                grammar: 62,
                sentenceBuilding: 63,
                taskCompletion: 64,
                naturalness: 65,
              },
              rewrites: [
                {
                  type: 'naturalness',
                  original: fixture.outcome,
                  natural: `${fixture.outcome} corrected`,
                  explanation: 'Use a polite request.',
                },
              ],
              grammarFrames: [],
              evidence: [{ objective: 'Confirm a reservation', completed: false }],
              vocabulary: [],
              recommendation: 'Try the request again in a new context.',
            },
          });
          return session.id;
        }),
      );
      const completedWithoutTimestamp = await prisma.scenarioSession.create({
        data: {
          userId: users[0].id,
          templateId,
          level: CefrLevel.A1,
          status: ScenarioSessionStatus.COMPLETED,
          startedAt: new Date('2026-10-05T10:00:00.000Z'),
        },
        select: { id: true },
      });
      sessions.push(completedWithoutTimestamp.id);
      await prisma.scenarioReport.create({
        data: {
          sessionId: completedWithoutTimestamp.id,
          outcome: ScenarioOutcome.PARTIAL,
          dimensionScores: {
            vocabulary: 0,
            grammar: 0,
            sentenceBuilding: 0,
            taskCompletion: 0,
            naturalness: 0,
          },
          rewrites: [],
          grammarFrames: [],
          evidence: [],
          vocabulary: [],
          recommendation: 'Timestamp unavailable.',
        },
      });
      const emptyCompleted = await prisma.scenarioSession.create({
        data: {
          userId: users[2].id,
          templateId,
          level: CefrLevel.A1,
          status: ScenarioSessionStatus.COMPLETED,
          completedAt: new Date('2026-10-04T10:00:00.000Z'),
        },
        select: { id: true },
      });

      const before = {
        sessions: await prisma.scenarioSession.count({
          where: { id: { in: [...sessions, emptyCompleted.id] } },
        }),
        reports: await prisma.scenarioReport.count({ where: { sessionId: { in: sessions } } }),
        profiles: await prisma.languageProfile.count({ where: { userId: { in: userIds } } }),
        skills: await prisma.userSkillProgress.count({ where: { userId: { in: userIds } } }),
      };
      const ai = { generateForUser: vi.fn() };
      const service = new TravelService(prisma as never, ai as never, { get: vi.fn() } as never);

      const learnerA = await service.latestScenarioReport(users[0].id);
      expect(learnerA?.session.id).toBe(sessions[1]);
      expect(learnerA?.template.title).toBe('Fixture hotel check-in');
      expect(learnerA?.completedAt.toISOString()).toBe('2026-10-02T10:00:00.000Z');
      expect(learnerA?.report.rewrites).toMatchObject([
        { original: 'A_PRIVATE_LATEST_REPORT', natural: 'A_PRIVATE_LATEST_REPORT corrected' },
      ]);

      const learnerB = await service.latestScenarioReport(users[1].id);
      expect(learnerB?.session.id).toBe(sessions[2]);
      expect(JSON.stringify(learnerB)).toContain('B_PRIVATE_REPORT');
      expect(JSON.stringify(learnerB)).not.toContain('A_PRIVATE_LATEST_REPORT');
      expect(await service.latestScenarioReport(users[2].id)).toBeNull();

      expect(ai.generateForUser).not.toHaveBeenCalled();
      expect({
        sessions: await prisma.scenarioSession.count({
          where: { id: { in: [...sessions, emptyCompleted.id] } },
        }),
        reports: await prisma.scenarioReport.count({ where: { sessionId: { in: sessions } } }),
        profiles: await prisma.languageProfile.count({ where: { userId: { in: userIds } } }),
        skills: await prisma.userSkillProgress.count({ where: { userId: { in: userIds } } }),
      }).toEqual(before);
    } finally {
      if (userIds.length) {
        await prisma.aiCallAudit.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.scenarioTemplate.deleteMany({ where: { id: templateId } });
      await prisma.$disconnect();
    }
  });

  it('uses the owner and completion index to read one report from a representative history', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const templateId = `report-history-${fixtureId}`;
    let userId: string | undefined;

    try {
      const user = await prisma.user.create({
        data: {
          email: `travel-report-history-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      userId = user.id;
      await prisma.scenarioTemplate.create({
        data: {
          id: templateId,
          slug: templateId,
          category: ScenarioCategory.HOTEL,
          title: 'Fixture hotel check-in',
          description: 'Confirm an existing reservation.',
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

      const rowCount = 2500;
      const baseTime = new Date('2026-10-01T00:00:00.000Z');
      const ids = Array.from({ length: rowCount }, (_, index) => `${fixtureId}-session-${index}`);
      const sessions = ids.map((id, index) => {
        const completedAt = new Date(baseTime.getTime() + index * 60_000);
        return {
          id,
          userId: user.id,
          templateId,
          level: CefrLevel.A1,
          status: ScenarioSessionStatus.COMPLETED,
          startedAt: completedAt,
          completedAt,
        };
      });
      await prisma.scenarioSession.createMany({ data: sessions });
      await prisma.scenarioReport.createMany({
        data: ids.map((sessionId) => ({
          sessionId,
          outcome: ScenarioOutcome.PARTIAL,
          dimensionScores: {
            vocabulary: 60,
            grammar: 60,
            sentenceBuilding: 60,
            taskCompletion: 60,
            naturalness: 60,
          },
          rewrites: [],
          grammarFrames: [],
          evidence: [],
          vocabulary: [],
          recommendation: 'Continue practicing in another context.',
        })),
      });
      await prisma.$executeRaw`ANALYZE "ScenarioSession"`;
      const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT s."id"
        FROM "ScenarioSession" AS s
        WHERE s."userId" = ${user.id}
          AND s."status" = 'COMPLETED'
          AND s."completedAt" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM "ScenarioReport" AS r WHERE r."sessionId" = s."id"
          )
        ORDER BY s."completedAt" DESC, s."id" DESC
        LIMIT 1
      `;
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'ScenarioSession_userId_status_completedAt_id_idx',
      );

      const ai = { generateForUser: vi.fn() };
      const service = new TravelService(prisma as never, ai as never, { get: vi.fn() } as never);
      const startedAt = performance.now();
      const latest = await service.latestScenarioReport(user.id);
      const elapsedMs = Math.round(performance.now() - startedAt);
      expect(latest?.session.id).toBe(ids.at(-1));
      expect(ai.generateForUser).not.toHaveBeenCalled();
      console.info(`travel latest-report lookup: ${rowCount} reports in ${elapsedMs} ms`);
    } finally {
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.scenarioTemplate.deleteMany({ where: { id: templateId } });
      await prisma.$disconnect();
    }
  }, 60_000);
});
