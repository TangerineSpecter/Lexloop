import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MICRO_STORIES } from '../src/modules/micro-stories/micro-stories.catalog';
import { MicroStoriesService } from '../src/modules/micro-stories/micro-stories.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'completed micro-story revisiting in an isolated database',
  () => {
    it('reveals only an owned completed story without changing learning records', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
        log: [{ emit: 'event', level: 'query' }],
      });
      const queries: string[] = [];
      prisma.$on('query', () => queries.push('query'));
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const service = new MicroStoriesService(
        prisma as never,
        { get: () => 'Asia/Shanghai' } as never,
      );

      try {
        const users = await Promise.all(
          ['owner', 'other'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `micro-revisit-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map(({ id }) => id));
        const completedKeys = MICRO_STORIES.filter((story) => story.key !== 'bus-02').map(
          (story) => story.key,
        );
        await prisma.microProgress.create({
          data: { userId: users[0].id, completedKeys },
        });

        const lookupStarted = performance.now();
        const preview = await service.completed(users[0].id);
        const lookupDurationMs = performance.now() - lookupStarted;
        expect(preview).toHaveLength(completedKeys.length);
        expect(preview[0]).toMatchObject({ key: 'bus-01', english: expect.any(String) });
        expect(preview[0]).not.toHaveProperty('reference');
        expect(preview[0]).not.toHaveProperty('explanation');
        const ownerCurrent = await service.current(users[0].id);
        const otherCurrent = await service.current(users[1].id);
        expect(ownerCurrent.lesson).not.toHaveProperty('focusPhrase');
        expect(otherCurrent.lesson).not.toHaveProperty('focusPhrase');
        console.log(
          `micro-story completed list: ${preview.length} stories in ${lookupDurationMs.toFixed(1)} ms`,
        );

        await service.interpret(users[0].id, 'bus-02', '汤姆说自己上班会迟到。');
        await new Promise<void>((resolve) => setImmediate(resolve));
        const queryStart = queries.length;
        const currentStarted = performance.now();
        const revealedCurrent = await service.current(users[0].id);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const currentDurationMs = performance.now() - currentStarted;
        const currentQueries = queries.length - queryStart;
        const currentResponseBytes = Buffer.byteLength(JSON.stringify(revealedCurrent));
        expect(currentQueries).toBe(2);
        expect(revealedCurrent.lesson).toMatchObject({
          key: 'bus-02',
          focusPhrase: 'be late for work',
        });
        console.log(
          `micro-story revealed current: ${currentQueries} database queries/${currentDurationMs.toFixed(1)} ms, ${currentResponseBytes} response bytes`,
        );

        const before = {
          progress: await prisma.microProgress.findUnique({ where: { userId: users[0].id } }),
          errors: await prisma.microError.count({ where: { userId: users[0].id } }),
          events: await prisma.learningEvent.count({ where: { userId: users[0].id } }),
        };
        const answer = await service.revisit(users[0].id, 'bus-01');
        expect(answer.reference).toBeTruthy();
        expect(answer.focusPhrase).toBe('miss the bus');
        await expect(service.revisit(users[0].id, 'bus-02')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(service.revisit(users[1].id, 'bus-01')).rejects.toBeInstanceOf(
          NotFoundException,
        );

        expect(await prisma.microProgress.findUnique({ where: { userId: users[0].id } })).toEqual(
          before.progress,
        );
        expect(await prisma.microError.count({ where: { userId: users[0].id } })).toBe(
          before.errors,
        );
        expect(await prisma.learningEvent.count({ where: { userId: users[0].id } })).toBe(
          before.events,
        );

        await prisma.microProgress.update({
          where: { userId: users[0].id },
          data: {
            completedKeys: MICRO_STORIES.filter(
              (story) => !story.key.startsWith('bike-repair-'),
            ).map((story) => story.key),
          },
        });
        const nextStory = await service.current(users[0].id);
        expect(nextStory).toMatchObject({
          completed: 18,
          total: 21,
          lesson: { key: 'bike-repair-01', series: '单车维修', part: 1, level: 'B1' },
        });
        expect(nextStory.lesson).not.toHaveProperty('reference');
        expect((await service.current(users[1].id)).lesson).toMatchObject({ key: 'bus-01' });
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    });
  },
);
