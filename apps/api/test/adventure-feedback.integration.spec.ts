import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AdventureService } from '../src/modules/adventure/adventure.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'adventure feedback recovery in an isolated database',
  () => {
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
