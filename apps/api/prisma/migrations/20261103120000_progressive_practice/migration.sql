CREATE TYPE "ProgressivePracticeStage" AS ENUM ('FOUNDATION', 'CONTEXT', 'TRANSFER');

ALTER TYPE "StudyPlanPurpose" ADD VALUE 'PROGRESSIVE';

ALTER TABLE "StudyPlan"
  ADD COLUMN "progressiveStage" "ProgressivePracticeStage",
  ADD COLUMN "progressiveVersion" INTEGER;

CREATE INDEX "StudyPlan_userId_purpose_progressiveVersion_progressiveStage_status_idx"
  ON "StudyPlan"("userId", "purpose", "progressiveVersion", "progressiveStage", "status");

CREATE TABLE "ProgressivePracticeProgress" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "trackVersion" INTEGER NOT NULL DEFAULT 1,
  "highestUnlockedStage" "ProgressivePracticeStage" NOT NULL DEFAULT 'FOUNDATION',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProgressivePracticeProgress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgressivePracticeProgress_userId_trackVersion_key"
  ON "ProgressivePracticeProgress"("userId", "trackVersion");
CREATE INDEX "ProgressivePracticeProgress_userId_highestUnlockedStage_idx"
  ON "ProgressivePracticeProgress"("userId", "highestUnlockedStage");

ALTER TABLE "ProgressivePracticeProgress"
  ADD CONSTRAINT "ProgressivePracticeProgress_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
