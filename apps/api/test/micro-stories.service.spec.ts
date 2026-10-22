import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MICRO_STORIES, nextStory } from '../src/modules/micro-stories/micro-stories.catalog';
import { nextReviewAt } from '../src/modules/micro-stories/micro-stories.rules';
import { MicroStoriesService } from '../src/modules/micro-stories/micro-stories.service';

function fixture() {
  const progress = {
    userId: 'owner',
    completedKeys: [] as string[],
    interpretationKey: null as string | null,
    interpretation: null as string | null,
  };
  const tx = {
    $queryRaw: vi.fn(),
    user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'owner' }) },
    microProgress: {
      findUnique: vi.fn().mockImplementation(async () => progress),
      upsert: vi
        .fn()
        .mockImplementation(
          async ({
            create,
            update,
          }: {
            create: { interpretation: string; interpretationKey: string };
            update: { interpretation: string; interpretationKey: string };
          }) => {
            progress.interpretation = (progress.interpretation ? update : create).interpretation;
            progress.interpretationKey = (
              progress.interpretationKey ? update : create
            ).interpretationKey;
          },
        ),
      update: vi
        .fn()
        .mockImplementation(async ({ data }: { data: { completedKeys: string[] } }) => {
          progress.completedKeys = data.completedKeys;
          progress.interpretationKey = null;
          progress.interpretation = null;
        }),
    },
    microError: { upsert: vi.fn() },
    learningEvent: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((action: (client: typeof tx) => Promise<unknown>) => action(tx)),
    microProgress: { findUnique: vi.fn().mockImplementation(async () => progress) },
    microError: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
  };
  return {
    progress,
    tx,
    prisma,
    service: new MicroStoriesService(prisma as never, { get: () => 'Asia/Shanghai' } as never),
  };
}

describe('one-minute stories', () => {
  it('hides reference meaning until an interpretation is saved and advances only once', async () => {
    const f = fixture();
    const before = await f.service.current('owner');
    expect(before.lesson).not.toHaveProperty('reference');
    await expect(f.service.complete('owner', 'bus-01', true, '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const revealed = await f.service.interpret('owner', 'bus-01', '想念公交车');
    expect(revealed.reference).toContain('没赶上公交车');
    expect((await f.service.current('owner')).lesson).toHaveProperty('reference');
    await f.service.complete('owner', 'bus-01', true, 'I missed the train.');
    expect(f.tx.microError.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'owner',
          lessonKey: 'bus-01',
          interpretation: '想念公交车',
        }),
      }),
    );
    expect(f.tx.learningEvent.create).toHaveBeenCalledTimes(1);
    await expect(f.service.complete('owner', 'bus-01', true, '')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await f.service.current('owner')).lesson?.key).toBe('bus-02');
  });

  it('does not create a misunderstanding card when the learner understood the text', async () => {
    const f = fixture();
    await f.service.interpret('owner', 'bus-01', '没赶上公交车');
    await f.service.complete('owner', 'bus-01', false, '');
    expect(f.tx.microError.upsert).not.toHaveBeenCalled();
  });

  it('reviews only the owner’s due card and moves it away from the due queue', async () => {
    const f = fixture();
    const row = { id: 'card', userId: 'owner', reviewCount: 0, dueAt: new Date(Date.now() - 1000) };
    f.prisma.microError.findFirst.mockResolvedValue(row);
    f.prisma.microError.updateMany.mockResolvedValue({ count: 1 });
    const result = await f.service.review('owner', 'card', true);
    expect(result.reviewCount).toBe(1);
    expect(result.dueAt.getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    expect(f.prisma.microError.findFirst).toHaveBeenCalledWith({
      where: { id: 'card', userId: 'owner' },
    });
    f.prisma.microError.findFirst.mockResolvedValue(null);
    await expect(f.service.review('other', 'card', true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('loads a bounded, owner-scoped misunderstanding notebook', async () => {
    const f = fixture();
    f.prisma.microError.findMany.mockResolvedValue([
      {
        id: 'card',
        lessonKey: 'bus-01',
        interpretation: '想念公交车',
        ownSentence: null,
        dueAt: new Date(),
      },
    ]);
    const cards = await f.service.errors('owner');
    expect(f.prisma.microError.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'owner' },
        take: 20,
      }),
    );
    expect(cards[0].reference).toContain('没赶上公交车');
  });

  it('keeps published story keys unique so old cards retain their context', () => {
    expect(new Set(MICRO_STORIES.map((story) => story.key)).size).toBe(MICRO_STORIES.length);
  });

  it('keeps the next unread story stable when content is reordered or inserted', () => {
    const reordered = [MICRO_STORIES[2], MICRO_STORIES[0], MICRO_STORIES[1]];
    expect(nextStory(reordered, ['bus-01'], 'bus-02')?.key).toBe('bus-02');
    expect(nextStory(reordered, ['bus-01', 'bus-02'])?.key).toBe('bus-03');
    const extended = [MICRO_STORIES[1], MICRO_STORIES[0]];
    expect(nextStory(extended, ['bus-01'])?.key).toBe('bus-02');
  });

  it('schedules tomorrow morning in the learner timezone rather than after 24 hours', () => {
    const late = new Date('2026-10-22T15:30:00.000Z'); // 23:30 in Shanghai
    expect(nextReviewAt(late, 1, 'Asia/Shanghai').toISOString()).toBe('2026-10-22T22:00:00.000Z');
    const beforeDst = new Date('2026-10-31T15:30:00.000Z');
    expect(nextReviewAt(beforeDst, 1, 'America/New_York').toISOString()).toBe(
      '2026-11-01T11:00:00.000Z',
    );
  });
});
