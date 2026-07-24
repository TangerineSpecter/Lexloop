CREATE TYPE "StudyPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED');
CREATE TYPE "StudyPlanItemSource" AS ENUM ('NEW', 'REVIEW');

ALTER TABLE "UserWordProgress" ADD COLUMN "totalAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserWordProgress" ADD COLUMN "correctAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserWordProgress" ADD COLUMN "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserWordProgress" ADD COLUMN "lastIntervalDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserWordProgress" ADD COLUMN "postponedCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "StudyPlan" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "status" "StudyPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StudyPlan_userId_status_createdAt_idx" ON "StudyPlan"("userId", "status", "createdAt");
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StudyPlanItem" (
  "id" TEXT NOT NULL, "planId" TEXT NOT NULL, "bookWordId" TEXT NOT NULL, "source" "StudyPlanItemSource" NOT NULL, "groupIndex" INTEGER NOT NULL, "completedAt" TIMESTAMP(3),
  CONSTRAINT "StudyPlanItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudyPlanItem_planId_bookWordId_key" ON "StudyPlanItem"("planId", "bookWordId");
CREATE INDEX "StudyPlanItem_planId_groupIndex_idx" ON "StudyPlanItem"("planId", "groupIndex");
ALTER TABLE "StudyPlanItem" ADD CONSTRAINT "StudyPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudyPlanItem" ADD CONSTRAINT "StudyPlanItem_bookWordId_fkey" FOREIGN KEY ("bookWordId") REFERENCES "VocabularyBookWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WordReviewAttempt" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "bookWordId" TEXT NOT NULL, "planItemId" TEXT NOT NULL, "isCorrect" BOOLEAN NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WordReviewAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WordReviewAttempt_userId_bookWordId_createdAt_idx" ON "WordReviewAttempt"("userId", "bookWordId", "createdAt");
CREATE INDEX "WordReviewAttempt_planItemId_idx" ON "WordReviewAttempt"("planItemId");
ALTER TABLE "WordReviewAttempt" ADD CONSTRAINT "WordReviewAttempt_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "StudyPlanItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
