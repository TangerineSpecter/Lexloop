import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportsService } from '../src/modules/reports/reports.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('career report learner time zone', () => {
  afterEach(() => vi.useRealTimers());

  it('groups active days and overdue reviews by the requested local calendar without crossing accounts', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const sourceKey = `career-timezone-${fixtureId}`;
    const normalized = `career-timezone-${fixtureId}-steady`;
    const userIds: string[] = [];

    try {
      const [learner, otherLearner] = await Promise.all(
        ['learner', 'other'].map((suffix) =>
          prisma.user.create({
            data: {
              email: `career-timezone-${fixtureId}-${suffix}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
            },
            select: { id: true },
          }),
        ),
      );
      userIds.push(learner.id, otherLearner.id);

      const book = await prisma.vocabularyBook.create({
        data: {
          kind: 'SYSTEM',
          sourceKey,
          title: 'Career time zone fixture',
          sourcePath: 'test',
          category: 'GENERAL',
          bookWords: {
            create: {
              position: 0,
              word: { create: { normalized, text: 'steady', meaning: '平稳的' } },
            },
          },
        },
        select: { bookWords: { select: { id: true } } },
      });

      await prisma.userWordProgress.create({
        data: {
          userId: learner.id,
          bookWordId: book.bookWords[0].id,
          state: 'REVIEWING',
          nextReviewAt: new Date('2026-10-28T12:00:00.000Z'),
        },
      });
      await prisma.studyPlan.createMany({
        data: [new Date('2026-10-28T06:30:00.000Z'), new Date('2026-10-28T07:30:00.000Z')].map(
          (completedAt) => ({
            userId: learner.id,
            mode: 'GROUP',
            purpose: 'NORMAL',
            status: 'COMPLETED',
            completedAt,
          }),
        ),
      });
      await prisma.learningEvent.createMany({
        data: [
          {
            userId: learner.id,
            type: 'OUTPUT_COMPLETED',
            createdAt: new Date('2026-10-27T02:00:00.000Z'),
          },
          {
            userId: learner.id,
            type: 'MICRO_STORY_COMPLETED',
            createdAt: new Date('2026-10-27T04:00:00.000Z'),
          },
          {
            userId: otherLearner.id,
            type: 'GRAMMAR_COMPLETED',
            createdAt: new Date('2026-10-24T18:00:00.000Z'),
          },
        ],
      });

      vi.setSystemTime(new Date('2026-10-29T02:00:00.000Z'));
      const reports = new ReportsService(prisma as never, {} as never);
      const losAngeles = await reports.career(learner.id, 'America/Los_Angeles');
      const shanghai = await reports.career(learner.id, 'Asia/Shanghai');
      const legacyClient = await reports.career(learner.id);
      const processTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const explicitProcessTimeZone = await reports.career(learner.id, processTimeZone);
      const otherAccount = await reports.career(otherLearner.id, 'America/Los_Angeles');

      expect(losAngeles.overview.activeDays).toBe(3);
      expect(losAngeles.memory).toMatchObject({ dueWords: 1, overdueWords: 0 });
      expect(shanghai.overview.activeDays).toBe(2);
      expect(shanghai.memory).toMatchObject({ dueWords: 1, overdueWords: 1 });
      expect(legacyClient.overview.activeDays).toBe(explicitProcessTimeZone.overview.activeDays);
      expect(legacyClient.memory).toMatchObject(explicitProcessTimeZone.memory);
      expect(otherAccount.overview.activeDays).toBe(1);
      expect(otherAccount.memory).toMatchObject({ dueWords: 0, overdueWords: 0 });
      await expect(reports.career(learner.id, 'invalid-time-zone')).rejects.toThrow(
        'Invalid time zone',
      );
    } finally {
      vi.useRealTimers();
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
      await prisma.vocabularyWord.deleteMany({ where: { normalized } });
      await prisma.$disconnect();
    }
  });

  it('keeps career date grouping bounded with 5,000 saved activity records', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const learner = await prisma.user.create({
      data: {
        email: `career-timezone-performance-${fixtureId}@example.invalid`,
        passwordHash: 'isolated-test-fixture',
      },
      select: { id: true },
    });
    const now = new Date('2026-10-29T18:00:00.000Z');

    try {
      await prisma.studyPlan.createMany({
        data: Array.from({ length: 2_500 }, (_, index) => ({
          userId: learner.id,
          mode: 'GROUP',
          purpose: 'NORMAL',
          status: 'COMPLETED',
          completedAt: new Date(now.getTime() - (index % 365) * 86_400_000),
        })),
      });
      await prisma.learningEvent.createMany({
        data: Array.from({ length: 2_500 }, (_, index) => ({
          userId: learner.id,
          type: index % 2 ? 'OUTPUT_COMPLETED' : 'READING_COMPLETED',
          createdAt: new Date(now.getTime() - (index % 365) * 86_400_000),
        })),
      });
      vi.setSystemTime(now);
      const reports = new ReportsService(prisma as never, {} as never);
      const startedAt = performance.now();
      const career = await reports.career(learner.id, 'America/Los_Angeles');
      const elapsedMs = Math.round(performance.now() - startedAt);

      expect(career.overview.activeDays).toBe(365);
      console.log(
        `career date grouping: 2,500 plans + 2,500 events / 365 active days in ${elapsedMs} ms`,
      );
    } finally {
      vi.useRealTimers();
      await prisma.user.delete({ where: { id: learner.id } });
      await prisma.$disconnect();
    }
  });
});
