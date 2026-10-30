import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AdventureService } from '../src/modules/adventure/adventure.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'adventure feedback recovery in an isolated database',
  () => {
    it('persists the selected practice focus and treats legacy runs as balanced', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `adventure-focus-${fixtureId}`;
      const normalized = Array.from({ length: 12 }, (_, index) => `${sourceKey}-${index}`);
      let userId: string | undefined;
      const service = new AdventureService(prisma as never, new MistakesService(prisma as never), {
        generateForUser: vi.fn(),
      } as never);

      try {
        const user = await prisma.user.create({
          data: {
            email: `${sourceKey}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Adventure practice focus fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: normalized.map((value, position) => ({
                position,
                word: {
                  create: { normalized: value, text: `focus${position}`, meaning: '练习词' },
                },
              })),
            },
          },
          select: { id: true },
        });
        await prisma.userVocabularyBook.create({
          data: { userId: user.id, bookId: book.id, isDefault: true },
        });
        await service.chooseClass(user.id, 'warrior');
        const floor = (await service.dungeons(user.id)).floors[0];

        const focused = await service.startRun(user.id, floor.id, 5, 'RECALL');
        expect(focused).toMatchObject({ practiceFocus: 'RECALL', challenge: { type: 'SPELLING' } });
        expect(await service.recoverRun(user.id, focused.id)).toMatchObject({
          practiceFocus: 'RECALL',
          challenge: { type: 'SPELLING' },
        });
        expect(
          await prisma.dungeonRun.findUniqueOrThrow({
            where: { id: focused.id },
            select: { snapshot: true },
          }),
        ).toMatchObject({ snapshot: { practiceFocus: 'RECALL' } });
        expect(await prisma.battleAction.count({ where: { runId: focused.id } })).toBe(0);
        expect(await prisma.adventureLearningEvidence.count({ where: { runId: focused.id } })).toBe(
          0,
        );
        expect(await prisma.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(0);

        await prisma.dungeonRun.update({
          where: { id: focused.id },
          data: { status: 'RETREATED', completedAt: new Date() },
        });
        const legacy = await service.startRun(user.id, floor.id, 5);
        expect(legacy).toMatchObject({ practiceFocus: 'BALANCED', challenge: { type: 'CHOICE' } });
        await prisma.dungeonRun.update({
          where: { id: legacy.id },
          data: { snapshot: { version: 1, classId: 'class-warrior', stats: {} } },
        });
        expect(await service.recoverRun(user.id, legacy.id)).toMatchObject({
          practiceFocus: 'BALANCED',
        });
      } finally {
        if (userId) await prisma.user.delete({ where: { id: userId } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('hides previously cached mastery when its only evidence was provisional', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `adventure-legacy-provisional-${fixtureId}`;
      const normalized = Array.from(
        { length: 24 },
        (_, index) => `adventure-legacy-provisional-${fixtureId}-${index}`,
      );
      let userId: string | undefined;
      const service = new AdventureService(prisma as never, new MistakesService(prisma as never), {
        generateForUser: vi.fn(),
      } as never);

      try {
        const user = await prisma.user.create({
          data: {
            email: `adventure-legacy-provisional-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Adventure legacy evidence fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: normalized.map((value, position) => ({
                position,
                word: {
                  create: {
                    normalized: value,
                    text: position === 0 ? 'patient' : `patient${position}`,
                    meaning: '有耐心的',
                  },
                },
              })),
            },
          },
          select: { id: true },
        });
        await prisma.userVocabularyBook.create({
          data: { userId: user.id, bookId: book.id, isDefault: true },
        });
        await service.chooseClass(user.id, 'warrior');
        const map = await service.dungeons(user.id);
        const floor = map.floors[0];
        const target = await prisma.floorLearningTarget.findFirstOrThrow({
          where: { floorId: floor.id },
          select: { id: true },
        });
        const firstRun = await service.startRun(user.id, floor.id, 5);
        await prisma.dungeonRun.update({
          where: { id: firstRun.id },
          data: { status: 'RETREATED', completedAt: new Date() },
        });
        const secondRun = await service.startRun(user.id, floor.id, 5);
        const runs = [firstRun, secondRun];
        const evidenceRows = [];
        for (const [index, run] of runs.entries()) {
          const room = await prisma.dungeonRoom.findFirstOrThrow({
            where: { runId: run.id, position: 0 },
            select: { id: true },
          });
          const action = await prisma.battleAction.create({
            data: {
              runId: run.id,
              roomId: room.id,
              clientActionId: `legacy-provisional-${fixtureId}-${index}`,
              phase: 'ATTACK',
              challengeType: 'FREE_RESPONSE',
              answer: ['We can use patient words in context.'],
              score: 70,
              grade: 'HIT',
              feedback: {
                correct: true,
                provisional: true,
                message: '旧版临时评分',
              },
            },
            select: { id: true },
          });
          evidenceRows.push({
            userId: user.id,
            targetId: target.id,
            runId: run.id,
            actionId: action.id,
            kind: 'PRODUCTION' as const,
            score: 70,
            validRecall: true,
          });
        }
        await prisma.adventureLearningEvidence.createMany({ data: evidenceRows });
        await prisma.userFloorProgress.upsert({
          where: { userId_floorId: { userId: user.id, floorId: floor.id } },
          create: {
            userId: user.id,
            floorId: floor.id,
            exploration: 100,
            mastery: 100,
            bossUnlocked: true,
          },
          update: { exploration: 100, mastery: 100, bossUnlocked: true },
        });

        const startedAt = performance.now();
        const refreshed = await service.dungeons(user.id);
        const elapsedMs = performance.now() - startedAt;
        expect(refreshed.floors[0]).toMatchObject({
          exploration: 8,
          mastery: 0,
          bossUnlocked: false,
        });
        expect(
          await prisma.userFloorProgress.findUniqueOrThrow({
            where: { userId_floorId: { userId: user.id, floorId: floor.id } },
            select: { exploration: true, mastery: true, bossUnlocked: true },
          }),
        ).toEqual({ exploration: 100, mastery: 100, bossUnlocked: true });
        console.info(
          `adventure map evidence aggregation: 2 floors/24 targets, ${elapsedMs.toFixed(1)} ms`,
        );
      } finally {
        if (userId) await prisma.user.delete({ where: { id: userId } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('does not save an AI-unavailable sentence heuristic as correct or mastery evidence', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `adventure-provisional-${fixtureId}`;
      const normalized = [
        `adventure-provisional-${fixtureId}-patient`,
        `adventure-provisional-${fixtureId}-calm`,
      ];
      let userId: string | undefined;
      const ai = {
        generateForUser: vi.fn().mockRejectedValue(new Error('mock provider unavailable')),
      };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );

      try {
        const user = await prisma.user.create({
          data: {
            email: `adventure-provisional-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Adventure provisional grading fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: normalized.map((word, position) => ({
                position,
                word: {
                  create: {
                    normalized: word,
                    text: position === 0 ? 'patient' : 'calm',
                    meaning: position === 0 ? '有耐心的' : '平静的',
                  },
                },
              })),
            },
          },
          select: { id: true },
        });
        await prisma.userVocabularyBook.create({
          data: { userId: user.id, bookId: book.id, isDefault: true },
        });
        await service.chooseClass(user.id, 'warrior');
        const map = await service.dungeons(user.id);
        const floor = map.floors[0];
        const run = await service.startRun(user.id, floor.id, 5);
        const target = await prisma.floorLearningTarget.findFirstOrThrow({
          where: { floorId: floor.id },
          include: { bookWord: { include: { word: true } } },
          orderBy: { position: 'asc' },
        });
        const room = await prisma.dungeonRoom.findFirstOrThrow({
          where: { runId: run.id, position: 0 },
          select: { id: true },
        });
        await prisma.dungeonRoom.update({
          where: { id: room.id },
          data: {
            challenge: {
              id: `provisional-${fixtureId}`,
              type: 'FREE_RESPONSE',
              phase: 'ATTACK',
              prompt: '用 patient 写一个完整句子',
              expected: ['I can be patient.'],
              targetId: target.id,
              word: 'patient',
              meaning: '有耐心的',
            },
          },
        });

        await service.act(user.id, run.id, {
          clientActionId: `provisional-action-${fixtureId}`,
          answer: ['We can use patient words in context.'],
        });

        const action = await prisma.battleAction.findUniqueOrThrow({
          where: {
            runId_clientActionId: {
              runId: run.id,
              clientActionId: `provisional-action-${fixtureId}`,
            },
          },
        });
        expect(action.score).toBe(60);
        expect(action.feedback).toMatchObject({ correct: false, provisional: true });
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        expect(
          await prisma.adventureLearningEvidence.count({ where: { actionId: action.id } }),
        ).toBe(0);
        expect(
          await prisma.wordReviewAttempt.count({ where: { adventureActionId: action.id } }),
        ).toBe(0);
        expect(
          await prisma.userWordProgress.findUnique({
            where: {
              userId_bookWordId: { userId: user.id, bookWordId: target.bookWordId },
            },
          }),
        ).toBeNull();
        expect(
          await prisma.weaknessSignal.count({
            where: { userId: user.id, bookWordId: target.bookWordId },
          }),
        ).toBe(0);
        expect(
          await prisma.learningEvent.count({
            where: { userId: user.id, type: 'ADVENTURE_BATTLE_ACTION' },
          }),
        ).toBe(0);
        expect(
          await prisma.userFloorProgress.findUniqueOrThrow({
            where: { userId_floorId: { userId: user.id, floorId: floor.id } },
            select: { mastery: true, bossUnlocked: true },
          }),
        ).toEqual({ mastery: 0, bossUnlocked: false });

        ai.generateForUser.mockResolvedValueOnce(
          JSON.stringify({ score: 90, message: '目标词在句中使用正确。' }),
        );
        await prisma.dungeonRoom.update({
          where: { id: room.id },
          data: {
            challenge: {
              id: `verified-${fixtureId}`,
              type: 'FREE_RESPONSE',
              phase: 'BLOCK',
              prompt: '用 patient 写一个完整句子',
              expected: ['I can be patient.'],
              targetId: target.id,
              word: 'patient',
              meaning: '有耐心的',
            },
          },
        });
        await service.act(user.id, run.id, {
          clientActionId: `verified-action-${fixtureId}`,
          answer: ['I can be patient with new learners.'],
        });
        const verifiedAction = await prisma.battleAction.findUniqueOrThrow({
          where: {
            runId_clientActionId: {
              runId: run.id,
              clientActionId: `verified-action-${fixtureId}`,
            },
          },
        });
        expect(verifiedAction.feedback).toMatchObject({ correct: true, provisional: false });
        expect(
          await prisma.adventureLearningEvidence.findUniqueOrThrow({
            where: { actionId_targetId: { actionId: verifiedAction.id, targetId: target.id } },
            select: { score: true, kind: true, validRecall: true },
          }),
        ).toMatchObject({ score: 90, kind: 'PRODUCTION', validRecall: true });
        expect(
          await prisma.wordReviewAttempt.findUniqueOrThrow({
            where: { adventureActionId: verifiedAction.id },
            select: { isCorrect: true },
          }),
        ).toEqual({ isCorrect: true });
        expect(ai.generateForUser).toHaveBeenCalledTimes(2);
      } finally {
        if (userId) await prisma.user.delete({ where: { id: userId } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('returns each learner’s latest saved answer without creating new learning evidence', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const sourceKey = `adventure-feedback-${fixtureId}`;
      const normalized = [
        `adventure-feedback-${fixtureId}`,
        `adventure-feedback-distractor-${fixtureId}`,
      ];
      const ai = { generateForUser: vi.fn() };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );

      try {
        const users = await Promise.all(
          ['one', 'two'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `adventure-feedback-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));

        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Adventure feedback recovery fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: [
                {
                  position: 0,
                  word: {
                    create: {
                      normalized: normalized[0],
                      text: 'steady',
                      meaning: '稳定的',
                    },
                  },
                },
                {
                  position: 1,
                  word: {
                    create: {
                      normalized: normalized[1],
                      text: 'calm',
                      meaning: '平静的',
                    },
                  },
                },
              ],
            },
          },
          select: { id: true },
        });
        await prisma.userVocabularyBook.createMany({
          data: users.map((user) => ({ userId: user.id, bookId: book.id, isDefault: true })),
        });

        const runs = [];
        for (const user of users) {
          await service.chooseClass(user.id, 'warrior');
          const map = await service.dungeons(user.id);
          const floor = map.floors[0];
          expect(floor).toBeDefined();
          const run = await service.startRun(user.id, floor.id, 5);
          expect(run.challenge?.type).toBe('CHOICE');
          runs.push({ user, run });
        }

        const [first, second] = runs;
        expect(
          await prisma.userWordProgress.findMany({ where: { userId: first.user.id } }),
        ).toHaveLength(0);
        const firstPrompt = first.run.challenge!.prompt;
        const firstAnswer = first.run.challenge!.options!.find((option) => option === 'steady')!;
        const firstActionId = `action-${fixtureId}-one`;
        const firstResult = await service.act(first.user.id, first.run.id, {
          clientActionId: firstActionId,
          answer: [firstAnswer],
        });
        expect(firstResult.run.lastAction).toMatchObject({
          challengeType: 'CHOICE',
          phase: 'ATTACK',
          prompt: firstPrompt,
          answer: [firstAnswer],
          feedback: { correct: true, answer: 'steady' },
        });
        expect(firstResult.run.challenge?.prompt).not.toBe(firstPrompt);
        expect(await prisma.userWordProgress.count({ where: { userId: first.user.id } })).toBe(1);

        const secondPrompt = second.run.challenge!.prompt;
        const secondAnswer = second.run.challenge!.options!.find((option) => option !== 'steady')!;
        const secondResult = await service.act(second.user.id, second.run.id, {
          clientActionId: `action-${fixtureId}-two`,
          answer: [secondAnswer],
        });
        expect(secondResult.run.lastAction).toMatchObject({
          prompt: secondPrompt,
          answer: [secondAnswer],
          feedback: { correct: false, answer: 'steady' },
        });

        const firstCounts = async () => ({
          actions: await prisma.battleAction.count({ where: { runId: first.run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: first.user.id } }),
          evidence: await prisma.adventureLearningEvidence.count({
            where: { userId: first.user.id },
          }),
          events: await prisma.learningEvent.count({
            where: { userId: first.user.id, type: 'ADVENTURE_BATTLE_ACTION' },
          }),
          progress: await prisma.userWordProgress.findUnique({
            where: {
              userId_bookWordId: {
                userId: first.user.id,
                bookWordId: (
                  await prisma.vocabularyBookWord.findFirstOrThrow({
                    where: { bookId: book.id },
                    select: { id: true },
                  })
                ).id,
              },
            },
            select: { reviewCount: true, totalAttempts: true, correctAttempts: true },
          }),
        });
        const beforeReads = await firstCounts();
        const recoveredFirst = await service.activeRun(first.user.id);
        const recoveredSecond = await service.activeRun(second.user.id);
        const recoveredFirstAgain = await service.activeRun(first.user.id);
        expect(recoveredFirst?.lastAction?.answer).toEqual([firstAnswer]);
        expect(recoveredSecond?.lastAction?.answer).toEqual([secondAnswer]);
        expect(recoveredFirstAgain?.lastAction?.prompt).toBe(firstPrompt);
        expect(recoveredSecond?.lastAction?.answer).not.toContain(firstAnswer);
        expect(await firstCounts()).toEqual(beforeReads);

        const duplicate = await service.act(first.user.id, first.run.id, {
          clientActionId: firstActionId,
          answer: ['a later answer must not replace the saved attempt'],
        });
        expect(duplicate.repeated).toBe(true);
        expect(duplicate.run.lastAction?.answer).toEqual([firstAnswer]);
        expect(await firstCounts()).toEqual(beforeReads);
        expect(ai.generateForUser).not.toHaveBeenCalled();

        const secondAction = await prisma.battleAction.findFirstOrThrow({
          where: { runId: second.run.id },
          orderBy: { createdAt: 'desc' },
        });
        await prisma.battleAction.update({
          where: { id: secondAction.id },
          data: {
            feedback: {
              correct: false,
              message: '历史回答已经保存。',
              answer: 'steady',
            },
          },
        });
        expect((await service.activeRun(second.user.id))?.lastAction?.prompt).toBeNull();
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('recovers a completed result after the final action response is lost without replaying rewards', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const userIds: string[] = [];
      const sourceKey = `adventure-terminal-recovery-${fixtureId}`;
      const normalized = [
        `adventure-terminal-recovery-${fixtureId}-steady`,
        `adventure-terminal-recovery-${fixtureId}-calm`,
      ];
      const ai = { generateForUser: vi.fn() };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );

      try {
        const users = await Promise.all(
          ['owner', 'other'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `adventure-terminal-recovery-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));
        const [owner, other] = users;
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Adventure terminal recovery fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: [
                {
                  position: 0,
                  word: {
                    create: { normalized: normalized[0], text: 'steady', meaning: '稳定的' },
                  },
                },
                {
                  position: 1,
                  word: {
                    create: { normalized: normalized[1], text: 'calm', meaning: '平静的' },
                  },
                },
              ],
            },
          },
          select: { id: true },
        });
        await prisma.userVocabularyBook.create({
          data: { userId: owner.id, bookId: book.id, isDefault: true },
        });

        await service.chooseClass(owner.id, 'warrior');
        const map = await service.dungeons(owner.id);
        const run = await service.startRun(owner.id, map.floors[0].id, 5);
        expect(run.challenge?.type).toBe('CHOICE');
        const actionId = `action-${fixtureId}-terminal`;
        const answer = run.challenge!.options!.find((option) => option === 'steady')!;

        await prisma.dungeonRoom.deleteMany({ where: { runId: run.id, position: { gt: 0 } } });
        await prisma.dungeonRun.update({ where: { id: run.id }, data: { roomCount: 1 } });

        // The committed response is intentionally ignored to simulate a client disconnect.
        await service.act(owner.id, run.id, { clientActionId: actionId, answer: [answer] });
        expect(await service.activeRun(owner.id)).toBeNull();
        const recovered = await service.recoverRun(owner.id, run.id);
        expect(recovered).toMatchObject({
          id: run.id,
          status: 'COMPLETED',
          roomCount: 1,
          experienceEarned: 18,
          goldEarned: 8,
          lastAction: {
            prompt: run.challenge!.prompt,
            answer: [answer],
            feedback: { correct: true, answer: 'steady' },
          },
        });
        expect(recovered.challenge).toBeNull();

        const persistedState = async () => ({
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: owner.id } }),
          evidence: await prisma.adventureLearningEvidence.count({ where: { userId: owner.id } }),
          events: await prisma.learningEvent.count({
            where: { userId: owner.id, type: 'ADVENTURE_BATTLE_ACTION' },
          }),
          profile: await prisma.adventureProfile.findUniqueOrThrow({
            where: { userId: owner.id },
            select: { experience: true, gold: true },
          }),
          progress: await prisma.userWordProgress.findMany({
            where: { userId: owner.id },
            select: { reviewCount: true, totalAttempts: true, correctAttempts: true },
          }),
        });
        const afterCompletion = await persistedState();
        expect(afterCompletion.actions).toBe(1);
        expect(afterCompletion.attempts).toBe(1);
        expect(afterCompletion.evidence).toBe(1);
        expect(afterCompletion.events).toBe(1);
        expect(afterCompletion.profile).toEqual({ experience: 18, gold: 8 });

        await service.recoverRun(owner.id, run.id);
        await service.recoverRun(owner.id, run.id);
        await expect(service.recoverRun(other.id, run.id)).rejects.toThrow('探索不存在');
        const duplicate = await service.act(owner.id, run.id, {
          clientActionId: actionId,
          answer: ['a retry cannot replace the final answer'],
        });
        expect(duplicate.repeated).toBe(true);
        expect(duplicate.run.status).toBe('COMPLETED');
        expect(duplicate.run.lastAction?.answer).toEqual([answer]);
        expect(await persistedState()).toEqual(afterCompletion);
        expect(ai.generateForUser).not.toHaveBeenCalled();
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
