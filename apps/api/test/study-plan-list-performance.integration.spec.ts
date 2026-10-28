import { PrismaClient, StudyPlanItemSource, StudyPlanStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'study-plan list loading in an isolated database',
  () => {
    it('loads ordered plans with bounded database reads and keeps the list user-scoped', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
        log: [{ emit: 'event', level: 'query' }],
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const normalizedWords = Array.from(
        { length: 20 },
        (_, index) => `study-plan-list-${fixtureId}-${index}`,
      );
      const bookSourceKey = `study-plan-list-${fixtureId}`;
      const studyPlanQueries: string[] = [];
      prisma.$on('query', (event) => {
        if (/FROM\s+"public"\."StudyPlan"/i.test(event.query)) studyPlanQueries.push(event.query);
      });
      const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);

      try {
        const users = await Promise.all(
          ['owner', 'other'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `study-plan-list-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map(({ id }) => id));
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: users[0].id,
            kind: 'PERSONAL',
            sourceKey: bookSourceKey,
            title: 'Study plan list performance fixture',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: normalizedWords.map((normalized, position) => ({
                position,
                word: {
                  create: { normalized, text: `planword${position}`, meaning: '计划读取测试词' },
                },
              })),
            },
          },
          select: { id: true, bookWords: { select: { id: true } } },
        });
        const timestamp = Date.now();
        const plans = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            prisma.studyPlan.create({
              data: {
                userId: users[0].id,
                status: StudyPlanStatus.COMPLETED,
                generatedContent: { groups: [] },
                createdAt: new Date(timestamp + index * 1_000),
                completedAt: new Date(timestamp + index * 1_000),
              },
              select: { id: true },
            }),
          ),
        );
        await prisma.studyPlan.create({
          data: {
            userId: users[1].id,
            status: StudyPlanStatus.COMPLETED,
            generatedContent: { groups: [] },
            createdAt: new Date(timestamp + 30_000),
            completedAt: new Date(timestamp + 30_000),
          },
        });
        await prisma.studyPlanItem.createMany({
          data: plans.map((plan, index) => ({
            planId: plan.id,
            bookWordId: book.bookWords[index].id,
            source: StudyPlanItemSource.NEW,
            groupIndex: 0,
            completedAt: new Date(timestamp + index * 1_000),
          })),
        });

        studyPlanQueries.length = 0;
        const listStartedAt = performance.now();
        const listed = await service.listPlans(users[0].id);
        const listDurationMs = performance.now() - listStartedAt;
        const listQueryCount = studyPlanQueries.length;
        expect(listed).toHaveLength(20);
        expect(listed.map((plan) => plan.id)).toEqual([...plans].reverse().map((plan) => plan.id));
        expect(listed.every((plan) => plan.words.length === 1 && plan.completed === 1)).toBe(true);

        studyPlanQueries.length = 0;
        const pageStartedAt = performance.now();
        const page = await service.listCompletedPlans(users[0].id, 1, 10);
        const pageDurationMs = performance.now() - pageStartedAt;
        const pageQueryCount = studyPlanQueries.length;
        expect(page.items).toHaveLength(10);
        expect(page.hasMore).toBe(true);
        expect(page.items.map((plan) => plan.id)).toEqual(
          [...plans]
            .reverse()
            .slice(0, 10)
            .map((plan) => plan.id),
        );
        expect(page.items.every((plan) => plan.words.length === 1)).toBe(true);

        console.log(
          `study plan reads: list ${listQueryCount} root queries/${listDurationMs.toFixed(1)} ms; completed page ${pageQueryCount} root queries/${pageDurationMs.toFixed(1)} ms (20 plans, 1 item each)`,
        );
        expect(listQueryCount).toBe(1);
        expect(pageQueryCount).toBe(1);
      } finally {
        await prisma.studyPlan.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey: bookSourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalizedWords } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    });
  },
);
