import { PrismaClient, StudyPlanStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'recoverable study plan pagination in an isolated database',
  () => {
    it('keeps old unfinished plans reachable, account-scoped, and stable across new records', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);
      const statuses = [StudyPlanStatus.GENERATING, StudyPlanStatus.ACTIVE, StudyPlanStatus.FAILED];
      const createdAt = new Date('2026-10-01T08:00:00.000Z');
      const planIds = Array.from(
        { length: 23 },
        (_, index) => `recover-${fixtureId}-${String(index).padStart(2, '0')}`,
      );

      try {
        const [owner, other] = await Promise.all(
          ['owner', 'other'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `study-plan-recovery-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(owner.id, other.id);
        const emptyPage = await service.listRecoverablePlans(other.id);
        expect(emptyPage).toEqual({ items: [], hasMore: false, nextCursor: null });
        await Promise.all(
          planIds.map((id, index) =>
            prisma.studyPlan.create({
              data: {
                id,
                userId: owner.id,
                status: statuses[index % statuses.length],
                generationError:
                  statuses[index % statuses.length] === StudyPlanStatus.FAILED
                    ? 'secret-bearing raw error Bearer hidden-fixture-secret'
                    : null,
                createdAt,
              },
              select: { id: true },
            }),
          ),
        );
        await prisma.studyPlan.create({
          data: {
            id: `completed-${fixtureId}`,
            userId: owner.id,
            status: StudyPlanStatus.COMPLETED,
            createdAt: new Date(createdAt.getTime() + 10_000),
          },
        });
        await prisma.studyPlan.create({
          data: {
            id: `other-${fixtureId}`,
            userId: other.id,
            status: StudyPlanStatus.ACTIVE,
            createdAt: new Date(createdAt.getTime() + 20_000),
          },
        });

        const firstPage = await service.listRecoverablePlans(owner.id, undefined, 20);
        expect(firstPage.items).toHaveLength(20);
        expect(firstPage.hasMore).toBe(true);
        expect(firstPage.items.map((plan) => plan.id)).toEqual(
          planIds.slice().reverse().slice(0, 20),
        );
        expect(firstPage.items.every((plan) => plan.status !== StudyPlanStatus.COMPLETED)).toBe(
          true,
        );
        expect(firstPage.items.some((plan) => plan.id === `other-${fixtureId}`)).toBe(false);
        expect(JSON.stringify(firstPage)).not.toContain('hidden-fixture-secret');

        await prisma.studyPlan.create({
          data: {
            id: `inserted-between-pages-${fixtureId}`,
            userId: owner.id,
            status: StudyPlanStatus.FAILED,
            createdAt: new Date(createdAt.getTime() + 30_000),
          },
        });
        const secondPage = await service.listRecoverablePlans(
          owner.id,
          firstPage.nextCursor ?? undefined,
          20,
        );
        expect(secondPage.items.map((plan) => plan.id)).toEqual(
          planIds.slice().reverse().slice(20),
        );
        expect(secondPage.hasMore).toBe(false);

        await expect(
          service.listRecoverablePlans(other.id, firstPage.nextCursor ?? undefined, 20),
        ).rejects.toThrow('学习计划游标无效');
        await expect(service.listRecoverablePlans(owner.id, 'invalid-cursor!', 20)).rejects.toThrow(
          '学习计划游标无效',
        );
      } finally {
        await prisma.studyPlan.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    });
  },
);
