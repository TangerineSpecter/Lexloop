-- CreateEnum
CREATE TYPE "AdventureRunStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'FAILED', 'RETREATED');

-- CreateEnum
CREATE TYPE "AdventureRoomType" AS ENUM ('COMBAT', 'ELITE', 'EVENT', 'CAMP', 'TREASURE', 'BOSS');

-- CreateEnum
CREATE TYPE "AdventureRoomStatus" AS ENUM ('PENDING', 'ACTIVE', 'CLEARED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AdventureChallengeType" AS ENUM ('CHOICE', 'SPELLING', 'SENTENCE_ORDER', 'MATCHING', 'FREE_RESPONSE');

-- CreateEnum
CREATE TYPE "AdventureActionPhase" AS ENUM ('ATTACK', 'BLOCK');

-- CreateEnum
CREATE TYPE "AdventureHitGrade" AS ENUM ('PERFECT', 'HIT', 'GRAZE', 'MISS');

-- CreateEnum
CREATE TYPE "AdventureEvidenceKind" AS ENUM ('RECOGNITION', 'RECALL', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "EquipmentSlot" AS ENUM ('WEAPON', 'ARMOR', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "EquipmentRarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY');

-- CreateEnum
CREATE TYPE "SkillTarget" AS ENUM ('SELF', 'ENEMY', 'ALLY', 'PARTY');

-- CreateEnum
CREATE TYPE "AdventureQuestType" AS ENUM ('DUE_REVIEW', 'WEAKNESS', 'FREE_CHALLENGE');

-- CreateTable
CREATE TABLE "AdventureProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentClassId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "experience" INTEGER NOT NULL DEFAULT 0,
    "gold" INTEGER NOT NULL DEFAULT 0,
    "materials" INTEGER NOT NULL DEFAULT 0,
    "skillPoints" INTEGER NOT NULL DEFAULT 1,
    "highestFloor" INTEGER NOT NULL DEFAULT 0,
    "soundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdventureProfile_pkey" PRIMARY KEY ("id")
);

-- RPG answers share the existing review-attempt analytics without requiring a study-plan item.
ALTER TABLE "WordReviewAttempt" ALTER COLUMN "planItemId" DROP NOT NULL;
ALTER TABLE "WordReviewAttempt" ADD COLUMN "adventureActionId" TEXT;

-- CreateTable
CREATE TABLE "ClassNode" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "combatRole" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "requiredLevel" INTEGER NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ClassNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "classNodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "target" "SkillTarget" NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "requiredLevel" INTEGER NOT NULL DEFAULT 1,
    "requiredSkillId" TEXT,
    "effect" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SkillDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSkill" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 1,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DungeonFloor" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "floorNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "cefrLevel" "CefrLevel" NOT NULL,
    "sentenceFrames" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DungeonFloor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorLearningTarget" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "bookWordId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "FloorLearningTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFloorProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "exploration" INTEGER NOT NULL DEFAULT 0,
    "mastery" INTEGER NOT NULL DEFAULT 0,
    "bossUnlocked" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "bestScore" INTEGER NOT NULL DEFAULT 0,
    "lastExploredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFloorProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DungeonRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "status" "AdventureRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "durationMinutes" INTEGER NOT NULL,
    "seed" TEXT NOT NULL,
    "roomCount" INTEGER NOT NULL,
    "currentRoom" INTEGER NOT NULL DEFAULT 0,
    "playerHp" INTEGER NOT NULL DEFAULT 100,
    "playerMaxHp" INTEGER NOT NULL DEFAULT 100,
    "resource" INTEGER NOT NULL DEFAULT 3,
    "experienceEarned" INTEGER NOT NULL DEFAULT 0,
    "goldEarned" INTEGER NOT NULL DEFAULT 0,
    "materialsEarned" INTEGER NOT NULL DEFAULT 0,
    "securedItemId" TEXT,
    "snapshot" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DungeonRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DungeonRoom" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "AdventureRoomType" NOT NULL,
    "status" "AdventureRoomStatus" NOT NULL DEFAULT 'PENDING',
    "enemyName" TEXT,
    "enemyHp" INTEGER,
    "enemyMaxHp" INTEGER,
    "challenge" JSONB,
    "reward" JSONB,
    "state" JSONB,

    CONSTRAINT "DungeonRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BattleAction" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "clientActionId" TEXT NOT NULL,
    "phase" "AdventureActionPhase" NOT NULL,
    "skillId" TEXT,
    "challengeType" "AdventureChallengeType" NOT NULL,
    "answer" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" "AdventureHitGrade" NOT NULL,
    "damageDealt" INTEGER NOT NULL DEFAULT 0,
    "damageReceived" INTEGER NOT NULL DEFAULT 0,
    "feedback" JSONB NOT NULL,
    "responseTimeMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BattleAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdventureLearningEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "kind" "AdventureEvidenceKind" NOT NULL,
    "score" INTEGER NOT NULL,
    "validRecall" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdventureLearningEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "slot" "EquipmentSlot" NOT NULL,
    "rarity" "EquipmentRarity" NOT NULL,
    "minFloor" INTEGER NOT NULL DEFAULT 1,
    "baseStats" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "EquipmentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "acquiredRunId" TEXT,
    "stats" JSONB NOT NULL,
    "durability" INTEGER NOT NULL DEFAULT 100,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "secured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdventureDailyQuest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questDate" DATE NOT NULL,
    "type" "AdventureQuestType" NOT NULL,
    "floorId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "reward" JSONB NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdventureDailyQuest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdventureProfile_userId_key" ON "AdventureProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WordReviewAttempt_adventureActionId_key" ON "WordReviewAttempt"("adventureActionId");

-- CreateIndex
CREATE INDEX "AdventureProfile_currentClassId_idx" ON "AdventureProfile"("currentClassId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassNode_key_key" ON "ClassNode"("key");

-- CreateIndex
CREATE INDEX "ClassNode_parentId_tier_sortOrder_idx" ON "ClassNode"("parentId", "tier", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SkillDefinition_key_key" ON "SkillDefinition"("key");

-- CreateIndex
CREATE INDEX "SkillDefinition_classNodeId_requiredLevel_sortOrder_idx" ON "SkillDefinition"("classNodeId", "requiredLevel", "sortOrder");

-- CreateIndex
CREATE INDEX "UserSkill_skillId_idx" ON "UserSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSkill_profileId_skillId_key" ON "UserSkill"("profileId", "skillId");

-- CreateIndex
CREATE INDEX "DungeonFloor_bookId_isActive_floorNumber_idx" ON "DungeonFloor"("bookId", "isActive", "floorNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DungeonFloor_bookId_floorNumber_version_key" ON "DungeonFloor"("bookId", "floorNumber", "version");

-- CreateIndex
CREATE INDEX "FloorLearningTarget_bookWordId_idx" ON "FloorLearningTarget"("bookWordId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorLearningTarget_floorId_bookWordId_key" ON "FloorLearningTarget"("floorId", "bookWordId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorLearningTarget_floorId_position_key" ON "FloorLearningTarget"("floorId", "position");

-- CreateIndex
CREATE INDEX "UserFloorProgress_userId_completedAt_lastExploredAt_idx" ON "UserFloorProgress"("userId", "completedAt", "lastExploredAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserFloorProgress_userId_floorId_key" ON "UserFloorProgress"("userId", "floorId");

-- CreateIndex
CREATE INDEX "DungeonRun_userId_status_startedAt_idx" ON "DungeonRun"("userId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "DungeonRun_floorId_completedAt_idx" ON "DungeonRun"("floorId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DungeonRoom_runId_position_key" ON "DungeonRoom"("runId", "position");

-- CreateIndex
CREATE INDEX "BattleAction_roomId_createdAt_idx" ON "BattleAction"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BattleAction_runId_clientActionId_key" ON "BattleAction"("runId", "clientActionId");

-- CreateIndex
CREATE INDEX "AdventureLearningEvidence_userId_targetId_createdAt_idx" ON "AdventureLearningEvidence"("userId", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdventureLearningEvidence_actionId_targetId_key" ON "AdventureLearningEvidence"("actionId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentDefinition_key_key" ON "EquipmentDefinition"("key");

-- CreateIndex
CREATE INDEX "EquipmentDefinition_slot_rarity_minFloor_idx" ON "EquipmentDefinition"("slot", "rarity", "minFloor");

-- CreateIndex
CREATE INDEX "InventoryItem_userId_equipped_createdAt_idx" ON "InventoryItem"("userId", "equipped", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryItem_acquiredRunId_idx" ON "InventoryItem"("acquiredRunId");

-- CreateIndex
CREATE INDEX "AdventureDailyQuest_userId_questDate_claimedAt_idx" ON "AdventureDailyQuest"("userId", "questDate", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdventureDailyQuest_userId_questDate_type_key" ON "AdventureDailyQuest"("userId", "questDate", "type");

-- AddForeignKey
ALTER TABLE "AdventureProfile" ADD CONSTRAINT "AdventureProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureProfile" ADD CONSTRAINT "AdventureProfile_currentClassId_fkey" FOREIGN KEY ("currentClassId") REFERENCES "ClassNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassNode" ADD CONSTRAINT "ClassNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ClassNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_classNodeId_fkey" FOREIGN KEY ("classNodeId") REFERENCES "ClassNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillDefinition" ADD CONSTRAINT "SkillDefinition_requiredSkillId_fkey" FOREIGN KEY ("requiredSkillId") REFERENCES "SkillDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AdventureProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSkill" ADD CONSTRAINT "UserSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "SkillDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DungeonFloor" ADD CONSTRAINT "DungeonFloor_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "VocabularyBook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLearningTarget" ADD CONSTRAINT "FloorLearningTarget_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "DungeonFloor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLearningTarget" ADD CONSTRAINT "FloorLearningTarget_bookWordId_fkey" FOREIGN KEY ("bookWordId") REFERENCES "VocabularyBookWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFloorProgress" ADD CONSTRAINT "UserFloorProgress_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "DungeonFloor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFloorProgress" ADD CONSTRAINT "UserFloorProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DungeonRun" ADD CONSTRAINT "DungeonRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DungeonRun" ADD CONSTRAINT "DungeonRun_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "DungeonFloor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DungeonRoom" ADD CONSTRAINT "DungeonRoom_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DungeonRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattleAction" ADD CONSTRAINT "BattleAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DungeonRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattleAction" ADD CONSTRAINT "BattleAction_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "DungeonRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureLearningEvidence" ADD CONSTRAINT "AdventureLearningEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureLearningEvidence" ADD CONSTRAINT "AdventureLearningEvidence_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "FloorLearningTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureLearningEvidence" ADD CONSTRAINT "AdventureLearningEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DungeonRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureLearningEvidence" ADD CONSTRAINT "AdventureLearningEvidence_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "BattleAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WordReviewAttempt" ADD CONSTRAINT "WordReviewAttempt_adventureActionId_fkey" FOREIGN KEY ("adventureActionId") REFERENCES "BattleAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "EquipmentDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_acquiredRunId_fkey" FOREIGN KEY ("acquiredRunId") REFERENCES "DungeonRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureDailyQuest" ADD CONSTRAINT "AdventureDailyQuest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdventureDailyQuest" ADD CONSTRAINT "AdventureDailyQuest_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "DungeonFloor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
