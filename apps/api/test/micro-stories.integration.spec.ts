import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
              (story) =>
                !story.key.startsWith('bike-repair-') &&
                !story.key.startsWith('grocery-') &&
                !story.key.startsWith('library-return-') &&
                !story.key.startsWith('neighbor-greeting-') &&
                !story.key.startsWith('calendar-date-') &&
                !story.key.startsWith('post-office-directions-'),
            ).map((story) => story.key),
          },
        });
        const nextStory = await service.current(users[0].id);
        expect(nextStory).toMatchObject({
          completed: 18,
          total: 33,
          lesson: { key: 'bike-repair-01', series: '单车维修', part: 1, level: 'B1' },
        });
        expect(nextStory.lesson).not.toHaveProperty('reference');
        expect((await service.current(users[1].id)).lesson).toMatchObject({ key: 'bus-01' });

        const beforeSelectionEvents = await prisma.learningEvent.count({
          where: { userId: users[0].id },
        });
        const defaultKey = nextStoryKey(nextStory);
        const [firstSelection, staleSelection] = await Promise.allSettled([
          service.select(users[0].id, 'grocery-02', defaultKey),
          service.select(users[0].id, 'library-return-02', defaultKey),
        ]);
        const successful = [firstSelection, staleSelection].find(
          (result) => result.status === 'fulfilled',
        );
        const rejected = [firstSelection, staleSelection].find(
          (result) => result.status === 'rejected',
        );
        expect(successful?.status).toBe('fulfilled');
        expect(rejected?.status).toBe('rejected');
        if (rejected?.status === 'rejected') {
          expect(rejected.reason).toBeInstanceOf(ConflictException);
        }
        const selectedKey = (
          successful as PromiseFulfilledResult<Awaited<ReturnType<typeof service.select>>>
        ).value.lesson?.key;
        expect(['grocery-02', 'library-return-02']).toContain(selectedKey);
        expect((await service.current(users[0].id)).lesson?.key).toBe(selectedKey);
        expect((await service.current(users[1].id)).lesson?.key).toBe('bus-01');
        expect(await prisma.learningEvent.count({ where: { userId: users[0].id } })).toBe(
          beforeSelectionEvents,
        );
        expect((await service.select(users[0].id, selectedKey!, selectedKey!)).lesson?.key).toBe(
          selectedKey,
        );

        await service.interpret(users[0].id, selectedKey!, '这是本段的本机理解。');
        const savedProgress = await prisma.microProgress.findUnique({
          where: { userId: users[0].id },
        });
        const otherTarget = selectedKey === 'grocery-02' ? 'library-return-02' : 'grocery-02';
        await expect(service.select(users[0].id, otherTarget, selectedKey!)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(await prisma.microProgress.findUnique({ where: { userId: users[0].id } })).toEqual(
          savedProgress,
        );
        expect((await service.current(users[0].id)).lesson?.interpretation).toBe(
          '这是本段的本机理解。',
        );

        await prisma.microProgress.upsert({
          where: { userId: users[1].id },
          create: {
            userId: users[1].id,
            completedKeys: MICRO_STORIES.slice(0, 27).map(({ key }) => key),
          },
          update: { completedKeys: MICRO_STORIES.slice(0, 27).map(({ key }) => key) },
        });
        expect(await service.current(users[1].id)).toMatchObject({
          completed: 27,
          total: 33,
          lesson: {
            key: 'neighbor-greeting-01',
            series: '新邻居打招呼',
            part: 1,
            level: 'A1',
          },
        });
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    });
  },
);

function nextStoryKey(current: Awaited<ReturnType<MicroStoriesService['current']>>) {
  if (!current.lesson) throw new Error('Expected the fixture to have an unfinished story');
  return current.lesson.key;
}
