import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AdventureService } from '../src/modules/adventure/adventure.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'versioned adventure combat passives in an isolated database',
  () => {
    it('applies each passive once in game state, preserves route focus, and leaves legacy runs unchanged', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const sourceKey = `adventure-passive-${fixtureId}`;
      const normalized = Array.from({ length: 12 }, (_, index) => `${sourceKey}-${index}`);
      const userIds: string[] = [];
      const ai = {
        generateForUser: vi.fn(async () => JSON.stringify({ score: 80, message: '表达清楚。' })),
      };
      const service = new AdventureService(
        prisma as never,
        new MistakesService(prisma as never),
        ai as never,
      );

      const setChallenge = async (
        runId: string,
        position: number,
        overrides: Record<string, unknown>,
        enemyHp = 100,
      ) => {
        const room = await prisma.dungeonRoom.findUniqueOrThrow({
          where: { runId_position: { runId, position } },
          select: { id: true, challenge: true },
        });
        const challenge = {
          ...(room.challenge as Record<string, unknown>),
          id: `passive-fixture-${position}-${String(overrides.phase)}-${String(overrides.type)}`,
          prompt: '本地被动验收题',
          expected: ['yes'],
          ...overrides,
        };
        await prisma.dungeonRoom.update({
          where: { id: room.id },
          data: {
            challenge: challenge as Prisma.InputJsonValue,
            enemyHp,
            enemyMaxHp: enemyHp,
          },
        });
        return challenge;
      };
      const answerFor = (challenge: Record<string, unknown>) =>
        challenge.type === 'SENTENCE_ORDER'
          ? String((challenge.expected as string[])[0]).split(' ')
          : [String((challenge.expected as string[])[0])];
      const act = (
        userId: string,
        runId: string,
        suffix: string,
        answer: string[],
        skillId?: string,
      ) =>
        service.act(userId, runId, {
          clientActionId: `passive-${fixtureId}-${suffix}`,
          answer,
          ...(skillId ? { skillId } : {}),
        });

      try {
        const book = await prisma.vocabularyBook.create({
          data: {
            sourceKey,
            category: 'GENERAL',
            title: 'Combat passive fixture',
            sourcePath: 'test',
            kind: 'SYSTEM',
            bookWords: {
              create: normalized.map((value, position) => ({
                position,
                word: {
                  create: { normalized: value, text: `passive${position}`, meaning: '测试词' },
                },
              })),
            },
          },
          select: { id: true },
        });
        const roles = [
          { classKey: 'warrior', key: 'VANGUARD' },
          { classKey: 'mage', key: 'BURST' },
          { classKey: 'ranger', key: 'STRIKER' },
          { classKey: 'cleric', key: 'SUPPORT' },
        ] as const;
        const users = await Promise.all(
          roles.map((role) =>
            prisma.user.create({
              data: {
                email: `adventure-passive-${fixtureId}-${role.classKey}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
                vocabularyBooks: { create: { bookId: book.id, isDefault: true } },
              },
              select: { id: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));

        const runs = [];
        for (let index = 0; index < roles.length; index += 1) {
          const user = users[index];
          const role = roles[index];
          await service.chooseClass(user.id, role.classKey);
          const profile = await service.profile(user.id);
          expect(profile.currentClass?.combatPassive?.key).toBe(role.key);
          const floor = (await service.dungeons(user.id)).floors[0];
          const run = await service.startRun(user.id, floor.id, 5, 'CONTEXT');
          expect(run).toMatchObject({
            status: 'ACTIVE',
            practiceFocus: 'CONTEXT',
            combatRulesVersion: 1,
            combatPassive: { key: role.key },
            challenge: { type: 'SENTENCE_ORDER', phase: 'ATTACK' },
          });
          const saved = await prisma.dungeonRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { snapshot: true },
          });
          expect(saved.snapshot).toMatchObject({
            version: 3,
            practiceFocus: 'CONTEXT',
            combatRulesVersion: 1,
            combatPassiveKey: role.key,
          });
          runs.push({ userId: user.id, run });
        }
        expect(runs.map(({ run }) => run.challenge?.type)).toEqual([
          'SENTENCE_ORDER',
          'SENTENCE_ORDER',
          'SENTENCE_ORDER',
          'SENTENCE_ORDER',
        ]);

        const warrior = runs[0];
        await setChallenge(warrior.run.id, warrior.run.currentRoom, {
          type: 'FREE_RESPONSE',
          phase: 'BLOCK',
          expected: ['I can be patient today.'],
        });
        const guardAction = await act(warrior.userId, warrior.run.id, 'guard', [
          'I can be patient today.',
        ]);
        expect(guardAction).toMatchObject({
          score: 80,
          damageReceived: 3,
          feedback: { passiveTrigger: '稳守：额外减伤 4 点。' },
          run: { lastAction: { feedback: { passiveTrigger: '稳守：额外减伤 4 点。' } } },
        });
        await prisma.dungeonRun.update({
          where: { id: warrior.run.id },
          data: { status: 'RETREATED', completedAt: new Date() },
        });

        const mage = runs[1];
        const mageChallenge = await setChallenge(mage.run.id, mage.run.currentRoom, {
          type: 'SENTENCE_ORDER',
          phase: 'ATTACK',
          expected: ['We read passive words.'],
        });
        const mageSkillId = 'skill-mage-1';
        const mageAction = await act(
          mage.userId,
          mage.run.id,
          'mage',
          answerFor(mageChallenge),
          mageSkillId,
        );
        expect(mageAction).toMatchObject({
          score: 100,
          damageDealt: 52,
          feedback: { passiveTrigger: '精准施法：技能完美命中，额外造成 6 点战斗伤害。' },
        });
        const repeatedMageAction = await service.act(mage.userId, mage.run.id, {
          clientActionId: `passive-${fixtureId}-mage`,
          answer: ['ignored duplicate payload'],
        });
        expect(repeatedMageAction).toMatchObject({
          repeated: true,
          damageDealt: 52,
          feedback: { passiveTrigger: '精准施法：技能完美命中，额外造成 6 点战斗伤害。' },
        });
        expect(await prisma.battleAction.count({ where: { runId: mage.run.id } })).toBe(1);
        expect(
          await prisma.adventureLearningEvidence.count({
            where: { userId: mage.userId, runId: mage.run.id },
          }),
        ).toBe(1);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: mage.userId } })).toBe(1);

        const ranger = runs[2];
        await setChallenge(ranger.run.id, ranger.run.currentRoom, {
          type: 'CHOICE',
          phase: 'ATTACK',
          expected: ['yes'],
        });
        const firstStrike = await act(ranger.userId, ranger.run.id, 'ranger-1', ['yes']);
        expect(firstStrike.damageDealt).toBe(40);
        await setChallenge(ranger.run.id, ranger.run.currentRoom, {
          type: 'CHOICE',
          phase: 'BLOCK',
          expected: ['yes'],
        });
        await act(ranger.userId, ranger.run.id, 'ranger-2', ['yes']);
        await setChallenge(ranger.run.id, ranger.run.currentRoom, {
          type: 'CHOICE',
          phase: 'ATTACK',
          expected: ['yes'],
        });
        const comboStrike = await act(ranger.userId, ranger.run.id, 'ranger-3', ['yes']);
        expect(comboStrike).toMatchObject({
          damageDealt: 46,
          feedback: { passiveTrigger: '连续出击：连续答对，额外造成 6 点战斗伤害。' },
        });
        await setChallenge(ranger.run.id, ranger.run.currentRoom, {
          type: 'CHOICE',
          phase: 'BLOCK',
          expected: ['yes'],
        });
        await act(ranger.userId, ranger.run.id, 'ranger-miss', ['no']);
        await setChallenge(ranger.run.id, ranger.run.currentRoom, {
          type: 'CHOICE',
          phase: 'ATTACK',
          expected: ['yes'],
        });
        const afterMiss = await act(ranger.userId, ranger.run.id, 'ranger-reset', ['yes']);
        expect(afterMiss.damageDealt).toBe(40);
        expect(afterMiss.feedback.passiveTrigger).toBeUndefined();

        const cleric = runs[3];
        await prisma.dungeonRun.update({
          where: { id: cleric.run.id },
          data: { playerHp: 90 },
        });
        const clericAttackChallenge = await setChallenge(cleric.run.id, cleric.run.currentRoom, {
          type: 'SENTENCE_ORDER',
          phase: 'ATTACK',
          expected: ['We read passive words.'],
        });
        const clericAttack = await act(
          cleric.userId,
          cleric.run.id,
          'cleric-1',
          answerFor(clericAttackChallenge),
        );
        expect(clericAttack).toMatchObject({
          feedback: { passiveTrigger: '温和疗愈：恢复 4 点生命（本房间一次）。' },
          run: { playerHp: 94 },
        });
        const clericBlockChallenge = await setChallenge(cleric.run.id, cleric.run.currentRoom, {
          type: 'SENTENCE_ORDER',
          phase: 'BLOCK',
          expected: ['We read passive words.'],
        });
        const clericBlock = await act(
          cleric.userId,
          cleric.run.id,
          'cleric-2',
          answerFor(clericBlockChallenge),
        );
        expect(clericBlock.run.playerHp).toBe(94);
        expect(clericBlock.feedback.passiveTrigger).toBeUndefined();

        const legacyRun = await service.startRun(
          warrior.userId,
          warrior.run.floor.id,
          5,
          'CONTEXT',
        );
        await prisma.dungeonRun.update({
          where: { id: legacyRun.id },
          data: {
            snapshot: {
              version: 2,
              classId: 'class-warrior',
              stats: {},
              practiceFocus: 'CONTEXT',
            },
          },
        });
        const recoveredLegacy = await service.recoverRun(warrior.userId, legacyRun.id);
        expect(recoveredLegacy).toMatchObject({
          practiceFocus: 'CONTEXT',
          combatPassive: null,
          challenge: { phase: 'ATTACK' },
        });
        await setChallenge(legacyRun.id, legacyRun.currentRoom, {
          type: 'FREE_RESPONSE',
          phase: 'BLOCK',
          expected: ['I can be patient today.'],
        });
        const legacyAction = await act(warrior.userId, legacyRun.id, 'legacy', [
          'I can be patient today.',
        ]);
        expect(legacyAction).toMatchObject({ score: 80, damageReceived: 7 });
        expect(legacyAction.feedback.passiveTrigger).toBeUndefined();
        expect(legacyAction.run.combatPassive).toBeNull();
      } finally {
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized: { in: normalized } } });
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
