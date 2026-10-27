import { PrismaClient, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'normal study-plan creation concurrency in an isolated database',
  () => {
    const clients: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
    });

    it('reuses one plan for concurrent requests from the same user without blocking another user', async () => {
      const databaseUrl = process.env.LAB_TEST_DATABASE_URL!;
      const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const serviceClients = [
        new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
        new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
      ];
      clients.push(admin, ...serviceClients);

      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const wordIds: string[] = [];
      const bookWordIds: string[] = [];
      const firstUser = { id: '' };
      let releaseDatabaseLock: (() => void) | undefined;
      let releaseProviderGate: (() => void) | undefined;
      let lockTransaction: Promise<unknown> | undefined;
      let firstUserRequests: Promise<unknown>[] = [];
      try {
        const createLearner = async (suffix: string) => {
          const user = await admin.user.create({
            data: {
              email: `study-plan-create-${fixtureId}-${suffix}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
              defaultNewWordCount: 1,
            },
            select: { id: true },
          });
          userIds.push(user.id);
          const book = await admin.vocabularyBook.create({
            data: {
              ownerId: user.id,
              kind: 'PERSONAL',
              sourceKey: `study-plan-create-${fixtureId}-${suffix}`,
              title: 'Study plan create concurrency test',
              sourcePath: 'test',
              category: 'GENERAL',
              bookWords: {
                create: {
                  position: 0,
                  word: {
                    create: {
                      normalized: `study-plan-create-${fixtureId}-${suffix}`,
                      text: 'steady',
                      meaning: '平稳的',
                    },
                  },
                },
              },
            },
            select: { id: true, bookWords: { select: { id: true, wordId: true } } },
          });
          await admin.userVocabularyBook.create({
            data: { userId: user.id, bookId: book.id, isDefault: true },
          });
          wordIds.push(book.bookWords[0].wordId);
          bookWordIds.push(book.bookWords[0].id);
          return user;
        };

        Object.assign(firstUser, await createLearner('one'));
        const secondUser = await createLearner('two');
        const requestCount = 8;
        let providerArrivals = 0;
        const providerGate = new Promise<void>((resolve) => {
          releaseProviderGate = resolve;
        });
        const selectedProvider = vi.fn(async (userId: string) => {
          if (userId === firstUser.id) {
            providerArrivals++;
            if (providerArrivals === requestCount) releaseProviderGate?.();
            await providerGate;
          }
          return { id: 'isolated-fixture-model' };
        });
        const ai = { generateForUser: vi.fn() };
        const services = serviceClients.map(
          (client) =>
            new StudyService(
              client as never,
              ai as never,
              { selectedProvider } as never,
              {} as never,
            ),
        );

        let notifyLockHeld!: () => void;
        const lockHeld = new Promise<void>((resolve) => {
          notifyLockHeld = resolve;
        });
        const databaseLockRelease = new Promise<void>((resolve) => {
          releaseDatabaseLock = resolve;
        });
        lockTransaction = admin.$transaction(async (tx) => {
          await tx.$queryRaw`
              SELECT pg_advisory_xact_lock(hashtextextended(${firstUser.id}, 0)) IS NULL
            `;
          notifyLockHeld();
          await databaseLockRelease;
        });
        await lockHeld;

        firstUserRequests = Array.from({ length: requestCount }, (_, index) =>
          services[index % services.length].createPlan(firstUser.id, 1),
        );
        await vi.waitFor(() => expect(providerArrivals).toBe(requestCount));
        releaseProviderGate?.();
        await vi.waitFor(
          async () => {
            const waiters = await admin.$queryRaw<Array<{ count: bigint }>>`
                SELECT COUNT(*)::bigint AS count
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
                  AND wait_event = 'advisory'
                  AND query LIKE '%pg_advisory_xact_lock%'
                  AND pid <> pg_backend_pid()
              `;
            expect(Number(waiters[0].count)).toBeGreaterThanOrEqual(requestCount);
          },
          { timeout: 15_000, interval: 50 },
        );
        expect(
          await admin.studyPlan.count({
            where: { userId: firstUser.id, purpose: StudyPlanPurpose.NORMAL },
          }),
        ).toBe(0);

        let independenceTimer: NodeJS.Timeout | undefined;
        const independentPlan = await Promise.race([
          services[0].createPlan(secondUser.id, 1),
          new Promise<never>((_, reject) => {
            independenceTimer = setTimeout(
              () => reject(new Error('a different user was blocked by the plan lock')),
              5_000,
            );
          }),
        ]).finally(() => clearTimeout(independenceTimer));
        expect(independentPlan.id).toBeTruthy();
        expect(independentPlan.id).not.toBe(firstUser.id);
        expect(
          await admin.studyPlan.count({
            where: { userId: secondUser.id, purpose: StudyPlanPurpose.NORMAL },
          }),
        ).toBe(1);

        releaseDatabaseLock?.();
        await lockTransaction;
        const plans = await Promise.all(firstUserRequests);
        const planIds = new Set(plans.map((plan) => (plan as { id: string }).id));
        expect(planIds.size).toBe(1);
        const planId = [...planIds][0];
        expect(
          await admin.studyPlan.count({
            where: { userId: firstUser.id, purpose: StudyPlanPurpose.NORMAL },
          }),
        ).toBe(1);
        expect(await admin.studyPlanItem.count({ where: { planId } })).toBe(1);
        expect(await admin.userWordProgress.count({ where: { userId: firstUser.id } })).toBe(0);
        expect(await admin.wordReviewAttempt.count({ where: { userId: firstUser.id } })).toBe(0);
        expect(ai.generateForUser).not.toHaveBeenCalled();
      } finally {
        releaseProviderGate?.();
        releaseDatabaseLock?.();
        await lockTransaction?.catch(() => undefined);
        await Promise.allSettled(firstUserRequests);
        if (userIds.length) {
          await admin.user.deleteMany({ where: { id: { in: userIds } } });
        }
        if (bookWordIds.length) {
          await admin.vocabularyBookWord.deleteMany({ where: { id: { in: bookWordIds } } });
        }
        if (wordIds.length)
          await admin.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
        await admin.vocabularyBook.deleteMany({
          where: { sourceKey: { startsWith: `study-plan-create-${fixtureId}-` } },
        });
      }
    }, 30_000);
  },
);
