import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeeklyService } from '../src/modules/practice/weekly.service';

describe.skipIf(!process.env.PRACTICE_TEST_DATABASE_URL)(
  'weekly prescription calendar boundaries',
  () => {
    afterEach(() => vi.useRealTimers());

    it('excludes the eighth local date when the seven-day range crosses spring DST', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.PRACTICE_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const user = await prisma.user.create({
        data: {
          email: `weekly-calendar-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
      });

      try {
        await prisma.wordReviewAttempt.createMany({
          data: [
            {
              userId: user.id,
              bookWordId: `outside-${fixtureId}`,
              isCorrect: false,
              createdAt: new Date('2026-03-02T17:00:00.000Z'),
            },
            {
              userId: user.id,
              bookWordId: `inside-${fixtureId}`,
              isCorrect: true,
              createdAt: new Date('2026-03-03T05:00:00.000Z'),
            },
          ],
        });

        vi.setSystemTime(new Date('2026-03-09T04:30:00.000Z'));
        const weekly = new WeeklyService(
          prisma as never,
          { get: () => 'America/New_York' } as never,
        );
        const prescription = await weekly.prescription(user.id);

        expect(prescription.evidenceStart).toBe('2026-03-03');
        expect(prescription.evidenceEnd).toBe('2026-03-09');
        expect(prescription.summary.attempts).toBe(1);
        expect(prescription.summary.accuracy).toBe(100);
      } finally {
        vi.useRealTimers();
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.$disconnect();
      }
    });
  },
);
