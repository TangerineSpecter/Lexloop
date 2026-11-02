CREATE TYPE "AutomaticStudyPlanRunStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'GENERATED',
  'SKIPPED',
  'FAILED'
);

ALTER TABLE "SystemFeatureSetting"
ADD COLUMN "scheduleTime" TEXT;

ALTER TABLE "StudyPlan"
ADD COLUMN "autoDateKey" TEXT;

CREATE UNIQUE INDEX "StudyPlan_userId_autoDateKey_key"
ON "StudyPlan"("userId", "autoDateKey");

CREATE TABLE "AutomaticStudyPlanRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dateKey" TEXT NOT NULL,
  "status" "AutomaticStudyPlanRunStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "planId" TEXT,
  "reasonCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomaticStudyPlanRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomaticStudyPlanRun_userId_dateKey_key"
ON "AutomaticStudyPlanRun"("userId", "dateKey");

CREATE UNIQUE INDEX "AutomaticStudyPlanRun_planId_key"
ON "AutomaticStudyPlanRun"("planId");

CREATE INDEX "AutomaticStudyPlanRun_dateKey_status_nextAttemptAt_idx"
ON "AutomaticStudyPlanRun"("dateKey", "status", "nextAttemptAt");

ALTER TABLE "AutomaticStudyPlanRun"
ADD CONSTRAINT "AutomaticStudyPlanRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomaticStudyPlanRun"
ADD CONSTRAINT "AutomaticStudyPlanRun_planId_fkey"
FOREIGN KEY ("planId") REFERENCES "StudyPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
