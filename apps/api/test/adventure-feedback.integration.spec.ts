import { Prisma, PrismaClient } from '@prisma/client';
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

    it('matches challenge mixes to each route length and falls back when choices lack a distractor', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const fullBookSource = `adventure-route-mix-${fixtureId}`;
      const shortBookSource = `adventure-route-fallback-${fixtureId}`;
      const fullWords = Array.from({ length: 12 }, (_, index) => `${fullBookSource}-${index}`);
      const shortWords = [`${shortBookSource}-only`];
      const userIds: string[] = [];
      const ai = { generateForUser: vi.fn() };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );

      try {
        const users = await Promise.all(
          ['full', 'short'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `adventure-route-mix-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));
        const books = await Promise.all(
          [
            { user: users[0], source: fullBookSource, words: fullWords },
            { user: users[1], source: shortBookSource, words: shortWords },
          ].map(async ({ user, source, words }) => {
            const book = await prisma.vocabularyBook.create({
              data: {
                sourceKey: source,
                category: 'GENERAL',
                title: 'Adventure route fixture',
                sourcePath: 'test',
                kind: 'SYSTEM',
                bookWords: {
                  create: words.map((normalized, position) => ({
                    position,
                    word: {
                      create: {
                        normalized,
                        text: words.length === 1 ? 'calm' : `routeword${position}`,
                        meaning: '路线测试词',
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
            return book;
          }),
        );

        const focusSequences = {
          BALANCED: ['CHOICE', 'SPELLING', 'SENTENCE_ORDER', 'MATCHING', 'FREE_RESPONSE'],
          RECALL: ['SPELLING', 'SPELLING', 'CHOICE', 'SPELLING', 'SENTENCE_ORDER'],
          CONTEXT: ['SENTENCE_ORDER', 'SENTENCE_ORDER', 'SPELLING', 'SENTENCE_ORDER', 'MATCHING'],
        } as const;
        const roomRoutes = {
          5: ['COMBAT', 'ELITE', 'TREASURE'],
          10: ['COMBAT', 'EVENT', 'ELITE', 'CAMP', 'COMBAT', 'TREASURE'],
          15: [
            'COMBAT',
            'EVENT',
            'COMBAT',
            'TREASURE',
            'ELITE',
            'CAMP',
            'COMBAT',
            'ELITE',
            'TREASURE',
          ],
        } as const;
        const fullMap = await service.dungeons(users[0].id);
        const fullFloor = fullMap.floors[0];
        for (const focus of Object.keys(focusSequences) as Array<keyof typeof focusSequences>) {
          for (const durationMinutes of [5, 10, 15] as const) {
            const run = await service.startRun(users[0].id, fullFloor.id, durationMinutes, focus);
            const rooms = await prisma.dungeonRoom.findMany({
              where: { runId: run.id },
              orderBy: { position: 'asc' },
              select: { type: true, challenge: true },
            });
            const challengeTypes = rooms.map(
              (room) => (room.challenge as unknown as { type: string }).type,
            );
            expect(run.roomCount).toBe(roomRoutes[durationMinutes].length);
            expect(rooms.map((room) => room.type)).toEqual(roomRoutes[durationMinutes]);
            expect(challengeTypes).toEqual(
              Array.from(
                { length: roomRoutes[durationMinutes].length },
                (_, index) => focusSequences[focus][index % focusSequences[focus].length],
              ),
            );
            if (focus === 'RECALL')
              expect(challengeTypes.filter((type) => type === 'SPELLING').length).toBeGreaterThan(
                challengeTypes.length / 2,
              );
            if (focus === 'CONTEXT')
              expect(
                challengeTypes.filter((type) => type === 'SENTENCE_ORDER').length,
              ).toBeGreaterThan(challengeTypes.length / 2);
            await prisma.dungeonRun.update({
              where: { id: run.id },
              data: { status: 'RETREATED', completedAt: new Date() },
            });
          }
        }

        const shortMap = await service.dungeons(users[1].id);
        const shortRun = await service.startRun(users[1].id, shortMap.floors[0].id, 10, 'BALANCED');
        const shortChallenges = await prisma.dungeonRoom.findMany({
          where: { runId: shortRun.id },
          orderBy: { position: 'asc' },
          select: { challenge: true },
        });
        expect(
          shortChallenges.map((room) => (room.challenge as unknown as { type: string }).type),
        ).toEqual([
          'SPELLING',
          'SPELLING',
          'SENTENCE_ORDER',
          'SPELLING',
          'FREE_RESPONSE',
          'SPELLING',
        ]);
        for (const room of [shortChallenges[0], shortChallenges[3], shortChallenges[5]]) {
          const challenge = room.challenge as unknown as { options?: string[]; type: string };
          expect(challenge.type).toBe('SPELLING');
          expect(challenge.options).toBeUndefined();
        }
        expect(ai.generateForUser).not.toHaveBeenCalled();
        expect(await prisma.battleAction.count({ where: { run: { userId: users[0].id } } })).toBe(
          0,
        );
        expect(await prisma.wordReviewAttempt.count({ where: { userId: { in: userIds } } })).toBe(
          0,
        );
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({
          where: { sourceKey: { in: [fullBookSource, shortBookSource] } },
        });
        await prisma.vocabularyWord.deleteMany({
          where: { normalized: { in: [...fullWords, ...shortWords] } },
        });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('completes and resumes a real three-room route with one-time SRS and reward settlement', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `adventure-full-route-${fixtureId}`;
      const normalized = Array.from({ length: 12 }, (_, index) => `${sourceKey}-${index}`);
      let userId: string | undefined;
      const ai = { generateForUser: vi.fn() };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );

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
            title: 'Adventure full route fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: normalized.map((value, position) => ({
                position,
                word: {
                  create: {
                    normalized: value,
                    text: `recallword${position}`,
                    meaning: '回想测试词',
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
        const floor = (await service.dungeons(user.id)).floors[0];
        let run = await service.startRun(user.id, floor.id, 5, 'RECALL');
        expect(run).toMatchObject({ status: 'ACTIVE', practiceFocus: 'RECALL', roomCount: 3 });
        expect(run.rooms.map((room) => room.type)).toEqual(['COMBAT', 'ELITE', 'TREASURE']);

        const savedActionIds: string[] = [];
        const observedChallenges: string[] = [];
        for (let index = 0; run.status === 'ACTIVE' && index < 12; index += 1) {
          const room = await prisma.dungeonRoom.findUniqueOrThrow({
            where: { runId_position: { runId: run.id, position: run.currentRoom } },
            select: { challenge: true },
          });
          const challenge = room.challenge as unknown as {
            id: string;
            type: string;
            phase: string;
            prompt: string;
            expected: string[];
          };
          expect(challenge.type).not.toBe('FREE_RESPONSE');
          observedChallenges.push(`${challenge.phase}:${challenge.type}`);
          const clientActionId = `adventure-full-route-${fixtureId}-${index}`;
          const response = await service.act(user.id, run.id, {
            clientActionId,
            answer: [challenge.expected[0]],
            responseTimeMs: 900 + index,
          });
          expect(response.repeated).toBe(false);
          savedActionIds.push(clientActionId);
          run = response.run;

          if (index === 0) {
            const resumed = await service.activeRun(user.id);
            expect(resumed).toMatchObject({
              id: run.id,
              status: 'ACTIVE',
              practiceFocus: 'RECALL',
              lastAction: { prompt: challenge.prompt, answer: [challenge.expected[0]] },
            });
            expect(resumed?.challenge).toBeTruthy();
            run = resumed!;
          }
        }

        expect(run.status).toBe('COMPLETED');
        expect(observedChallenges).toEqual([
          'ATTACK:SPELLING',
          'ATTACK:SPELLING',
          'BLOCK:SPELLING',
          'ATTACK:CHOICE',
          'ATTACK:CHOICE',
        ]);
        expect(savedActionIds).toHaveLength(5);
        expect(await service.activeRun(user.id)).toBeNull();
        const recovered = await service.recoverRun(user.id, run.id);
        expect(recovered).toMatchObject({
          id: run.id,
          status: 'COMPLETED',
          practiceFocus: 'RECALL',
          experienceEarned: 72,
          goldEarned: 32,
          materialsEarned: 2,
          lastAction: {
            answer: [expect.any(String)],
            feedback: { correct: true, provisional: false },
          },
        });
        expect(recovered.challenge).toBeNull();

        const persistedState = async () => ({
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: user.id } }),
          correctAttempts: await prisma.wordReviewAttempt.count({
            where: { userId: user.id, isCorrect: true },
          }),
          evidence: await prisma.adventureLearningEvidence.count({ where: { runId: run.id } }),
          validRecall: await prisma.adventureLearningEvidence.count({
            where: { runId: run.id, validRecall: true },
          }),
          events: await prisma.learningEvent.count({
            where: { userId: user.id, type: 'ADVENTURE_BATTLE_ACTION' },
          }),
          progress: await prisma.userWordProgress.findMany({
            where: { userId: user.id },
            select: { reviewCount: true, totalAttempts: true, correctAttempts: true },
          }),
          profile: await prisma.adventureProfile.findUniqueOrThrow({
            where: { userId: user.id },
            select: { experience: true, gold: true, materials: true },
          }),
        });
        const afterCompletion = await persistedState();
        expect(afterCompletion.actions).toBe(5);
        expect(afterCompletion.attempts).toBe(5);
        expect(afterCompletion.correctAttempts).toBe(5);
        expect(afterCompletion.evidence).toBe(5);
        expect(afterCompletion.validRecall).toBe(3);
        expect(afterCompletion.events).toBe(5);
        expect(afterCompletion.progress.reduce((sum, item) => sum + item.reviewCount, 0)).toBe(5);
        expect(afterCompletion.progress.reduce((sum, item) => sum + item.totalAttempts, 0)).toBe(5);
        expect(afterCompletion.progress.reduce((sum, item) => sum + item.correctAttempts, 0)).toBe(
          5,
        );
        expect(afterCompletion.profile).toEqual({ experience: 72, gold: 32, materials: 2 });
        expect(ai.generateForUser).not.toHaveBeenCalled();

        await service.recoverRun(user.id, run.id);
        await service.recoverRun(user.id, run.id);
        const duplicate = await service.act(user.id, run.id, {
          clientActionId: savedActionIds.at(-1)!,
          answer: ['a retry cannot replace the saved answer'],
        });
        expect(duplicate.repeated).toBe(true);
        expect(duplicate.run.lastAction?.answer).toEqual(recovered.lastAction?.answer);
        expect(await persistedState()).toEqual(afterCompletion);
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

        await prisma.dungeonRun.update({
          where: { id: run.id },
          data: { status: 'RETREATED', completedAt: new Date() },
        });
        const beforeRead = {
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: user.id } }),
          evidence: await prisma.adventureLearningEvidence.count({ where: { runId: run.id } }),
          events: await prisma.learningEvent.count({
            where: { userId: user.id, type: 'ADVENTURE_BATTLE_ACTION' },
          }),
          profile: await prisma.adventureProfile.findUniqueOrThrow({
            where: { userId: user.id },
            select: { experience: true, gold: true },
          }),
        };
        const terminal = await service.recoverRun(user.id, run.id);
        expect(terminal.mistakeReview).toMatchObject([
          {
            challengeType: 'FREE_RESPONSE',
            prompt: '用 patient 写一个完整句子',
            answer: ['We can use patient words in context.'],
            referenceAnswer: 'I can be patient.',
            reviewOutcome: 'UNJUDGEABLE',
          },
        ]);
        expect(terminal.unavailableMistakeReviewCount).toBe(0);
        expect({
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: user.id } }),
          evidence: await prisma.adventureLearningEvidence.count({ where: { runId: run.id } }),
          events: await prisma.learningEvent.count({
            where: { userId: user.id, type: 'ADVENTURE_BATTLE_ACTION' },
          }),
          profile: await prisma.adventureProfile.findUniqueOrThrow({
            where: { userId: user.id },
            select: { experience: true, gold: true },
          }),
        }).toEqual(beforeRead);
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
        const firstRoom = await prisma.dungeonRoom.findUniqueOrThrow({
          where: { runId_position: { runId: run.id, position: 0 } },
          select: { id: true, challenge: true },
        });
        const firstChallenge = firstRoom.challenge as unknown as {
          prompt: string;
          expected: string[];
          options: string[];
          word: string;
          meaning: string;
        };
        const correctAnswer = firstChallenge.expected[0];
        const wrongAnswer = firstChallenge.options.find((option) => option !== correctAnswer)!;

        await prisma.dungeonRoom.deleteMany({ where: { runId: run.id, position: { gt: 0 } } });
        await prisma.dungeonRun.update({ where: { id: run.id }, data: { roomCount: 1 } });

        const wrongActionId = `action-${fixtureId}-wrong`;
        const wrongResponse = await service.act(owner.id, run.id, {
          clientActionId: wrongActionId,
          answer: [wrongAnswer],
        });
        expect(wrongResponse.score).toBeLessThan(70);
        expect(wrongResponse.run.status).toBe('ACTIVE');
        expect(wrongResponse.run.challenge?.phase).toBe('BLOCK');
        expect(wrongResponse.run.mistakeReview).toBeUndefined();

        const blockSnapshot = await prisma.dungeonRoom.findUniqueOrThrow({
          where: { id: firstRoom.id },
          select: { challenge: true },
        });
        const blockAnswer = (blockSnapshot.challenge as unknown as { expected: string[] })
          .expected[0];
        const block = await service.act(owner.id, run.id, {
          clientActionId: `action-${fixtureId}-block`,
          answer: [blockAnswer],
        });
        expect(block.run.status).toBe('ACTIVE');
        expect(block.run.challenge?.phase).toBe('ATTACK');

        const finalSnapshot = await prisma.dungeonRoom.findUniqueOrThrow({
          where: { id: firstRoom.id },
          select: { challenge: true },
        });
        const finalChallenge = finalSnapshot.challenge as unknown as {
          prompt: string;
          expected: string[];
        };
        const actionId = `action-${fixtureId}-terminal`;
        // The committed response is intentionally ignored to simulate a client disconnect.
        await service.act(owner.id, run.id, {
          clientActionId: actionId,
          answer: [finalChallenge.expected[0]],
        });
        expect(await service.activeRun(owner.id)).toBeNull();
        const recovered = await service.recoverRun(owner.id, run.id);
        expect(recovered).toMatchObject({
          id: run.id,
          status: 'COMPLETED',
          roomCount: 1,
          experienceEarned: 18,
          goldEarned: 8,
          lastAction: {
            prompt: finalChallenge.prompt,
            answer: [finalChallenge.expected[0]],
            feedback: { correct: true, answer: finalChallenge.expected[0] },
          },
          mistakeReview: [
            {
              challengeType: 'CHOICE',
              phase: 'ATTACK',
              prompt: firstChallenge.prompt,
              answer: [wrongAnswer],
              referenceAnswer: correctAnswer,
              reviewOutcome: 'BELOW_THRESHOLD',
            },
          ],
          unavailableMistakeReviewCount: 0,
        });
        expect(recovered.challenge).toBeNull();

        const persistedState = async () => ({
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: owner.id } }),
          correctAttempts: await prisma.wordReviewAttempt.count({
            where: { userId: owner.id, isCorrect: true },
          }),
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
        expect(afterCompletion.actions).toBe(3);
        expect(afterCompletion.attempts).toBe(3);
        expect(afterCompletion.correctAttempts).toBe(2);
        expect(afterCompletion.evidence).toBe(3);
        expect(afterCompletion.events).toBe(3);
        expect(afterCompletion.profile).toEqual({ experience: 18, gold: 8 });
        expect(afterCompletion.progress.reduce((sum, item) => sum + item.reviewCount, 0)).toBe(3);
        expect(afterCompletion.progress.reduce((sum, item) => sum + item.totalAttempts, 0)).toBe(3);
        expect(afterCompletion.progress.reduce((sum, item) => sum + item.correctAttempts, 0)).toBe(
          2,
        );

        await service.recoverRun(owner.id, run.id);
        await service.recoverRun(owner.id, run.id);
        await expect(service.recoverRun(other.id, run.id)).rejects.toThrow('探索不存在');
        const duplicate = await service.act(owner.id, run.id, {
          clientActionId: actionId,
          answer: ['a retry cannot replace the final answer'],
        });
        expect(duplicate.repeated).toBe(true);
        expect(duplicate.run.status).toBe('COMPLETED');
        expect(duplicate.run.lastAction?.answer).toEqual([finalChallenge.expected[0]]);
        expect(await persistedState()).toEqual(afterCompletion);

        const incorrectAction = await prisma.battleAction.findFirstOrThrow({
          where: { runId: run.id, score: { lt: 70 } },
          select: { id: true, roomId: true, feedback: true },
        });
        const legacyFeedback = JSON.parse(JSON.stringify(incorrectAction.feedback)) as Record<
          string,
          unknown
        >;
        delete legacyFeedback.prompt;
        delete legacyFeedback.answer;
        delete legacyFeedback.challengeId;
        await prisma.battleAction.update({
          where: { id: incorrectAction.id },
          data: { feedback: legacyFeedback as Prisma.InputJsonValue },
        });
        const unavailableOlderSnapshot = await service.recoverRun(owner.id, run.id);
        expect(unavailableOlderSnapshot.mistakeReview).toEqual([]);
        expect(unavailableOlderSnapshot.unavailableMistakeReviewCount).toBe(1);
        expect(await persistedState()).toEqual(afterCompletion);
        expect(ai.generateForUser).not.toHaveBeenCalled();
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('keeps unjudgeable answers distinct and never reconstructs a changed question from its room', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `adventure-terminal-snapshot-${fixtureId}`;
      const normalized = [`${sourceKey}-patient`, `${sourceKey}-calm`];
      const ai = { generateForUser: vi.fn() };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );
      let userId: string | undefined;

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
            title: 'Adventure terminal snapshot fixture',
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
        const floor = (await service.dungeons(user.id)).floors[0];
        const run = await service.startRun(user.id, floor.id, 5, 'RECALL');
        expect(run.challenge?.type).toBe('SPELLING');
        const room = await prisma.dungeonRoom.findUniqueOrThrow({
          where: { runId_position: { runId: run.id, position: 0 } },
          select: { id: true },
        });
        await prisma.dungeonRoom.deleteMany({ where: { runId: run.id, position: { gt: 0 } } });
        await prisma.dungeonRun.update({
          where: { id: run.id },
          data: { roomCount: 1, playerHp: 1 },
        });

        const attack = await service.act(user.id, run.id, {
          clientActionId: `attack-${fixtureId}`,
          answer: ['definitely-wrong'],
        });
        expect(attack.run.status).toBe('ACTIVE');
        const blockRoom = await prisma.dungeonRoom.findUniqueOrThrow({
          where: { id: room.id },
          select: { challenge: true },
        });
        const blockChallenge = blockRoom.challenge as unknown as {
          id: string;
          type: string;
          phase: string;
          prompt: string;
          expected: string[];
          word: string;
          meaning: string;
        };
        const unjudgeableChallenge = {
          ...blockChallenge,
          type: 'FREE_RESPONSE',
          prompt: '用 patient 写一个完整句子',
          expected: ['I can wait patiently.'],
        };
        expect(unjudgeableChallenge.id).toBe(blockChallenge.id);
        await prisma.dungeonRoom.update({
          where: { id: room.id },
          data: { challenge: unjudgeableChallenge as Prisma.InputJsonValue },
        });
        const failed = await service.act(user.id, run.id, {
          clientActionId: `block-${fixtureId}`,
          answer: ['no'],
        });
        expect(failed.run.status).toBe('FAILED');
        expect(failed.score).toBe(0);
        expect(ai.generateForUser).not.toHaveBeenCalled();

        const savedBeforeQuestionChange = await service.recoverRun(user.id, run.id);
        expect(savedBeforeQuestionChange.mistakeReview).toMatchObject([
          {
            phase: 'ATTACK',
            answer: ['definitely-wrong'],
            reviewOutcome: 'BELOW_THRESHOLD',
          },
          {
            challengeType: 'FREE_RESPONSE',
            phase: 'BLOCK',
            prompt: unjudgeableChallenge.prompt,
            answer: ['no'],
            referenceAnswer: unjudgeableChallenge.expected[0],
            word: unjudgeableChallenge.word,
            meaning: unjudgeableChallenge.meaning,
            reviewOutcome: 'UNJUDGEABLE',
          },
        ]);
        expect(savedBeforeQuestionChange.unavailableMistakeReviewCount).toBe(0);

        const terminalAction = await prisma.battleAction.findUniqueOrThrow({
          where: {
            runId_clientActionId: { runId: run.id, clientActionId: `block-${fixtureId}` },
          },
          select: { id: true, feedback: true },
        });
        const legacyFeedback = JSON.parse(JSON.stringify(terminalAction.feedback)) as Record<
          string,
          unknown
        >;
        delete legacyFeedback.prompt;
        delete legacyFeedback.answer;
        delete legacyFeedback.word;
        delete legacyFeedback.meaning;
        await prisma.dungeonRoom.update({
          where: { id: room.id },
          data: {
            challenge: {
              ...unjudgeableChallenge,
              prompt: '更新后的题干：用 calm 造句',
              expected: ['I feel calm now.'],
              word: 'calm',
              meaning: '平静的',
            } as Prisma.InputJsonValue,
          },
        });
        await prisma.battleAction.update({
          where: { id: terminalAction.id },
          data: {
            feedback: legacyFeedback as Prisma.InputJsonValue,
            createdAt: new Date(Date.now() + 1_000),
          },
        });

        const beforeRead = {
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: user.id } }),
          evidence: await prisma.adventureLearningEvidence.count({ where: { runId: run.id } }),
          profile: await prisma.adventureProfile.findUniqueOrThrow({
            where: { userId: user.id },
            select: { experience: true, gold: true, materials: true },
          }),
          progress: await prisma.userWordProgress.findMany({
            where: { userId: user.id },
            select: { reviewCount: true, totalAttempts: true, correctAttempts: true },
          }),
        };
        const recovered = await service.recoverRun(user.id, run.id);
        expect(recovered.mistakeReview).toMatchObject([
          {
            challengeType: 'SPELLING',
            phase: 'ATTACK',
            answer: ['definitely-wrong'],
            reviewOutcome: 'BELOW_THRESHOLD',
          },
        ]);
        expect(recovered.unavailableMistakeReviewCount).toBe(1);
        expect(JSON.stringify(recovered.mistakeReview)).not.toContain('更新后的题干');
        expect(JSON.stringify(recovered.mistakeReview)).not.toContain('I feel calm now.');
        expect(JSON.stringify(recovered.mistakeReview)).not.toContain('平静的');
        expect({
          actions: await prisma.battleAction.count({ where: { runId: run.id } }),
          attempts: await prisma.wordReviewAttempt.count({ where: { userId: user.id } }),
          evidence: await prisma.adventureLearningEvidence.count({ where: { runId: run.id } }),
          profile: await prisma.adventureProfile.findUniqueOrThrow({
            where: { userId: user.id },
            select: { experience: true, gold: true, materials: true },
          }),
          progress: await prisma.userWordProgress.findMany({
            where: { userId: user.id },
            select: { reviewCount: true, totalAttempts: true, correctAttempts: true },
          }),
        }).toEqual(beforeRead);
        expect(ai.generateForUser).not.toHaveBeenCalled();
      } finally {
        if (userId) await prisma.user.delete({ where: { id: userId } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
