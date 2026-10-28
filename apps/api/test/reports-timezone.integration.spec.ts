import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportsService } from '../src/modules/reports/reports.service';

describe.skipIf(!process.env.PRACTICE_TEST_DATABASE_URL)(
  'learning statistics time zone boundaries',
  () => {
    afterEach(() => vi.useRealTimers());

    it('groups learning events by the learner local date and excludes other users', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.PRACTICE_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const [learner, otherLearner] = await Promise.all([
        prisma.user.create({
          data: {
            email: `reports-timezone-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
        }),
        prisma.user.create({
          data: {
            email: `reports-timezone-other-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
        }),
      ]);

      try {
        await prisma.learningEvent.createMany({
          data: [
            {
              userId: learner.id,
              type: 'OUTPUT_COMPLETED',
              createdAt: new Date('2026-10-26T15:59:00.000Z'),
            },
            {
              userId: learner.id,
              type: 'OUTPUT_COMPLETED',
              createdAt: new Date('2026-10-26T16:00:00.000Z'),
            },
            {
              userId: learner.id,
              type: 'OUTPUT_COMPLETED',
              createdAt: new Date('2026-10-20T15:59:59.999Z'),
            },
            {
              userId: otherLearner.id,
              type: 'OUTPUT_COMPLETED',
              createdAt: new Date('2026-10-26T16:00:00.000Z'),
            },
          ],
        });
        vi.setSystemTime(new Date('2026-10-27T00:30:00.000Z'));

        const reports = new ReportsService(prisma as never, {} as never);
        const statistics = await reports.statistics(learner.id, 7, 'Asia/Shanghai');

        expect(statistics.activity[5]).toMatchObject({
          label: '10 月 26 日',
          practiceSessions: 1,
        });
        expect(statistics.activity[6]).toMatchObject({
          label: '10 月 27 日',
          practiceSessions: 1,
          today: true,
        });
        expect(statistics.activeDays).toBe(2);
      } finally {
        vi.useRealTimers();
        await prisma.user.deleteMany({ where: { id: { in: [learner.id, otherLearner.id] } } });
        await prisma.$disconnect();
      }
    });

    it('aggregates a bounded year of 2,500 learning events by local day', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.PRACTICE_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const learner = await prisma.user.create({
        data: {
          email: `reports-performance-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
      });

      try {
        const todayStart = new Date('2026-10-26T16:00:00.000Z').getTime();
        await prisma.learningEvent.createMany({
          data: Array.from({ length: 2500 }, (_, index) => ({
            userId: learner.id,
            type: 'OUTPUT_COMPLETED',
            createdAt: new Date(todayStart - (index % 365) * 86_400_000 + (index % 7) * 1000),
          })),
        });
        vi.setSystemTime(new Date('2026-10-27T00:30:00.000Z'));
        const reports = new ReportsService(prisma as never, {} as never);

        const startedAt = performance.now();
        const statistics = await reports.statistics(learner.id, 365, 'Asia/Shanghai');
        const elapsedMs = Math.round(performance.now() - startedAt);

        expect(statistics.activity).toHaveLength(365);
        expect(statistics.activeDays).toBe(365);
        expect(statistics.activity.reduce((sum, day) => sum + (day.practiceSessions ?? 0), 0)).toBe(
          2500,
        );
        console.log(`report statistics sample: 2,500 events / 365 days in ${elapsedMs} ms`);
      } finally {
        vi.useRealTimers();
        await prisma.user.delete({ where: { id: learner.id } });
        await prisma.$disconnect();
      }
    });
  },
);
