import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdventureActionPhase,
  AdventureChallengeType,
  AdventureEvidenceKind,
  AdventureHitGrade,
  AdventureQuestType,
  AdventureRoomStatus,
  AdventureRoomType,
  AdventureRunStatus,
  CefrLevel,
  EquipmentSlot,
  Prisma,
  WeaknessStatus,
  WordProgressState,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import type { AdventurePracticeFocus } from '@lexloop/types';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { MistakesService } from '../mistakes/mistakes.service';
import { reviewSchedule } from '../study/review-scheduling';
import { lockUserWordProgress } from '../study/user-word-progress-lock';
import { CLASS_NODES, ENEMIES, EQUIPMENT, FLOOR_TITLES, SKILLS } from './adventure.catalog';
import {
  aggregateMastery,
  attackDamage,
  evidenceKind,
  experienceLevel,
  experienceToNextLevel,
  gradeProvisionalFreeResponse,
  hitGrade,
  incomingDamage,
  challengeTypeForFocus,
  normalizePracticeFocus,
} from './adventure.rules';

type StoredChallenge = {
  id: string;
  type: AdventureChallengeType;
  phase: AdventureActionPhase;
  prompt: string;
  options?: string[];
  tokens?: string[];
  hint?: string;
  inputPlaceholder?: string;
  expected: string[];
  targetId: string;
  word: string;
  meaning: string;
};

type NumericStats = Record<string, number>;

@Injectable()
export class AdventureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mistakes: MistakesService,
    private readonly ai: AiService,
  ) {}

  async profile(userId: string) {
    await this.ensureCatalog();
    const profile = await this.prisma.adventureProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return this.serializeProfile(profile.id);
  }

  async chooseClass(userId: string, classKey: string) {
    await this.ensureCatalog();
    const target = await this.prisma.classNode.findFirst({
      where: { key: classKey, tier: 0, isActive: true },
    });
    if (!target) throw new NotFoundException('基础职业不存在');
    const profile = await this.prisma.adventureProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    if (profile.currentClassId && profile.currentClassId !== target.id)
      throw new BadRequestException('已经选择职业；后续请通过转职继续成长');
    await this.prisma.$transaction(async (tx) => {
      await tx.adventureProfile.update({
        where: { id: profile.id },
        data: { currentClassId: target.id },
      });
      const starter = SKILLS.find((item) => item.classNodeId === target.id);
      if (starter)
        await tx.userSkill.upsert({
          where: { profileId_skillId: { profileId: profile.id, skillId: starter.id } },
          create: { profileId: profile.id, skillId: starter.id },
          update: {},
        });
    });
    return this.serializeProfile(profile.id);
  }

  async advanceClass(userId: string, classKey: string) {
    const profile = await this.requireProfile(userId);
    if (!profile.currentClassId) throw new BadRequestException('请先选择基础职业');
    const target = await this.prisma.classNode.findFirst({
      where: { key: classKey, parentId: profile.currentClassId, isActive: true },
    });
    if (!target) throw new BadRequestException('该职业不是当前职业的可用转职');
    if (profile.level < target.requiredLevel)
      throw new BadRequestException(`需要达到 ${target.requiredLevel} 级`);
    await this.prisma.$transaction(async (tx) => {
      await tx.adventureProfile.update({
        where: { id: profile.id },
        data: { currentClassId: target.id, skillPoints: { increment: 1 } },
      });
      const starter = SKILLS.find((item) => item.classNodeId === target.id);
      if (starter)
        await tx.userSkill.upsert({
          where: { profileId_skillId: { profileId: profile.id, skillId: starter.id } },
          create: { profileId: profile.id, skillId: starter.id },
          update: {},
        });
    });
    return this.serializeProfile(profile.id);
  }

  async unlockSkill(userId: string, skillId: string) {
    const profile = await this.requireProfile(userId);
    if (!profile.currentClassId) throw new BadRequestException('请先选择职业');
    if (profile.skillPoints < 1) throw new BadRequestException('技能点不足');
    const skill = await this.prisma.skillDefinition.findUnique({ where: { id: skillId } });
    if (!skill) throw new NotFoundException('技能不存在');
    const lineage = await this.classLineage(profile.currentClassId);
    if (!lineage.includes(skill.classNodeId) || profile.level < skill.requiredLevel)
      throw new BadRequestException('尚未满足该技能的解锁条件');
    if (skill.requiredSkillId) {
      const prerequisite = await this.prisma.userSkill.findUnique({
        where: { profileId_skillId: { profileId: profile.id, skillId: skill.requiredSkillId } },
      });
      if (!prerequisite) throw new BadRequestException('请先掌握技能树中的前置节点');
    }
    await this.prisma.$transaction(async (tx) => {
      const exists = await tx.userSkill.findUnique({
        where: { profileId_skillId: { profileId: profile.id, skillId } },
      });
      if (exists) return;
      const spent = await tx.adventureProfile.updateMany({
        where: { id: profile.id, skillPoints: { gte: 1 } },
        data: { skillPoints: { decrement: 1 } },
      });
      if (!spent.count) throw new ConflictException('技能点状态已经变化');
      await tx.userSkill.create({ data: { profileId: profile.id, skillId } });
    });
    return this.serializeProfile(profile.id);
  }

  async dungeons(userId: string) {
    await this.ensureFloors(userId);
    const selected = await this.defaultBook(userId);
    if (!selected) return { book: null, floors: [] };
    const [floors, verifiedProgress] = await Promise.all([
      this.prisma.dungeonFloor.findMany({
        where: { bookId: selected.book.id, isActive: true },
        orderBy: { floorNumber: 'asc' },
        include: { _count: { select: { targets: true } }, progresses: { where: { userId } } },
      }),
      this.verifiedFloorProgress(userId, selected.book.id),
    ]);
    const progressByFloor = new Map(verifiedProgress.map((item) => [item.floorId, item]));
    return {
      book: { id: selected.book.id, title: selected.book.title },
      floors: floors.map((floor, index) => {
        const savedProgress = floor.progresses[0];
        const verified = progressByFloor.get(floor.id) ?? {
          exploration: 0,
          mastery: 0,
          bossUnlocked: false,
        };
        return this.floorSummary(
          floor,
          {
            ...verified,
            completedAt: savedProgress?.completedAt ?? null,
            bestScore: savedProgress?.bestScore ?? 0,
          },
          index > 0 && !floors[index - 1].progresses[0]?.completedAt,
        );
      }),
    };
  }

  async startRun(
    userId: string,
    floorId: string,
    durationMinutes: 5 | 10 | 15,
    practiceFocus: AdventurePracticeFocus = 'BALANCED',
  ) {
    practiceFocus = normalizePracticeFocus(practiceFocus);
    const profile = await this.requireProfile(userId);
    if (!profile.currentClassId) throw new BadRequestException('请先选择冒险职业');
    const active = await this.prisma.dungeonRun.findFirst({
      where: { userId, status: AdventureRunStatus.ACTIVE },
      select: { id: true },
    });
    if (active) throw new ConflictException('已有进行中的探索，请先继续或撤退');
    const map = await this.dungeons(userId);
    const floor = map.floors.find((item) => item.id === floorId);
    if (!floor) throw new NotFoundException('地牢楼层不存在');
    if (floor.locked) throw new BadRequestException('请先通过上一层地牢');
    const targetRows = await this.prisma.floorLearningTarget.findMany({
      where: { floorId },
      orderBy: { position: 'asc' },
      include: { bookWord: { include: { word: true } } },
    });
    if (!targetRows.length) throw new BadRequestException('该楼层还没有学习目标');
    const seed = createHash('sha256')
      .update(`${userId}:${floorId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 20);
    const roomTypes = routeFor(durationMinutes, floor.bossUnlocked);
    const stats = await this.equipmentStats(userId);
    const maxHp = 100 + Math.round(stats.maxHp ?? 0);
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`adventure-start:${userId}`}))`,
      );
      const concurrentRun = await tx.dungeonRun.findFirst({
        where: { userId, status: AdventureRunStatus.ACTIVE },
        select: { id: true },
      });
      if (concurrentRun) throw new ConflictException('已有进行中的探索，请先继续或撤退');
      const created = await tx.dungeonRun.create({
        data: {
          userId,
          floorId,
          durationMinutes,
          seed,
          roomCount: roomTypes.length,
          playerHp: maxHp,
          playerMaxHp: maxHp,
          snapshot: json({ version: 2, classId: profile.currentClassId, stats, practiceFocus }),
        },
      });
      for (let index = 0; index < roomTypes.length; index += 1) {
        const type = roomTypes[index];
        const target = targetRows[index % targetRows.length];
        const challenge = buildChallenge(
          target,
          targetRows,
          index,
          AdventureActionPhase.ATTACK,
          seed,
          practiceFocus,
        );
        await tx.dungeonRoom.create({
          data: {
            runId: created.id,
            position: index,
            type,
            status: index === 0 ? AdventureRoomStatus.ACTIVE : AdventureRoomStatus.PENDING,
            enemyName: enemyName(type, seed, index),
            enemyHp: enemyHp(type),
            enemyMaxHp: enemyHp(type),
            challenge: json(challenge),
            reward: json(roomReward(type)),
            state: json({ attackCount: 0, hits: 0, productionFailed: false }),
          },
        });
      }
      return created;
    });
    return this.serializeRun(run.id, userId);
  }

  async activeRun(userId: string) {
    const run = await this.prisma.dungeonRun.findFirst({
      where: { userId, status: AdventureRunStatus.ACTIVE },
      orderBy: { startedAt: 'desc' },
    });
    return run ? this.serializeRun(run.id, userId) : null;
  }

  async recoverRun(userId: string, runId: string) {
    return this.serializeRun(runId, userId);
  }

  async act(
    userId: string,
    runId: string,
    input: { clientActionId: string; skillId?: string; answer: unknown[]; responseTimeMs?: number },
  ) {
    const duplicate = await this.prisma.battleAction.findUnique({
      where: { runId_clientActionId: { runId, clientActionId: input.clientActionId } },
    });
    if (duplicate) return this.actionResponse(userId, duplicate, true);
    const run = await this.prisma.dungeonRun.findFirst({
      where: { id: runId, userId },
      include: { rooms: { orderBy: { position: 'asc' } } },
    });
    if (!run) throw new NotFoundException('探索不存在');
    if (run.status !== AdventureRunStatus.ACTIVE) throw new BadRequestException('本次探索已经结束');
    const room = run.rooms.find((item) => item.position === run.currentRoom);
    if (!room || room.status !== AdventureRoomStatus.ACTIVE)
      throw new ConflictException('当前房间状态已经变化');
    const challenge = asChallenge(room.challenge);
    const grading = await this.grade(userId, challenge, input.answer);
    const grade = hitGrade(grading.score);
    const skill = input.skillId ? await this.availableSkill(userId, input.skillId) : null;
    if (input.skillId && !skill) throw new BadRequestException('技能未解锁或不属于当前职业');
    const snapshot = record(run.snapshot);
    const stats = numericRecord(snapshot.stats);
    const skillEffect = numericRecord(skill?.effect);
    const cost = challenge.phase === AdventureActionPhase.ATTACK ? (skill?.cost ?? 0) : 0;
    if (cost > run.resource) throw new BadRequestException('职业资源不足');

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`adventure-run:${runId}`}))`,
      );
      const current = await tx.dungeonRun.findFirstOrThrow({
        where: { id: runId, userId },
        include: { rooms: { orderBy: { position: 'asc' } } },
      });
      const existing = await tx.battleAction.findUnique({
        where: { runId_clientActionId: { runId, clientActionId: input.clientActionId } },
      });
      if (existing) return existing;
      const currentRoom = current.rooms.find((item) => item.id === room.id);
      if (
        !currentRoom ||
        current.status !== AdventureRunStatus.ACTIVE ||
        current.currentRoom !== room.position
      )
        throw new ConflictException('战斗状态已经变化，请刷新后继续');
      const currentChallenge = asChallenge(currentRoom.challenge);
      if (currentChallenge.id !== challenge.id || currentChallenge.phase !== challenge.phase)
        throw new ConflictException('战斗题目已经变化，请刷新后继续');
      const state = {
        attackCount: 0,
        hits: 0,
        productionFailed: false,
        ...record(currentRoom.state),
      } as { attackCount: number; hits: number; productionFailed: boolean };
      let damageDealt = 0;
      let damageReceived = 0;
      let nextHp = current.playerHp;
      let nextEnemyHp = currentRoom.enemyHp ?? 0;
      let nextPhase: AdventureActionPhase = AdventureActionPhase.ATTACK;
      let roomCleared = false;
      let runStatus: AdventureRunStatus = current.status;
      if (challenge.phase === AdventureActionPhase.ATTACK) {
        state.attackCount += 1;
        if (grading.score >= 70) state.hits += 1;
        if (challenge.type === AdventureChallengeType.FREE_RESPONSE && grading.score < 70)
          state.productionFailed = true;
        damageDealt = attackDamage(
          grading.score,
          (stats.attackMultiplier ?? 1) * (skillEffect.damageMultiplier ?? 1),
        );
        nextEnemyHp = Math.max(0, nextEnemyHp - damageDealt);
        if (
          currentRoom.type === AdventureRoomType.BOSS &&
          nextEnemyHp === 0 &&
          state.attackCount < 6
        )
          nextEnemyHp = 1;
        if (currentRoom.type === AdventureRoomType.BOSS && state.attackCount >= 6) {
          roomCleared = state.hits >= 5 && !state.productionFailed && nextEnemyHp === 0;
          if (!roomCleared) {
            nextHp = 0;
            runStatus = AdventureRunStatus.FAILED;
          }
        } else roomCleared = nextEnemyHp === 0;
        nextPhase = roomCleared ? AdventureActionPhase.ATTACK : AdventureActionPhase.BLOCK;
      } else {
        damageReceived = incomingDamage(
          grading.score,
          currentRoom.type,
          (stats.blockBonus ?? 0) + (skillEffect.blockBonus ?? 0),
        );
        nextHp = Math.max(0, current.playerHp - damageReceived);
        if (nextHp === 0) runStatus = AdventureRunStatus.FAILED;
      }
      const feedback = {
        correct: grading.score >= 70,
        message: grading.message,
        answer: grading.answer,
        provisional: grading.provisional,
        prompt: challenge.prompt,
      };
      const action = await tx.battleAction.create({
        data: {
          runId,
          roomId: room.id,
          clientActionId: input.clientActionId,
          phase: challenge.phase,
          skillId: skill?.id,
          challengeType: challenge.type,
          answer: json(input.answer),
          score: grading.score,
          grade,
          damageDealt,
          damageReceived,
          feedback: json(feedback),
          responseTimeMs: input.responseTimeMs,
        },
      });
      if (!grading.provisional) {
        const kind = evidenceKind(challenge.type);
        await tx.adventureLearningEvidence.create({
          data: {
            userId,
            targetId: challenge.targetId,
            runId,
            actionId: action.id,
            kind,
            score: grading.score,
            validRecall: grading.score >= 70 && kind !== AdventureEvidenceKind.RECOGNITION,
          },
        });
        await this.recordLearning(
          tx,
          userId,
          action.id,
          challenge,
          grading.score,
          input.answer,
          input.responseTimeMs,
        );
      }
      const roomRewards = roomReward(currentRoom.type);
      const roomData: Prisma.DungeonRoomUpdateInput = { enemyHp: nextEnemyHp, state: json(state) };
      const runData: Prisma.DungeonRunUpdateInput = {
        playerHp: nextHp,
        resource: { decrement: cost },
      };
      if (grade === AdventureHitGrade.PERFECT && challenge.phase === AdventureActionPhase.ATTACK)
        runData.resource = Math.min(
          5,
          current.resource - cost + Math.round(skillEffect.perfectResource ?? 0) + 1,
        );
      if (roomCleared) {
        roomData.status = AdventureRoomStatus.CLEARED;
        const nextRoom = current.rooms.find((item) => item.position === current.currentRoom + 1);
        runData.experienceEarned = { increment: roomRewards.experience };
        runData.goldEarned = { increment: roomRewards.gold };
        runData.materialsEarned = { increment: roomRewards.materials };
        if (dropsEquipment(currentRoom.type)) {
          const floor = await tx.dungeonFloor.findUniqueOrThrow({
            where: { id: current.floorId },
            select: { floorNumber: true },
          });
          const definition = equipmentDrop(
            floor.floorNumber,
            currentRoom.type,
            `${current.seed}:${currentRoom.position}`,
          );
          const secured = !current.securedItemId;
          const item = await tx.inventoryItem.create({
            data: {
              userId,
              definitionId: definition.id,
              acquiredRunId: current.id,
              stats: json(definition.baseStats),
              secured,
            },
          });
          if (secured) runData.securedItemId = item.id;
        }
        if (nextRoom) {
          runData.currentRoom = { increment: 1 };
          await tx.dungeonRoom.update({
            where: { id: nextRoom.id },
            data: { status: AdventureRoomStatus.ACTIVE },
          });
        } else runStatus = AdventureRunStatus.COMPLETED;
      } else if (runStatus === AdventureRunStatus.ACTIVE) {
        const targets = await tx.floorLearningTarget.findMany({
          where: { floorId: current.floorId },
          orderBy: { position: 'asc' },
          include: { bookWord: { include: { word: true } } },
        });
        roomData.challenge = json(
          buildChallenge(
            targets[(room.position + state.attackCount) % targets.length],
            targets,
            room.position + state.attackCount,
            nextPhase,
            current.seed,
            normalizePracticeFocus(snapshot.practiceFocus),
          ),
        );
      }
      runData.status = runStatus;
      if (runStatus !== AdventureRunStatus.ACTIVE) runData.completedAt = new Date();
      await tx.dungeonRoom.update({ where: { id: room.id }, data: roomData });
      const updatedRun = await tx.dungeonRun.update({ where: { id: runId }, data: runData });
      if (!grading.provisional)
        await this.updateDailyQuestProgress(tx, userId, current.floorId, grading.score);
      if (runStatus !== AdventureRunStatus.ACTIVE)
        await this.settleRun(tx, updatedRun, runStatus === AdventureRunStatus.COMPLETED, stats);
      return action;
    });
    const finalRun = await this.prisma.dungeonRun.findUniqueOrThrow({ where: { id: runId } });
    await this.refreshFloorProgress(
      userId,
      run.floorId,
      room.type === AdventureRoomType.BOSS && finalRun.status === AdventureRunStatus.COMPLETED,
      result.score,
    );
    return this.actionResponse(userId, result, false);
  }

  async retreat(userId: string, runId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtext(${`adventure-run:${runId}`}))`,
      );
      const run = await tx.dungeonRun.findFirst({
        where: { id: runId, userId },
        include: { rooms: true },
      });
      if (!run) throw new NotFoundException('探索不存在');
      if (run.status !== AdventureRunStatus.ACTIVE) return;
      const room = run.rooms.find((item) => item.position === run.currentRoom);
      if (!room || room.type !== AdventureRoomType.CAMP)
        throw new BadRequestException('只有抵达营地时才能安全撤退');
      const updated = await tx.dungeonRun.update({
        where: { id: runId },
        data: { status: AdventureRunStatus.RETREATED, completedAt: new Date() },
      });
      await this.settleRun(tx, updated, true, numericRecord(record(updated.snapshot).stats));
    });
    return this.serializeRun(runId, userId);
  }

  async inventory(userId: string) {
    await this.ensureCatalog();
    const items = await this.prisma.inventoryItem.findMany({
      where: { userId },
      include: { definition: true },
      orderBy: [{ equipped: 'desc' }, { createdAt: 'desc' }],
    });
    const serialized = items.map((item) => this.publicItem(item));
    return {
      items: serialized,
      equipped: Object.fromEntries(
        serialized.filter((item) => item.equipped).map((item) => [item.slot, item]),
      ),
    };
  }

  async equip(userId: string, itemId: string) {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id: itemId, userId },
      include: { definition: true },
    });
    if (!item) throw new NotFoundException('装备不存在');
    await this.prisma.$transaction([
      this.prisma.inventoryItem.updateMany({
        where: { userId, equipped: true, definition: { slot: item.definition.slot } },
        data: { equipped: false },
      }),
      this.prisma.inventoryItem.update({ where: { id: itemId }, data: { equipped: true } }),
    ]);
    return this.inventory(userId);
  }

  async dailyQuests(userId: string) {
    const date = localDate();
    let quests = await this.prisma.adventureDailyQuest.findMany({
      where: { userId, questDate: date },
      orderBy: { type: 'asc' },
    });
    if (!quests.length) {
      const dungeon = await this.dungeons(userId);
      const [explored, dueTarget, weakTarget] = await Promise.all([
        this.prisma.userFloorProgress.findMany({
          where: { userId, lastExploredAt: { not: null } },
          orderBy: { lastExploredAt: 'asc' },
          take: 2,
        }),
        this.prisma.floorLearningTarget.findFirst({
          where: {
            floor: { progresses: { some: { userId, lastExploredAt: { not: null } } } },
            bookWord: { progress: { some: { userId, nextReviewAt: { lte: new Date() } } } },
          },
          select: { floorId: true },
        }),
        this.prisma.floorLearningTarget.findFirst({
          where: {
            floor: { progresses: { some: { userId, lastExploredAt: { not: null } } } },
            bookWord: { weaknesses: { some: { userId, status: WeaknessStatus.ACTIVE } } },
          },
          select: { floorId: true },
        }),
      ]);
      const fallback = dungeon.floors[0];
      const dueFloorId = dueTarget?.floorId ?? explored[0]?.floorId ?? fallback?.id ?? null;
      const weakFloorId = weakTarget?.floorId ?? explored[1]?.floorId ?? dueFloorId;
      await this.prisma.adventureDailyQuest.createMany({
        data: [
          {
            userId,
            questDate: date,
            type: AdventureQuestType.DUE_REVIEW,
            floorId: dueFloorId,
            title: '回到旧地图',
            description: '在探索过的地牢完成 3 次有效回忆。',
            targetCount: 3,
            reward: json({ gold: 30, materials: 2 }),
          },
          {
            userId,
            questDate: date,
            type: AdventureQuestType.WEAKNESS,
            floorId: weakFloorId,
            title: '追猎遗忘怪',
            description: '在薄弱区域完成 2 次命中。',
            targetCount: 2,
            reward: json({ gold: 20, materials: 3 }),
          },
          {
            userId,
            questDate: date,
            type: AdventureQuestType.FREE_CHALLENGE,
            title: '自由远征',
            description: '在任意地牢完成 4 次命中。',
            targetCount: 4,
            reward: json({ gold: 40, materials: 2 }),
          },
        ],
        skipDuplicates: true,
      });
      quests = await this.prisma.adventureDailyQuest.findMany({
        where: { userId, questDate: date },
        orderBy: { type: 'asc' },
      });
    }
    return quests.map((quest) => ({
      ...quest,
      reward: record(quest.reward),
      claimable: quest.progress >= quest.targetCount && !quest.claimedAt,
    }));
  }

  async claimQuest(userId: string, questId: string) {
    const quest = await this.prisma.adventureDailyQuest.findFirst({
      where: { id: questId, userId },
    });
    if (!quest) throw new NotFoundException('每日任务不存在');
    if (quest.claimedAt) return this.dailyQuests(userId);
    if (quest.progress < quest.targetCount) throw new BadRequestException('任务尚未完成');
    const reward = numericRecord(quest.reward);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.adventureDailyQuest.updateMany({
        where: { id: questId, claimedAt: null, progress: { gte: quest.targetCount } },
        data: { claimedAt: new Date() },
      });
      if (claimed.count)
        await tx.adventureProfile.update({
          where: { userId },
          data: {
            gold: { increment: Math.round(reward.gold ?? 0) },
            materials: { increment: Math.round(reward.materials ?? 0) },
          },
        });
    });
    return this.dailyQuests(userId);
  }

  private async ensureCatalog() {
    for (const node of CLASS_NODES.sort((a, b) => a.tier - b.tier))
      await this.prisma.classNode.upsert({
        where: { id: node.id },
        create: node,
        update: { ...node },
      });
    for (const skill of SKILLS)
      await this.prisma.skillDefinition.upsert({
        where: { id: skill.id },
        create: { ...skill, effect: json(skill.effect) },
        update: { ...skill, effect: json(skill.effect) },
      });
    for (const item of EQUIPMENT)
      await this.prisma.equipmentDefinition.upsert({
        where: { id: item.id },
        create: { ...item, baseStats: json(item.baseStats) },
        update: { ...item, baseStats: json(item.baseStats) },
      });
  }

  private async ensureFloors(userId: string) {
    const selected = await this.defaultBook(userId);
    if (!selected) return;
    const existing = await this.prisma.dungeonFloor.count({
      where: { bookId: selected.book.id, version: 1 },
    });
    const expected = Math.ceil(selected.book.bookWords.length / 12);
    if (existing >= expected) return;
    await this.prisma.$transaction(async (tx) => {
      for (let index = 0; index < expected; index += 1) {
        const words = selected.book.bookWords.slice(index * 12, index * 12 + 12);
        const floor = await tx.dungeonFloor.upsert({
          where: {
            bookId_floorNumber_version: {
              bookId: selected.book.id,
              floorNumber: index + 1,
              version: 1,
            },
          },
          create: {
            bookId: selected.book.id,
            floorNumber: index + 1,
            title: `${FLOOR_TITLES[index % FLOOR_TITLES.length]} · ${index + 1}F`,
            cefrLevel: cefrFor(index),
            sentenceFrames: json(sentenceFrames(cefrFor(index))),
          },
          update: {},
        });
        await tx.floorLearningTarget.createMany({
          data: words.map((word, position) => ({
            floorId: floor.id,
            bookWordId: word.id,
            position,
          })),
          skipDuplicates: true,
        });
      }
    });
  }

  private defaultBook(userId: string) {
    return this.prisma.userVocabularyBook.findFirst({
      where: { userId, isDefault: true },
      include: {
        book: { include: { bookWords: { orderBy: { position: 'asc' }, include: { word: true } } } },
      },
    });
  }

  private async requireProfile(userId: string) {
    await this.ensureCatalog();
    return this.prisma.adventureProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  private async serializeProfile(profileId: string) {
    const profile = await this.prisma.adventureProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { currentClass: true, skills: true },
    });
    const nodes = await this.prisma.classNode.findMany({
      where: { isActive: true },
      orderBy: [{ tier: 'asc' }, { sortOrder: 'asc' }],
    });
    const lineage = profile.currentClassId ? await this.classLineage(profile.currentClassId) : [];
    const skills = await this.prisma.skillDefinition.findMany({
      where: { classNodeId: { in: lineage } },
      orderBy: [{ classNodeId: 'asc' }, { sortOrder: 'asc' }],
    });
    const unlocked = new Set(profile.skills.map((item) => item.skillId));
    return {
      id: profile.id,
      level: profile.level,
      experience: profile.experience,
      experienceToNextLevel: experienceToNextLevel(profile.level),
      gold: profile.gold,
      materials: profile.materials,
      skillPoints: profile.skillPoints,
      highestFloor: profile.highestFloor,
      soundEnabled: profile.soundEnabled,
      currentClass: profile.currentClass
        ? this.publicClass(profile.currentClass, true, true)
        : null,
      availableClasses: nodes.map((node) =>
        this.publicClass(
          node,
          !profile.currentClassId
            ? node.tier === 0
            : node.parentId === profile.currentClassId && profile.level >= node.requiredLevel,
          node.id === profile.currentClassId,
        ),
      ),
      skills: skills.map((skill) => ({
        id: skill.id,
        key: skill.key,
        name: skill.name,
        description: skill.description,
        target: skill.target,
        cost: skill.cost,
        requiredLevel: skill.requiredLevel,
        unlocked: unlocked.has(skill.id),
      })),
    };
  }

  private publicClass(
    node: {
      id: string;
      key: string;
      name: string;
      description: string;
      combatRole: string;
      tier: number;
      requiredLevel: number;
      parentId: string | null;
    },
    available: boolean,
    current: boolean,
  ) {
    return { ...node, available, current };
  }

  private async classLineage(classId: string) {
    const all = await this.prisma.classNode.findMany();
    const lineage: string[] = [];
    let current: string | null = classId;
    while (current) {
      lineage.push(current);
      current = all.find((node) => node.id === current)?.parentId ?? null;
    }
    return lineage;
  }

  private async availableSkill(userId: string, skillId: string) {
    const profile = await this.prisma.adventureProfile.findUnique({
      where: { userId },
      include: { skills: { where: { skillId }, include: { skill: true } } },
    });
    const skill = profile?.skills[0]?.skill ?? null;
    return skill && skill.sortOrder <= 4 ? skill : null;
  }

  private async equipmentStats(userId: string) {
    const [equipped, profile] = await Promise.all([
      this.prisma.inventoryItem.findMany({ where: { userId, equipped: true } }),
      this.prisma.adventureProfile.findUnique({
        where: { userId },
        include: { skills: { include: { skill: true } } },
      }),
    ]);
    const result: NumericStats = {};
    for (const item of equipped)
      for (const [key, value] of Object.entries(numericRecord(item.stats))) {
        const adjusted = key.includes('Multiplier')
          ? 1 + (value - 1) * Math.max(0.2, item.durability / 100)
          : value * Math.max(0.2, item.durability / 100);
        result[key] = key.includes('Multiplier')
          ? (result[key] ?? 1) * adjusted
          : (result[key] ?? 0) + adjusted;
      }
    for (const item of profile?.skills ?? [])
      if (item.skill.sortOrder > 4)
        for (const [key, value] of Object.entries(numericRecord(item.skill.effect)))
          result[key] = key.includes('Multiplier')
            ? (result[key] ?? 1) * value
            : (result[key] ?? 0) + value;
    return result;
  }

  private async grade(userId: string, challenge: StoredChallenge, answerValue: unknown[]) {
    const answer = answerValue
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean);
    if (challenge.type === AdventureChallengeType.FREE_RESPONSE) {
      const text = answer.join(' ').trim();
      if (text.length < 4)
        return {
          score: 0,
          message: '回答太短，没有形成可验证的句子。',
          answer: challenge.expected[0],
          provisional: false,
        };
      try {
        const prompt = `评估英语学习者的单句回答。只评估是否正确使用目标词、句子是否完整清楚，不评估发音。目标词：${challenge.word}\n任务：${challenge.prompt}\n回答：${text}\n只返回 JSON：{"score":0-100,"message":"一句中文反馈"}`;
        const raw = await this.ai.generateForUser(
          { purpose: 'adventure-free-response', prompt },
          userId,
        );
        const parsed = parseJson(String(raw));
        const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
        if (typeof parsed.message !== 'string')
          throw new BadGatewayException('自由表达评分结构无效');
        return {
          score,
          message: parsed.message,
          answer: challenge.expected[0],
          provisional: false,
        };
      } catch {
        return gradeProvisionalFreeResponse(text, challenge.word, challenge.expected[0]);
      }
    }
    const actual =
      challenge.type === AdventureChallengeType.SENTENCE_ORDER
        ? normalize(answer.join(' '))
        : normalize(answer[0] ?? '');
    const correct = challenge.expected.some((expected) => normalize(expected) === actual);
    return {
      score: correct ? 100 : 0,
      message: correct ? '表达命中，攻击生效。' : '这次没有命中，留意提示后再召回。',
      answer: challenge.expected[0],
      provisional: false,
    };
  }

  private async recordLearning(
    tx: Prisma.TransactionClient,
    userId: string,
    actionId: string,
    challenge: StoredChallenge,
    score: number,
    answer: unknown[],
    responseTimeMs?: number,
  ) {
    const target = await tx.floorLearningTarget.findUniqueOrThrow({
      where: { id: challenge.targetId },
    });
    await tx.userWordProgress.createMany({
      data: [{ userId, bookWordId: target.bookWordId }],
      skipDuplicates: true,
    });
    await lockUserWordProgress(tx, userId, [target.bookWordId]);
    const progress = await tx.userWordProgress.findUniqueOrThrow({
      where: { userId_bookWordId: { userId, bookWordId: target.bookWordId } },
    });
    const correct = score >= 70;
    await tx.userWordProgress.update({
      where: { id: progress.id },
      data: reviewSchedule(progress, correct),
    });
    await tx.wordReviewAttempt.create({
      data: {
        userId,
        bookWordId: target.bookWordId,
        adventureActionId: actionId,
        isCorrect: correct,
        questionType: `ADVENTURE_${challenge.type}`,
        selectedAnswer: json(answer),
        responseTimeMs,
      },
    });
    await this.mistakes.recordAttempt(tx, {
      userId,
      bookWordId: target.bookWordId,
      questionType: `ADVENTURE_${challenge.type}`,
      isCorrect: correct,
    });
    await tx.learningEvent.create({
      data: {
        userId,
        type: 'ADVENTURE_BATTLE_ACTION',
        payload: json({ challengeType: challenge.type, score, responseTimeMs }),
      },
    });
  }

  private async updateDailyQuestProgress(
    tx: Prisma.TransactionClient,
    userId: string,
    floorId: string,
    score: number,
  ) {
    if (score < 70) return;
    const date = localDate();
    await tx.adventureDailyQuest.updateMany({
      where: { userId, questDate: date, claimedAt: null, OR: [{ floorId }, { floorId: null }] },
      data: { progress: { increment: 1 } },
    });
  }

  private async settleRun(
    tx: Prisma.TransactionClient,
    run: {
      id: string;
      userId: string;
      floorId: string;
      experienceEarned: number;
      goldEarned: number;
      materialsEarned: number;
    },
    success: boolean,
    stats: NumericStats,
  ) {
    const experience = success ? run.experienceEarned : Math.floor(run.experienceEarned * 0.3);
    const gold = Math.floor(run.goldEarned * (success ? 1 + (stats.goldBonus ?? 0) : 0.5));
    const materials = Math.floor(
      run.materialsEarned * (success ? 1 + (stats.materialBonus ?? 0) : 0.5),
    );
    const profile = await tx.adventureProfile.findUniqueOrThrow({ where: { userId: run.userId } });
    const nextExperience = profile.experience + experience;
    const level = experienceLevel(nextExperience);
    await tx.adventureProfile.update({
      where: { id: profile.id },
      data: {
        experience: nextExperience,
        level,
        skillPoints: level > profile.level ? { increment: level - profile.level } : undefined,
        gold: { increment: gold },
        materials: { increment: materials },
      },
    });
    if (!success) {
      const equipped = await tx.inventoryItem.findMany({
        where: { userId: run.userId, equipped: true },
        select: { id: true, durability: true },
      });
      for (const item of equipped)
        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { durability: Math.max(20, item.durability - 5) },
        });
      await tx.inventoryItem.deleteMany({ where: { acquiredRunId: run.id, secured: false } });
      return;
    }
    const floor = await tx.dungeonFloor.findUniqueOrThrow({ where: { id: run.floorId } });
    await tx.adventureProfile.update({
      where: { id: profile.id },
      data: { highestFloor: Math.max(profile.highestFloor, floor.floorNumber) },
    });
  }

  private async refreshFloorProgress(
    userId: string,
    floorId: string,
    completed = false,
    score = 0,
  ) {
    const [targets, evidence, existing] = await Promise.all([
      this.prisma.floorLearningTarget.count({ where: { floorId } }),
      this.prisma.$queryRaw<
        Array<{
          targetId: string;
          runId: string;
          score: number;
          kind: AdventureEvidenceKind;
          validRecall: boolean;
          provisional: boolean;
        }>
      >(Prisma.sql`
        SELECT evidence."targetId", evidence."runId", evidence."score", evidence."kind",
          evidence."validRecall",
          COALESCE((action."feedback" ->> 'provisional')::boolean, false) AS "provisional"
        FROM "AdventureLearningEvidence" AS evidence
        JOIN "FloorLearningTarget" AS target ON target."id" = evidence."targetId"
        JOIN "BattleAction" AS action ON action."id" = evidence."actionId"
        WHERE evidence."userId" = ${userId} AND target."floorId" = ${floorId}
      `),
      this.prisma.userFloorProgress.findUnique({ where: { userId_floorId: { userId, floorId } } }),
    ]);
    const values = aggregateMastery(evidence, targets);
    await this.prisma.userFloorProgress.upsert({
      where: { userId_floorId: { userId, floorId } },
      create: {
        userId,
        floorId,
        ...values,
        completedAt: completed ? new Date() : null,
        bestScore: score,
        lastExploredAt: new Date(),
      },
      update: {
        ...values,
        ...(completed ? { completedAt: new Date() } : {}),
        bestScore: Math.max(score, existing?.bestScore ?? 0),
        lastExploredAt: new Date(),
      },
    });
  }

  private async verifiedFloorProgress(userId: string, bookId: string) {
    return this.prisma.$queryRaw<
      Array<{ floorId: string; exploration: number; mastery: number; bossUnlocked: boolean }>
    >(Prisma.sql`
      WITH per_target AS (
        SELECT target."floorId", target."id",
          COUNT(DISTINCT evidence."runId") FILTER (
            WHERE evidence."score" >= 70
              AND NOT COALESCE((action."feedback" ->> 'provisional')::boolean, false)
          ) AS "successfulRuns",
          BOOL_OR(evidence."id" IS NOT NULL) AS "explored",
          BOOL_OR(COALESCE(
            evidence."score" >= 70
              AND evidence."validRecall"
              AND evidence."kind" <> 'RECOGNITION'
              AND NOT COALESCE((action."feedback" ->> 'provisional')::boolean, false),
            false
          )) AS "hasRecall"
        FROM "FloorLearningTarget" AS target
        JOIN "DungeonFloor" AS floor ON floor."id" = target."floorId"
        LEFT JOIN "AdventureLearningEvidence" AS evidence
          ON evidence."targetId" = target."id" AND evidence."userId" = ${userId}
        LEFT JOIN "BattleAction" AS action ON action."id" = evidence."actionId"
        WHERE floor."bookId" = ${bookId} AND floor."isActive" = true
        GROUP BY target."floorId", target."id"
      ), floor_totals AS (
        SELECT "floorId",
          ROUND(COUNT(*) FILTER (WHERE "explored") * 100.0 / COUNT(*))::int AS "exploration",
          ROUND(COUNT(*) FILTER (WHERE "successfulRuns" >= 2 AND "hasRecall") * 100.0 / COUNT(*))::int AS "mastery"
        FROM per_target
        GROUP BY "floorId"
      )
      SELECT "floorId", "exploration", "mastery",
        ("exploration" >= 80 AND "mastery" >= 70) AS "bossUnlocked"
      FROM floor_totals
    `);
  }

  private async actionResponse(
    userId: string,
    action: {
      score: number;
      grade: AdventureHitGrade;
      damageDealt: number;
      damageReceived: number;
      feedback: Prisma.JsonValue;
      runId: string;
    },
    repeated: boolean,
  ) {
    return {
      repeated,
      score: action.score,
      grade: action.grade,
      damageDealt: action.damageDealt,
      damageReceived: action.damageReceived,
      feedback: record(action.feedback),
      run: await this.serializeRun(action.runId, userId),
    };
  }

  private async serializeRun(runId: string, userId: string) {
    const run = await this.prisma.dungeonRun.findFirst({
      where: { id: runId, userId },
      include: {
        rooms: { orderBy: { position: 'asc' } },
        actions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
        acquiredItems: { include: { definition: true }, orderBy: { createdAt: 'asc' } },
        floor: {
          include: { _count: { select: { targets: true } }, progresses: { where: { userId } } },
        },
      },
    });
    if (!run) throw new NotFoundException('探索不存在');
    const current = run.rooms.find((item) => item.position === run.currentRoom);
    const profile = await this.prisma.adventureProfile.findUniqueOrThrow({
      where: { userId },
      include: { skills: { include: { skill: true } } },
    });
    return {
      id: run.id,
      status: run.status,
      durationMinutes: run.durationMinutes,
      practiceFocus: normalizePracticeFocus(record(run.snapshot).practiceFocus),
      currentRoom: run.currentRoom,
      roomCount: run.roomCount,
      playerHp: run.playerHp,
      playerMaxHp: run.playerMaxHp,
      resource: run.resource,
      experienceEarned: run.experienceEarned,
      goldEarned: run.goldEarned,
      materialsEarned: run.materialsEarned,
      floor: this.floorSummary(run.floor, run.floor.progresses[0], false),
      rooms: run.rooms.map((room) => ({
        id: room.id,
        position: room.position,
        type: room.type,
        status: room.status,
        enemyName: room.enemyName,
        enemyHp: room.enemyHp,
        enemyMaxHp: room.enemyMaxHp,
      })),
      loot: run.acquiredItems.map((item) => this.publicItem(item)),
      challenge:
        current && run.status === AdventureRunStatus.ACTIVE
          ? publicChallenge(asChallenge(current.challenge))
          : null,
      lastAction: run.actions[0]
        ? (() => {
            const action = run.actions[0];
            const savedFeedback = record(action.feedback);
            const savedAnswer = record(action.answer);
            const feedbackAnswer = savedFeedback.answer;
            return {
              challengeType: action.challengeType,
              phase: action.phase,
              prompt: typeof savedFeedback.prompt === 'string' ? savedFeedback.prompt : null,
              answer: Array.isArray(action.answer)
                ? action.answer.filter((item): item is string => typeof item === 'string')
                : typeof savedAnswer.answer === 'string'
                  ? [savedAnswer.answer]
                  : [],
              score: action.score,
              grade: action.grade,
              damageDealt: action.damageDealt,
              damageReceived: action.damageReceived,
              feedback: {
                correct: savedFeedback.correct === true,
                message:
                  typeof savedFeedback.message === 'string'
                    ? savedFeedback.message
                    : '本题已保存。',
                ...(typeof feedbackAnswer === 'string' ? { answer: feedbackAnswer } : {}),
                ...(typeof savedFeedback.provisional === 'boolean'
                  ? { provisional: savedFeedback.provisional }
                  : {}),
              },
            };
          })()
        : null,
      availableSkills: profile.skills
        .filter((item) => item.skill.sortOrder <= 4)
        .map((item) => ({
          id: item.skill.id,
          key: item.skill.key,
          name: item.skill.name,
          description: item.skill.description,
          target: item.skill.target,
          cost: item.skill.cost,
          requiredLevel: item.skill.requiredLevel,
          unlocked: true,
        })),
      canRetreat:
        run.status === AdventureRunStatus.ACTIVE && current?.type === AdventureRoomType.CAMP,
    };
  }

  private floorSummary(
    floor: {
      id: string;
      floorNumber: number;
      title: string;
      cefrLevel: CefrLevel;
      _count: { targets: number };
    },
    progress:
      | {
          exploration: number;
          mastery: number;
          bossUnlocked: boolean;
          completedAt: Date | null;
          bestScore: number;
        }
      | undefined,
    locked: boolean,
  ) {
    return {
      id: floor.id,
      floorNumber: floor.floorNumber,
      title: floor.title,
      cefrLevel: floor.cefrLevel,
      targetCount: floor._count.targets,
      exploration: progress?.exploration ?? 0,
      mastery: progress?.mastery ?? 0,
      bossUnlocked: progress?.bossUnlocked ?? false,
      completed: Boolean(progress?.completedAt),
      locked,
    };
  }

  private publicItem(item: {
    id: string;
    stats: Prisma.JsonValue;
    durability: number;
    equipped: boolean;
    secured: boolean;
    definition: { name: string; description: string; slot: EquipmentSlot; rarity: string };
  }) {
    return {
      id: item.id,
      name: item.definition.name,
      description: item.definition.description,
      slot: item.definition.slot,
      rarity: item.definition.rarity,
      stats: numericRecord(item.stats),
      durability: Math.max(0, item.durability),
      equipped: item.equipped,
      secured: item.secured,
    };
  }
}

function routeFor(minutes: 5 | 10 | 15, boss: boolean) {
  const finish = boss ? AdventureRoomType.BOSS : AdventureRoomType.TREASURE;
  if (minutes === 5) return [AdventureRoomType.COMBAT, AdventureRoomType.ELITE, finish];
  if (minutes === 10)
    return [
      AdventureRoomType.COMBAT,
      AdventureRoomType.EVENT,
      AdventureRoomType.ELITE,
      AdventureRoomType.CAMP,
      AdventureRoomType.COMBAT,
      finish,
    ];
  return [
    AdventureRoomType.COMBAT,
    AdventureRoomType.EVENT,
    AdventureRoomType.COMBAT,
    AdventureRoomType.TREASURE,
    AdventureRoomType.ELITE,
    AdventureRoomType.CAMP,
    AdventureRoomType.COMBAT,
    AdventureRoomType.ELITE,
    finish,
  ];
}

function enemyHp(type: AdventureRoomType) {
  return type === AdventureRoomType.BOSS
    ? 180
    : type === AdventureRoomType.ELITE
      ? 62
      : type === AdventureRoomType.CAMP
        ? 28
        : 34;
}
function enemyName(type: AdventureRoomType, seed: string, index: number) {
  if (type === AdventureRoomType.BOSS) return '遗忘领主';
  if (type === AdventureRoomType.CAMP) return '营火守题人';
  if (type === AdventureRoomType.TREASURE) return '墨锁宝箱';
  return ENEMIES[(seedNumber(seed) + index) % ENEMIES.length];
}
function roomReward(type: AdventureRoomType) {
  const factor = type === AdventureRoomType.BOSS ? 5 : type === AdventureRoomType.ELITE ? 2 : 1;
  return {
    experience: 18 * factor,
    gold: 8 * factor,
    materials: type === AdventureRoomType.BOSS || type === AdventureRoomType.ELITE ? factor : 0,
  };
}
function dropsEquipment(type: AdventureRoomType) {
  return (
    type === AdventureRoomType.ELITE ||
    type === AdventureRoomType.TREASURE ||
    type === AdventureRoomType.BOSS
  );
}
function equipmentDrop(floorNumber: number, roomType: AdventureRoomType, seed: string) {
  const rarityRank = { COMMON: 0, RARE: 1, EPIC: 2, LEGENDARY: 3 } as const;
  const roomRank =
    roomType === AdventureRoomType.BOSS ? 3 : roomType === AdventureRoomType.TREASURE ? 2 : 1;
  const eligible = EQUIPMENT.filter(
    (item) => item.minFloor <= floorNumber && rarityRank[item.rarity] <= roomRank,
  );
  return eligible[seedNumber(seed) % eligible.length] ?? EQUIPMENT[0];
}
function cefrFor(index: number): CefrLevel {
  return [CefrLevel.A1, CefrLevel.A2, CefrLevel.B1, CefrLevel.B2, CefrLevel.C1][
    Math.min(4, Math.floor(index / 10))
  ];
}
function sentenceFrames(level: CefrLevel) {
  return level === CefrLevel.A1
    ? ['I use ___ every day.', 'This is a ___.']
    : level === CefrLevel.A2
      ? ['I chose ___ because ___.', 'Could you help me with ___?']
      : ['Although ___, I would rather ___.', 'The reason I mentioned ___ is that ___.'];
}

function buildChallenge(
  target: {
    id: string;
    bookWord: {
      contextMeaning: string | null;
      sourceExample: string | null;
      word: { text: string; meaning: string | null };
    };
  },
  all: Array<{
    id: string;
    bookWord: {
      contextMeaning: string | null;
      sourceExample: string | null;
      word: { text: string; meaning: string | null };
    };
  }>,
  ordinal: number,
  phase: AdventureActionPhase,
  seed: string,
  focus: AdventurePracticeFocus,
): StoredChallenge {
  const type = challengeTypeForFocus(focus, ordinal, phase);
  const word = target.bookWord.word.text;
  const meaning =
    target.bookWord.contextMeaning || stripPart(target.bookWord.word.meaning) || '暂无释义';
  const example = target.bookWord.sourceExample || `I can use ${word} in a sentence.`;
  const base = {
    id: createHash('sha1')
      .update(`${seed}:${target.id}:${ordinal}:${phase}`)
      .digest('hex')
      .slice(0, 16),
    type,
    phase,
    targetId: target.id,
    word,
    meaning,
    expected: [type === AdventureChallengeType.SENTENCE_ORDER ? example : word],
  };
  if (type === AdventureChallengeType.CHOICE || type === AdventureChallengeType.MATCHING) {
    const distractors = all
      .filter((item) => item.id !== target.id)
      .map((item) => item.bookWord.word.text)
      .slice(0, 3);
    return {
      ...base,
      prompt:
        phase === AdventureActionPhase.BLOCK
          ? `格挡：选择“${meaning}”对应的英文`
          : `选择“${meaning}”对应的英文`,
      options: seededShuffle([word, ...distractors], seed + ordinal),
      hint: '选择只能提供识别证据，之后还需要主动召回。',
    };
  }
  if (type === AdventureChallengeType.SPELLING)
    return {
      ...base,
      prompt: `${phase === AdventureActionPhase.BLOCK ? '格挡并拼写' : '请拼写'}：${meaning}`,
      hint: `${word.length} 个字母`,
      inputPlaceholder: '输入英文单词',
    };
  if (type === AdventureChallengeType.SENTENCE_ORDER)
    return {
      ...base,
      prompt: '把词块排列成完整句子',
      tokens: seededShuffle(example.split(/\s+/), seed + ordinal),
      hint: `句子中包含 ${word}`,
    };
  return {
    ...base,
    prompt: `用 “${word}” 写一个至少 4 个词的完整英文句子`,
    expected: [`I use ${word} in a clear sentence.`],
    hint: meaning,
    inputPlaceholder: '输入你的英文句子',
  };
}

function asChallenge(value: Prisma.JsonValue | null): StoredChallenge {
  const item = value as unknown as StoredChallenge;
  if (!item?.id || !item.expected?.length) throw new BadGatewayException('战斗题目数据无效');
  return item;
}
function publicChallenge({
  expected: _expected,
  targetId: _targetId,
  word: _word,
  meaning: _meaning,
  ...challenge
}: StoredChallenge) {
  return challenge;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function numericRecord(value: unknown): NumericStats {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}
function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}
function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function stripPart(value: string | null) {
  return (value ?? '').replace(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i, '');
}
function parseJson(value: string) {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new BadGatewayException('模型没有返回 JSON');
  return JSON.parse(match[0]) as Record<string, unknown>;
}
function seedNumber(value: string) {
  return [...value].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
}
function seededShuffle<T>(values: T[], seed: string) {
  const result = [...values];
  let state = seedNumber(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function localDate() {
  const value = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${value}T00:00:00.000Z`);
}
