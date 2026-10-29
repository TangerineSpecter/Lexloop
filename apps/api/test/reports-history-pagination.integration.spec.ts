import {
  AssessmentStatus,
  CefrLevel,
  PrismaClient,
  ScenarioCategory,
  ScenarioOutcome,
  ScenarioSessionStatus,
  StudyPlanStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LearningHistoryItem } from '@lexloop/types';
import { ReportsService } from '../src/modules/reports/reports.service';

const historyIndexMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261029120000_learning_history_cursor_indexes/migration.sql',
  ),
  'utf8',
);

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'learning-history cursor pagination in an isolated database',
  () => {
    it('applies the index migration over existing rows without changing them', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const schemaName = `history_upgrade_${randomUUID().replaceAll('-', '')}`;

      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaName}"`);
          await tx.$executeRawUnsafe(
            'CREATE TABLE "StudyPlan" ("id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL, "completedAt" timestamp(3))',
          );
          await tx.$executeRawUnsafe(
            'CREATE TABLE "AssessmentAttempt" ("id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL, "completedAt" timestamp(3))',
          );
          await tx.$executeRaw`INSERT INTO "StudyPlan" ("id", "userId", "status", "completedAt") VALUES
            ('existing-plan-a', 'learner-a', 'COMPLETED', '2026-10-27T08:00:00.000Z'),
            ('existing-plan-b', 'learner-b', 'COMPLETED', '2026-10-28T08:00:00.000Z')`;
          await tx.$executeRaw`INSERT INTO "AssessmentAttempt" ("id", "userId", "status", "completedAt") VALUES
            ('existing-assessment-a', 'learner-a', 'COMPLETED', '2026-10-27T09:00:00.000Z'),
            ('existing-assessment-b', 'learner-b', 'COMPLETED', '2026-10-28T09:00:00.000Z')`;

          const beforePlans = await tx.$queryRaw`
            SELECT "id", "userId", "status", "completedAt" FROM "StudyPlan" ORDER BY "id"
          `;
          const beforeAssessments = await tx.$queryRaw`
            SELECT "id", "userId", "status", "completedAt" FROM "AssessmentAttempt" ORDER BY "id"
          `;
          for (const statement of historyIndexMigration.split(';').map((part) => part.trim())) {
            if (statement) await tx.$executeRawUnsafe(statement);
          }

          const afterPlans = await tx.$queryRaw`
            SELECT "id", "userId", "status", "completedAt" FROM "StudyPlan" ORDER BY "id"
          `;
          const afterAssessments = await tx.$queryRaw`
            SELECT "id", "userId", "status", "completedAt" FROM "AssessmentAttempt" ORDER BY "id"
          `;
          const indexes = await tx.$queryRawUnsafe<Array<{ indexname: string }>>(
            'SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname',
            schemaName,
          );

          expect(afterPlans).toEqual(beforePlans);
          expect(afterAssessments).toEqual(beforeAssessments);
          expect(indexes.map(({ indexname }) => indexname)).toEqual([
            'AssessmentAttempt_pkey',
            'AssessmentAttempt_userId_status_completedAt_id_idx',
            'StudyPlan_pkey',
            'StudyPlan_userId_status_completedAt_id_idx',
          ]);
        });
      } finally {
        await prisma
          .$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
          .catch(() => undefined);
        await prisma.$disconnect();
      }
    });

    it('merges all sources without gaps, preserves ties, scopes foreign cursors, and bounds every page', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const templateId = `history-pagination-${fixtureId}`;
      const userIds: string[] = [];

      try {
        const users = await Promise.all(
          ['owner', 'other'].map((owner) =>
            prisma.user.create({
              data: {
                email: `history-pagination-${fixtureId}-${owner}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map(({ id }) => id));

        const tieId = `history-00-tie-${fixtureId}`;
        const tieTime = new Date('2026-10-29T12:00:00.000Z');
        const ownerPlans = [
          {
            id: tieId,
            userId: users[0].id,
            status: StudyPlanStatus.COMPLETED,
            completedAt: tieTime,
          },
          ...Array.from({ length: 45 }, (_, index) => ({
            id: `history-plan-${fixtureId}-${String(index).padStart(3, '0')}`,
            userId: users[0].id,
            status: StudyPlanStatus.COMPLETED,
            completedAt: index < 9 ? tieTime : new Date(tieTime.getTime() - (index + 1) * 1_000),
          })),
        ];
        const ownerAssessments = [
          {
            id: tieId,
            userId: users[0].id,
            status: AssessmentStatus.COMPLETED,
            completedAt: tieTime,
          },
          ...Array.from({ length: 45 }, (_, index) => ({
            id: `history-assessment-${fixtureId}-${String(index).padStart(3, '0')}`,
            userId: users[0].id,
            status: AssessmentStatus.COMPLETED,
            completedAt: index < 9 ? tieTime : new Date(tieTime.getTime() - (index + 1) * 1_000),
          })),
        ];
        const otherPlans = Array.from({ length: 4 }, (_, index) => ({
          id: `other-plan-${fixtureId}-${index}`,
          userId: users[1].id,
          status: StudyPlanStatus.COMPLETED,
          completedAt: new Date(tieTime.getTime() - 600_000 - index * 1_000),
        }));
        const otherAssessments = Array.from({ length: 4 }, (_, index) => ({
          id: `other-assessment-${fixtureId}-${index}`,
          userId: users[1].id,
          status: AssessmentStatus.COMPLETED,
          completedAt: new Date(tieTime.getTime() - 600_000 - index * 1_000),
        }));
        await prisma.studyPlan.createMany({ data: [...ownerPlans, ...otherPlans] });
        await prisma.assessmentAttempt.createMany({
          data: [...ownerAssessments, ...otherAssessments],
        });

        await prisma.scenarioTemplate.create({
          data: {
            id: templateId,
            slug: templateId,
            category: ScenarioCategory.HOTEL,
            title: 'Pagination fixture',
            description: 'A fixture scenario.',
            userRole: 'traveller',
            aiRole: 'receptionist',
            objectives: ['Check in'],
            starterPhrases: ['I have a booking.'],
            grammarFrames: [],
            difficultyVariants: { A1: 'short' },
          },
        });
        await prisma.scenarioSession.create({
          data: {
            id: tieId,
            userId: users[0].id,
            templateId,
            level: CefrLevel.A1,
            status: ScenarioSessionStatus.COMPLETED,
            startedAt: tieTime,
            completedAt: tieTime,
            report: {
              create: {
                outcome: ScenarioOutcome.PARTIAL,
                dimensionScores: {},
                rewrites: [],
                grammarFrames: [],
                evidence: [],
                vocabulary: [],
                recommendation: 'Try again in another context.',
              },
            },
          },
        });

        const ai = { generateForUser: vi.fn() };
        const service = new ReportsService(prisma as never, ai as never);
        const kindRank: Record<LearningHistoryItem['kind'], number> = {
          PLAN: 0,
          ASSESSMENT: 1,
          SCENARIO: 2,
        };
        const expected: Array<Pick<LearningHistoryItem, 'kind' | 'id' | 'occurredAt'>> = [
          ...ownerPlans.map((plan) => ({
            kind: 'PLAN' as const,
            id: plan.id,
            occurredAt: plan.completedAt.toISOString(),
          })),
          ...ownerAssessments.map((attempt) => ({
            kind: 'ASSESSMENT' as const,
            id: attempt.id,
            occurredAt: attempt.completedAt.toISOString(),
          })),
          { kind: 'SCENARIO' as const, id: tieId, occurredAt: tieTime.toISOString() },
        ].sort(
          (left, right) =>
            new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime() ||
            right.id.localeCompare(left.id) ||
            kindRank[left.kind] - kindRank[right.kind],
        );

        const actual: LearningHistoryItem[] = [];
        const firstPage = await service.history(users[0].id, 1, 20);
        const firstPageCursor = firstPage.nextCursor;
        expect(firstPage.items).toHaveLength(20);
        expect(firstPageCursor).toBeTruthy();
        actual.push(...firstPage.items);

        const insertedDuringPagingId = `history-inserted-after-first-page-${fixtureId}`;
        await prisma.studyPlan.create({
          data: {
            id: insertedDuringPagingId,
            userId: users[0].id,
            status: StudyPlanStatus.COMPLETED,
            completedAt: new Date(tieTime.getTime() + 1_000),
          },
        });

        let cursor = firstPageCursor ?? undefined;
        for (let pageNumber = 1; cursor; pageNumber += 1) {
          const page = await service.history(users[0].id, 1, 20, cursor);
          expect(page.items.length).toBeLessThanOrEqual(20);
          actual.push(...page.items);
          if (!page.nextCursor) {
            expect(page.hasMore).toBe(false);
            cursor = undefined;
            break;
          }
          expect(page.hasMore).toBe(true);
          cursor = page.nextCursor;
          if (pageNumber === 9 && cursor) throw new Error('history pagination did not terminate');
        }

        expect(actual.map(({ kind, id, occurredAt }) => ({ kind, id, occurredAt }))).toEqual(
          expected,
        );
        expect(new Set(actual.map((item) => `${item.kind}:${item.id}`)).size).toBe(expected.length);
        expect(actual.slice(18, 21).map(({ kind, id }) => ({ kind, id }))).toEqual([
          { kind: 'PLAN', id: tieId },
          { kind: 'ASSESSMENT', id: tieId },
          { kind: 'SCENARIO', id: tieId },
        ]);
        expect(actual[19]).toMatchObject({ kind: 'ASSESSMENT', id: tieId });
        expect(actual[20]).toMatchObject({ kind: 'SCENARIO', id: tieId });
        expect(actual.some(({ id }) => id === insertedDuringPagingId)).toBe(false);
        const refreshedPage = await service.history(users[0].id, 1, 20);
        expect(refreshedPage.items[0]).toMatchObject({
          kind: 'PLAN',
          id: insertedDuringPagingId,
        });
        expect(actual.every((item) => !item.id.startsWith('other-'))).toBe(true);

        const otherPage = await service.history(users[1].id, 1, 20, firstPageCursor!);
        expect(otherPage.items).toHaveLength(8);
        expect(otherPage.items.every((item) => item.id.startsWith('other-'))).toBe(true);
        expect(otherPage.totals.records).toBe(8);
        expect(ai.generateForUser).not.toHaveBeenCalled();
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.scenarioTemplate.deleteMany({ where: { id: templateId } });
        await prisma.$disconnect();
      }
    }, 60_000);

    it('keeps a deep history page bounded with 5,000 synthetic records', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      let userId: string | undefined;

      try {
        const user = await prisma.user.create({
          data: {
            email: `history-pagination-perf-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const baseTime = new Date('2026-10-29T12:00:00.000Z');
        const rows = Array.from({ length: 2_500 }, (_, index) => ({
          id: `${String(index).padStart(4, '0')}-${fixtureId}`,
          userId: user.id,
          status: StudyPlanStatus.COMPLETED,
          completedAt: new Date(baseTime.getTime() - index * 1_000),
        }));
        await prisma.studyPlan.createMany({ data: rows });
        await prisma.assessmentAttempt.createMany({
          data: rows.map((row) => ({
            ...row,
            id: `assessment-${row.id}`,
            status: AssessmentStatus.COMPLETED,
          })),
        });

        const cursorPosition = {
          id: `assessment-${rows[1_500]!.id}`,
          occurredAt: rows[1_500]!.completedAt.toISOString(),
          kind: 'ASSESSMENT' as const,
        };
        const cursor = Buffer.from(JSON.stringify(cursorPosition)).toString('base64url');
        const service = new ReportsService(prisma as never, { generateForUser: vi.fn() } as never);
        const startedAt = performance.now();
        const page = await service.history(user.id, 1, 20, cursor);
        const durationMs = Number((performance.now() - startedAt).toFixed(1));

        expect(page.items).toHaveLength(20);
        expect(page.hasMore).toBe(true);
        expect(page.totals.records).toBe(5_000);
        const kindRank: Record<LearningHistoryItem['kind'], number> = {
          PLAN: 0,
          ASSESSMENT: 1,
          SCENARIO: 2,
        };
        expect(
          page.items.every((item) => {
            const itemTime = new Date(item.occurredAt).getTime();
            const cursorTime = new Date(cursorPosition.occurredAt).getTime();
            return (
              itemTime < cursorTime ||
              (itemTime === cursorTime &&
                (item.id.localeCompare(cursorPosition.id) < 0 ||
                  (item.id === cursorPosition.id &&
                    kindRank[item.kind] > kindRank[cursorPosition.kind])))
            );
          }),
        ).toBe(true);
        expect(durationMs).toBeLessThan(10_000);
        console.log(
          `learning-history deep page: 5,000 synthetic records / 20 returned / ${durationMs} ms`,
        );
      } finally {
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
