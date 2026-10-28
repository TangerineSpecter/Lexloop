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
    expect(before.lesson).not.toHaveProperty('focusPhrase');
    await expect(f.service.complete('owner', 'bus-01', true, '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const revealed = await f.service.interpret('owner', 'bus-01', '想念公交车');
    expect(revealed.reference).toContain('没赶上公交车');
    expect(revealed).toMatchObject({
      focusPhrase: 'miss the bus',
      focusMeaning: '没赶上公交车；不是“想念公交车”。',
    });
    expect((await f.service.current('owner')).lesson).toHaveProperty('reference');
    expect((await f.service.current('owner')).lesson).toHaveProperty('focusPhrase', 'miss the bus');
    expect(f.tx.learningEvent.create).not.toHaveBeenCalled();
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

  it('returns the due-cycle timestamp with the owner-scoped review card', async () => {
    const f = fixture();
    const dueAt = new Date(Date.now() - 1000);
    f.prisma.microError.findFirst.mockResolvedValue({
      id: 'card',
      userId: 'owner',
      lessonKey: 'bus-01',
      interpretation: '想念公交车',
      ownSentence: null,
      reviewCount: 2,
      dueAt,
    });

    const current = await f.service.current('owner');

    expect(current.review).toMatchObject({ id: 'card', reviewCount: 2, dueAt });
    expect(f.prisma.microError.findFirst).toHaveBeenCalledWith({
      where: { userId: 'owner', dueAt: { lte: expect.any(Date) } },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    });
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

  it('lists completed stories without answers and reveals one only to its learner', async () => {
    const f = fixture();
    f.progress.completedKeys = ['bus-02', 'bus-01'];

    const completed = await f.service.completed('owner');
    expect(completed.map(({ key }) => key)).toEqual(['bus-01', 'bus-02']);
    expect(completed[0]).toHaveProperty('english');
    expect(completed[0]).not.toHaveProperty('reference');
    expect(completed[0]).not.toHaveProperty('explanation');

    const answer = await f.service.revisit('owner', 'bus-01');
    expect(answer.reference).toContain('没赶上公交车');
    expect(answer).toHaveProperty('focusPhrase', 'miss the bus');
    await expect(f.service.revisit('owner', 'bus-03')).rejects.toBeInstanceOf(NotFoundException);
    f.progress.completedKeys = [];
    await expect(f.service.revisit('other', 'bus-01')).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.microProgress.upsert).not.toHaveBeenCalled();
    expect(f.tx.microProgress.update).not.toHaveBeenCalled();
    expect(f.tx.microError.upsert).not.toHaveBeenCalled();
    expect(f.tx.learningEvent.create).not.toHaveBeenCalled();
  });

  it('keeps published story keys unique so old cards retain their context', () => {
    expect(new Set(MICRO_STORIES.map((story) => story.key)).size).toBe(MICRO_STORIES.length);
    expect(
      MICRO_STORIES.every(
        (story) =>
          story.focusPhrase.trim().length > 0 &&
          story.focusPhrase.length <= 120 &&
          story.focusMeaning.trim().length > 0 &&
          story.focusMeaning.length <= 500,
      ),
    ).toBe(true);
    expect(
      MICRO_STORIES.every((story) =>
        [story.english, story.explanation, story.frame, story.example]
          .join(' ')
          .toLocaleLowerCase()
          .includes(story.focusPhrase.toLocaleLowerCase()),
      ),
    ).toBe(true);
  });

  it('reveals an accurate report explanation only after the learner writes an interpretation', async () => {
    const story = MICRO_STORIES.find(({ key }) => key === 'meeting-02');
    expect(story?.reference).toBe(
      '汤姆主动提出帮忙完成这份报告。米娅把笔记发给他，好让他核对数字。',
    );
    expect(story?.explanation).toContain('help with the report');
    expect(story?.explanation).toContain('不只指写作');

    const f = fixture();
    f.progress.completedKeys = MICRO_STORIES.slice(0, 7).map(({ key }) => key);
    const before = await f.service.current('owner');
    expect(before.lesson).toMatchObject({ key: 'meeting-02', english: story?.english });
    expect(before.lesson).not.toHaveProperty('reference');

    const revealed = await f.service.interpret('owner', 'meeting-02', '汤姆主动提出帮忙。');
    expect(revealed.reference).toBe(story?.reference);
    expect(revealed.explanation).toBe(story?.explanation);
    expect(f.tx.learningEvent.create).not.toHaveBeenCalled();

    f.prisma.microError.findMany.mockResolvedValue([
      {
        id: 'report-card',
        lessonKey: 'meeting-02',
        interpretation: '汤姆要帮忙写报告。',
        ownSentence: null,
        dueAt: new Date(),
      },
    ]);
    const existingCard = await f.service.errors('owner');
    expect(existingCard[0]).toMatchObject({
      reference: story?.reference,
      explanation: story?.explanation,
    });
    expect(f.tx.learningEvent.create).not.toHaveBeenCalled();
  });

  it('preserves the first nine story keys and continues learners onto new A2 scenes', async () => {
    const originalKeys = [
      'bus-01',
      'bus-02',
      'bus-03',
      'cafe-01',
      'cafe-02',
      'cafe-03',
      'meeting-01',
      'meeting-02',
      'meeting-03',
    ];
    expect(MICRO_STORIES.slice(0, originalKeys.length).map((story) => story.key)).toEqual(
      originalKeys,
    );
    expect(MICRO_STORIES).toHaveLength(15);
    expect(MICRO_STORIES.slice(originalKeys.length).map((story) => story.key)).toEqual([
      'weekend-01',
      'weekend-02',
      'weekend-03',
      'home-repair-01',
      'home-repair-02',
      'home-repair-03',
    ]);
    expect(
      MICRO_STORIES.slice(originalKeys.length).every(
        (story) => story.level === 'A2' && story.english && story.reference && story.example,
      ),
    ).toBe(true);

    const f = fixture();
    f.progress.completedKeys = originalKeys;
    const next = await f.service.current('owner');
    expect(next).toMatchObject({
      completed: 9,
      total: 15,
      lesson: { key: 'weekend-01', level: 'A2', interpretation: null },
    });
    expect(next.lesson).not.toHaveProperty('reference');
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
