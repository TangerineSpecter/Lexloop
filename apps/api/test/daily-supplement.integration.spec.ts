import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { DailySupplementController } from '../src/modules/vocabulary/daily-supplement.controller';
import { AdventureService } from '../src/modules/adventure/adventure.service';
import { OutputService } from '../src/modules/practice/output.service';
import { PracticeEvidenceService } from '../src/modules/practice/practice-evidence.service';
import {
  canonicalSupplementWord,
  lockSupplementAccount,
} from '../src/modules/vocabulary/supplement-eligibility';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';
import { DailySupplementService } from '../src/modules/vocabulary/daily-supplement.service';
import { DAILY_SUPPLEMENT_KEY } from '../src/modules/vocabulary/supplement-eligibility';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

async function fixture(
  run: (f: {
    db: PrismaClient;
    userId: string;
    otherId: string;
    bookId: string;
    originalIds: string[];
    wordIds: string[];
    supplement: DailySupplementService;
    study: StudyService;
    vocabulary: VocabularyService;
  }) => Promise<void>,
) {
  const db = new PrismaClient({ datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } } });
  const suffix = randomUUID();
  const users: string[] = [];
  const words: string[] = [];
  let bookId: string | undefined;
  const ai = {
    generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
      const groups = JSON.parse(prompt.match(/^输入分组：(.*)$/m)![1]);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                groups: groups.map(
                  (group: { index: number; words: Array<{ id: string; word: string }> }) => ({
                    index: group.index,
                    title: 'Synthetic example',
                    wordOccurrences: { [group.words[0].word]: 1 },
                    sentences: [
                      {
                        english: `The word ${group.words[0].word} appears in this example.`,
                        chinese: '这是一个测试句子。',
                        simplified: '这是测试句子。',
                        grammar: '测试简单句结构。',
                      },
                    ],
                    questions: [
                      {
                        bookWordId: group.words[0].id,
                        type: 'MEANING_RECOGNITION',
                        prompt: `What does ${group.words[0].word} mean here?`,
                        options: ['测试释义', '错误选项一', '错误选项二', '错误选项三'],
                        correctAnswers: ['测试释义'],
                        explanation: '合成回归材料，仅测试数据流。',
                      },
                    ],
                  }),
                ),
              }),
            },
          },
        ],
      };
    }),
  };
  try {
    for (const name of ['owner', 'other'])
      users.push(
        (
          await db.user.create({
            data: { email: `${suffix}-${name}@example.invalid`, passwordHash: 'fixture-only' },
          })
        ).id,
      );
    for (const text of ['surname', 'nickname', 'elbow'])
      words.push(
        (await db.vocabularyWord.create({ data: { normalized: text, text, meaning: '测试释义' } }))
          .id,
      );
    const book = await db.vocabularyBook.create({
      data: {
        sourceKey: `original-${suffix}`,
        sourcePath: 'fixture',
        title: 'Original book',
        category: 'GENERAL',
        bookWords: {
          create: words.map((wordId, position) => ({ wordId, position: position + 1 })),
        },
      },
      include: { bookWords: { orderBy: { position: 'asc' } } },
    });
    bookId = book.id;
    await db.userVocabularyBook.create({ data: { userId: users[0], bookId, isDefault: true } });
    const supplement = new DailySupplementService(db as never, { get: () => 'true' } as never);
    const study = new StudyService(
      db as never,
      ai as never,
      { selectedProvider: async () => ({ id: 'fixture' }) } as never,
      new MistakesService(db as never),
      undefined,
      { get: () => 'true' } as never,
    );
    await run({
      db,
      userId: users[0],
      otherId: users[1],
      bookId,
      originalIds: book.bookWords.map((item) => item.id),
      wordIds: words,
      supplement,
      study,
      vocabulary: new VocabularyService(db as never),
    });
  } finally {
    await db.studyPlan.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.vocabularyBook.deleteMany({
      where: { OR: [{ id: bookId ?? 'absent' }, { sourceKey: DAILY_SUPPLEMENT_KEY }] },
    });
    await db.vocabularyWord.deleteMany({ where: { id: { in: words } } });
    await db.$disconnect();
  }
}

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('opt-in daily supplement', () => {
  it('reuses global words, skips prior learning/mastery, pauses selection and preserves all history', async () => {
    await fixture(
      async ({
        db,
        userId,
        otherId,
        bookId,
        originalIds,
        wordIds,
        supplement,
        study,
        vocabulary,
      }) => {
        await db.userWordProgress.create({
          data: {
            userId,
            bookWordId: originalIds[0],
            state: 'REVIEWING',
            totalAttempts: 4,
            nextReviewAt: new Date(Date.now() + 86400_000),
          },
        });
        await db.userMasteredWord.create({ data: { userId, wordId: wordIds[2] } });
        const old = await db.userWordProgress.findUniqueOrThrow({
          where: { userId_bookWordId: { userId, bookWordId: originalIds[0] } },
        });
        const globals = await db.vocabularyWord.findMany({
          where: { id: { in: wordIds } },
          orderBy: { id: 'asc' },
        });
        await expect(
          study.createPlan(userId, 1, 'individual', undefined, 'supplement'),
        ).rejects.toThrow('请先启用');
        const preview = await supplement.preview(userId);
        expect(preview.rows.find((row) => row.word === 'surname')?.state).toBe('learned_elsewhere');
        expect(preview.rows.find((row) => row.word === 'elbow')?.state).toBe('mastered');
        expect(await db.vocabularyBook.count({ where: { sourceKey: DAILY_SUPPLEMENT_KEY } })).toBe(
          0,
        );
        await Promise.all([
          supplement.setEnabled(userId, true),
          supplement.setEnabled(userId, true),
        ]);
        const shared = await db.vocabularyBook.findUniqueOrThrow({
          where: { sourceKey: DAILY_SUPPLEMENT_KEY },
        });
        const associations = await db.vocabularyBookWord.findMany({
          where: { bookId: shared.id },
          orderBy: { position: 'asc' },
        });
        expect(associations.map((item) => item.wordId)).toEqual(wordIds);
        expect((await supplement.preview(otherId)).enabled).toBe(false);
        expect(
          (await supplement.preview(otherId)).rows.find((row) => row.word === 'surname')?.state,
        ).toBe('available');
        expect((await vocabulary.getDefaultBook(userId))?.id).toBe(bookId);
        await expect(vocabulary.activateBook(userId, shared.id)).rejects.toThrow('词表不存在');
        const plan = await study.createPlan(userId, 1, 'individual', undefined, 'supplement');
        expect(plan.supplementary).toBe(true);
        expect(plan.words.map((word) => word.word)).toEqual(['nickname']);
        await study.generatePlan(userId, plan.id);
        await study.completeGroup(userId, plan.id, 0, [
          { bookWordId: plan.words[0].id, selectedAnswer: ['测试释义'] },
        ]);
        await db.userWordProgress.update({
          where: { userId_bookWordId: { userId, bookWordId: plan.words[0].id } },
          data: { nextReviewAt: new Date(0) },
        });
        const history = async () => ({
          progress: await db.userWordProgress.findMany({
            where: { userId },
            orderBy: { id: 'asc' },
          }),
          attempts: await db.wordReviewAttempt.findMany({
            where: { userId },
            orderBy: { id: 'asc' },
          }),
          items: await db.studyPlanItem.findMany({
            where: { plan: { userId } },
            orderBy: { id: 'asc' },
          }),
        });
        const beforePause = await history();
        await supplement.setEnabled(userId, false);
        expect(await history()).toEqual(beforePause);
        await expect(
          study.createPlan(userId, 1, 'individual', undefined, 'supplement'),
        ).rejects.toThrow('请先启用');
        await expect(study.createPlan(userId, 0, 'group', 3)).rejects.toThrow('没有带可用释义');
        await expect(study.createPlan(userId, 1, 'individual', undefined, 'book')).rejects.toThrow(
          '没有带可用释义',
        );
        await expect(study.createPlan(userId, 1, 'individual', undefined, 'due')).rejects.toThrow(
          '没有带可用释义',
        );
        await expect(study.createProgressivePlan(userId)).rejects.toThrow('没有带可用释义');
        const dashboard = await vocabulary.getDashboardWords(userId);
        expect(dashboard.reviewWords).toHaveLength(0);
        expect(dashboard.newWords).toHaveLength(0);
        expect(await history()).toEqual(beforePause);
        await supplement.setEnabled(userId, true);
        const review = await study.createPlan(userId, 1, 'individual', undefined, 'supplement');
        expect(review.words.map((word) => word.id)).toEqual([plan.words[0].id]);
        expect(review.words[0].source).toBe('REVIEW');
        await supplement.setEnabled(userId, false);
        expect((await study.getPlan(userId, review.id)).id).toBe(review.id);
        expect(await db.userWordProgress.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
        expect(
          await db.vocabularyWord.findMany({
            where: { id: { in: wordIds } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(globals);
        expect(
          await db.vocabularyBookWord.findMany({
            where: { bookId: shared.id },
            orderBy: { position: 'asc' },
          }),
        ).toEqual(associations);
      },
    );
  }, 30000);

  it('serializes normal/supplement allocation and creates no plans after a completed pause', async () => {
    await fixture(async ({ db, userId, study, supplement }) => {
      await supplement.setEnabled(userId, true);
      const plans = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          study.createPlan(userId, 1, 'individual', undefined, index % 2 ? 'supplement' : 'book'),
        ),
      );
      expect(new Set(plans.map((plan) => plan.id)).size).toBe(1);
      expect(await db.studyPlan.count({ where: { userId } })).toBe(1);
      await supplement.setEnabled(userId, false);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          expect(
            study.createPlan(userId, 1, 'individual', undefined, 'supplement'),
          ).rejects.toThrow('请先启用'),
        ),
      );
      expect(await db.studyPlan.count({ where: { userId } })).toBe(1);
      expect(await db.wordReviewAttempt.count({ where: { userId } })).toBe(0);
    });
  }, 30000);
  it('defaults closed, preserves pause/history and synchronizes only newly available associations', async () => {
    await fixture(async ({ db, userId, wordIds, supplement }) => {
      const closed = new DailySupplementService(db as never);
      expect((await closed.preview(userId)).deploymentReady).toBe(false);
      await expect(closed.setEnabled(userId, true)).rejects.toThrow('尚未开放');
      expect(await db.vocabularyBook.count({ where: { sourceKey: DAILY_SUPPLEMENT_KEY } })).toBe(0);
      await db.vocabularyWord.update({ where: { id: wordIds[2] }, data: { meaning: null } });
      await supplement.setEnabled(userId, true);
      const before = await db.vocabularyBookWord.findMany({
        where: { book: { isSupplement: true } },
        orderBy: { position: 'asc' },
      });
      await db.vocabularyWord.update({
        where: { id: wordIds[2] },
        data: { meaning: '测试新释义' },
      });
      expect(
        (await supplement.preview(userId)).rows.find((row) => row.word === 'elbow')?.state,
      ).toBe('needs_sync');
      await supplement.setEnabled(userId, true);
      await supplement.setEnabled(userId, true);
      const after = await db.vocabularyBookWord.findMany({
        where: { book: { isSupplement: true } },
        orderBy: { position: 'asc' },
      });
      expect(after.slice(0, 2)).toEqual(before);
      expect(after).toHaveLength(3);
      expect(
        (await supplement.preview(userId)).rows.find((row) => row.word === 'elbow')?.state,
      ).toBe('available');
      await closed.setEnabled(userId, false);
      expect((await closed.preview(userId)).enabled).toBe(false);
      expect(await db.vocabularyBookWord.count({ where: { book: { isSupplement: true } } })).toBe(
        3,
      );
    });
  });

  it('reserves existing output targets and excludes supplement claims from new output challenges', async () => {
    await fixture(async ({ db, userId, supplement, study }) => {
      const output = new OutputService(
        db as never,
        { get: () => 'Asia/Shanghai' } as never,
        {} as never,
        new PracticeEvidenceService(new MistakesService(db as never)),
        {} as never,
      );
      const challenge = await output.daily(userId);
      expect(challenge?.targets).toHaveLength(3);
      await supplement.setEnabled(userId, true);
      expect(
        (await supplement.preview(userId)).rows.filter((row) => row.state === 'learned_elsewhere'),
      ).toHaveLength(3);
      await expect(
        study.createPlan(userId, 1, 'individual', undefined, 'supplement'),
      ).rejects.toThrow('没有未学或到期词');
    });
    await fixture(async ({ db, userId, supplement, study }) => {
      await supplement.setEnabled(userId, true);
      const plan = await study.createPlan(userId, 3, 'individual', undefined, 'supplement');
      expect(plan.words).toHaveLength(3);
      const output = new OutputService(
        db as never,
        { get: () => 'Asia/Shanghai' } as never,
        {} as never,
        new PracticeEvidenceService(new MistakesService(db as never)),
        {} as never,
      );
      expect(await output.daily(userId)).toBeNull();
    });
  });

  it('manual actions and fixed-curriculum evidence reuse the canonical supplemental progress even while paused', async () => {
    await fixture(async ({ db, userId, originalIds, supplement, study, vocabulary }) => {
      await supplement.setEnabled(userId, true);
      const plan = await study.createPlan(userId, 1, 'individual', undefined, 'supplement');
      const canonicalId = plan.words[0].id;
      await supplement.setEnabled(userId, false);
      await vocabulary.addToReview(userId, originalIds[0]);
      const first = await db.userWordProgress.findMany({ where: { userId } });
      expect(first.map((row) => row.bookWordId)).toEqual([canonicalId]);
      const evidence = new PracticeEvidenceService(new MistakesService(db as never));
      await db.$transaction(async (tx) => {
        await lockSupplementAccount(tx, userId);
        expect(await canonicalSupplementWord(tx, userId, originalIds[0])).toBe(canonicalId);
        await evidence.record(tx, userId, [
          {
            bookWordId: originalIds[0],
            correct: true,
            questionType: 'OUTPUT',
            answer: 'example',
            prompt: 'example',
            explanation: 'example',
            expected: 'example',
            responseTimeMs: 1000,
          },
        ]);
      });
      await vocabulary.markMastered(userId, originalIds[0]);
      const progress = await db.userWordProgress.findMany({ where: { userId } });
      expect(progress).toHaveLength(1);
      expect(progress[0]).toMatchObject({
        id: first[0].id,
        bookWordId: canonicalId,
        state: 'MASTERED',
        totalAttempts: 1,
      });
      expect(
        (await db.wordReviewAttempt.findMany({ where: { userId } })).map((row) => row.bookWordId),
      ).toEqual([canonicalId]);
    });
  });

  it('holds output allocation behind a supplemental account claim and pause behind plan creation', async () => {
    await fixture(async ({ db, userId, supplement, study }) => {
      await supplement.setEnabled(userId, true);
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = db.$transaction.bind(db);
      const gated = new Proxy(db, {
        get(target, property) {
          if (property === '$transaction')
            return (callback: (tx: never) => Promise<unknown>) =>
              original(async (tx) => {
                await lockSupplementAccount(tx, userId);
                entered();
                await gate;
                return callback(tx as never);
              });
          return Reflect.get(target, property);
        },
      });
      const gatedStudy = new StudyService(
        gated as never,
        {} as never,
        {} as never,
        new MistakesService(db as never),
        undefined,
        { get: () => 'true' } as never,
      );
      const allocation = gatedStudy.createPlan(userId, 3, 'individual', undefined, 'supplement');
      await ready;
      const output = new OutputService(
        db as never,
        { get: () => 'Asia/Shanghai' } as never,
        {} as never,
        new PracticeEvidenceService(new MistakesService(db as never)),
        {} as never,
      );
      let paused = false;
      const pause = supplement.setEnabled(userId, false).then(() => {
        paused = true;
      });
      const daily = output.daily(userId);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(paused).toBe(false);
      release();
      const plan = await allocation;
      await pause;
      expect(await daily).toBeNull();
      expect(plan.words).toHaveLength(3);
      await expect(
        study.createPlan(userId, 1, 'individual', undefined, 'supplement'),
      ).rejects.toThrow('请先启用');
      expect(await db.studyPlan.count({ where: { userId } })).toBe(1);
    });
  }, 30000);

  it('keeps original adventure floors but writes one shared progress record', async () => {
    await fixture(async ({ db, userId, bookId, originalIds, supplement, study }) => {
      await supplement.setEnabled(userId, true);
      const plan = await study.createPlan(userId, 3, 'individual', undefined, 'supplement');
      await supplement.setEnabled(userId, false);
      const adventure = new AdventureService(db as never, new MistakesService(db as never), {
        generateForUser: vi.fn(),
      } as never);
      await adventure.chooseClass(userId, 'warrior');
      const floor = (await adventure.dungeons(userId)).floors[0];
      const targetsBefore = await db.floorLearningTarget.findMany({
        where: { floorId: floor.id },
        orderBy: { position: 'asc' },
      });
      expect(targetsBefore.map((row) => row.bookWordId)).toEqual(originalIds);
      const run = await adventure.startRun(userId, floor.id, 5, 'RECALL');
      const room = await db.dungeonRoom.findUniqueOrThrow({
        where: { runId_position: { runId: run.id, position: run.currentRoom } },
      });
      const challenge = room.challenge as unknown as { expected: string[] };
      await adventure.act(userId, run.id, {
        clientActionId: randomUUID(),
        answer: [challenge.expected[0]],
        responseTimeMs: 900,
      });
      const progress = await db.userWordProgress.findMany({ where: { userId } });
      expect(progress).toHaveLength(1);
      expect(plan.words.map((word) => word.id)).toContain(progress[0].bookWordId);
      expect(await db.userWordProgress.count({ where: { userId, bookWord: { bookId } } })).toBe(0);
      expect(
        await db.floorLearningTarget.findMany({
          where: { floorId: floor.id },
          orderBy: { position: 'asc' },
        }),
      ).toEqual(targetsBefore);
    });
  });

  it('can relearn after undoing mastery or postponing a supplemental new word', async () => {
    await fixture(async ({ db, userId, originalIds, wordIds, supplement, study, vocabulary }) => {
      await supplement.setEnabled(userId, true);
      const first = await study.createPlan(userId, 1, 'individual', undefined, 'supplement');
      await study.generatePlan(userId, first.id);
      await study.completeGroup(userId, first.id, 0, [
        { bookWordId: first.words[0].id, selectedAnswer: ['测试释义'] },
      ]);
      await vocabulary.markMastered(userId, originalIds[0]);
      await vocabulary.removeMasteredWord(userId, wordIds[0]);
      const resumed = await study.createPlan(userId, 1, 'individual', undefined, 'supplement');
      expect(resumed.words.map((word) => word.id)).toEqual([first.words[0].id]);
      await study.generatePlan(userId, resumed.id);
      await study.completeGroup(userId, resumed.id, 0, [
        { bookWordId: resumed.words[0].id, selectedAnswer: ['测试释义'] },
      ]);
      await vocabulary.deferNewWord(userId, originalIds[0]);
      const deferred = await study.createPlan(userId, 1, 'individual', undefined, 'supplement');
      expect(deferred.words.map((word) => word.id)).toEqual([first.words[0].id]);
      expect(
        await db.userWordProgress.count({ where: { userId, bookWordId: originalIds[0] } }),
      ).toBe(0);
    });
  });

  it('authenticates preview/toggle, validates booleans and keeps account enrollment separate', async () => {
    await fixture(async ({ userId, otherId, supplement }) => {
      const secret = randomUUID();
      const moduleRef = await Test.createTestingModule({
        imports: [JwtModule.register({})],
        controllers: [DailySupplementController],
        providers: [
          JwtAuthGuard,
          { provide: ConfigService, useValue: { getOrThrow: () => secret } },
          { provide: DailySupplementService, useValue: supplement },
        ],
      }).compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      try {
        await app.init();
        const http = app.getHttpAdapter().getInstance();
        await http.ready();
        const jwt = new JwtService({ secret });
        const owner = { authorization: `Bearer ${await jwt.signAsync({ sub: userId })}` };
        const other = { authorization: `Bearer ${await jwt.signAsync({ sub: otherId })}` };
        const url = '/vocabulary/daily-supplement';
        expect((await http.inject({ method: 'GET', url })).statusCode).toBe(401);
        expect(
          (await http.inject({ method: 'PATCH', url, payload: { enabled: true } })).statusCode,
        ).toBe(401);
        for (const enabled of ['true', 1, null])
          expect(
            (await http.inject({ method: 'PATCH', url, headers: owner, payload: { enabled } }))
              .statusCode,
          ).toBe(400);
        expect(
          (
            await http.inject({
              method: 'PATCH',
              url,
              headers: owner,
              payload: { enabled: true, userId: otherId },
            })
          ).json().enabled,
        ).toBe(true);
        expect((await http.inject({ method: 'GET', url, headers: other })).json().enabled).toBe(
          false,
        );
        expect(
          (await http.inject({ method: 'PATCH', url, headers: other, payload: { enabled: false } }))
            .statusCode,
        ).toBe(200);
        expect((await http.inject({ method: 'GET', url, headers: owner })).json().enabled).toBe(
          true,
        );
      } finally {
        await app.close();
      }
    });
  });
  it('serializes manual mastery before a competing supplemental allocation', async () => {
    await fixture(async ({ db, userId, originalIds, supplement, study }) => {
      await supplement.setEnabled(userId, true);
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = db.$transaction.bind(db);
      const gated = new Proxy(db, {
        get(target, property) {
          if (property === '$transaction')
            return (callback: (tx: never) => Promise<unknown>) =>
              original(async (tx) => {
                await lockSupplementAccount(tx, userId);
                entered();
                await gate;
                return callback(tx as never);
              });
          return Reflect.get(target, property);
        },
      });
      const manual = new VocabularyService(gated as never).markMastered(userId, originalIds[0]);
      await ready;
      let allocated = false;
      const pending = study
        .createPlan(userId, 3, 'individual', undefined, 'supplement')
        .then((plan) => {
          allocated = true;
          return plan;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(allocated).toBe(false);
      release();
      await manual;
      const plan = await pending;
      expect(plan.words.map((word) => word.word)).toEqual(['nickname', 'elbow']);
      expect(await db.userWordProgress.count({ where: { userId } })).toBe(1);
    });
  }, 30000);
});
