CREATE TYPE "StudyPlanPurpose" AS ENUM ('NORMAL', 'WEAKNESS');
CREATE TYPE "WeaknessStatus" AS ENUM ('ACTIVE', 'IGNORED', 'RESOLVED');
CREATE TYPE "TutorContextType" AS ENUM ('STUDY_GROUP', 'MISTAKE');
CREATE TYPE "TutorMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "TutorMessageStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

ALTER TABLE "StudyPlan" ADD COLUMN "purpose" "StudyPlanPurpose" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "StudyPlanItem" ADD COLUMN "targetQuestionType" TEXT;
DROP INDEX IF EXISTS "StudyPlan_userId_status_createdAt_idx";
CREATE INDEX "StudyPlan_userId_purpose_status_createdAt_idx" ON "StudyPlan"("userId", "purpose", "status", "createdAt");

CREATE TABLE "WeaknessSignal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bookWordId" TEXT NOT NULL,
  "questionType" TEXT NOT NULL,
  "status" "WeaknessStatus" NOT NULL DEFAULT 'ACTIVE',
  "wrongCount" INTEGER NOT NULL DEFAULT 1,
  "consecutiveCorrect" INTEGER NOT NULL DEFAULT 0,
  "lastWrongAt" TIMESTAMP(3) NOT NULL,
  "lastAttemptAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "ignoredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WeaknessSignal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WeaknessSignal_userId_bookWordId_questionType_key" ON "WeaknessSignal"("userId", "bookWordId", "questionType");
CREATE INDEX "WeaknessSignal_userId_status_consecutiveCorrect_wrongCount_lastWrongAt_idx" ON "WeaknessSignal"("userId", "status", "consecutiveCorrect", "wrongCount", "lastWrongAt");

CREATE TABLE "TutorConversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "contextType" "TutorContextType" NOT NULL,
  "studyPlanId" TEXT,
  "groupIndex" INTEGER,
  "weaknessSignalId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TutorConversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TutorConversation_context_check" CHECK (
    ("contextType" = 'STUDY_GROUP' AND "studyPlanId" IS NOT NULL AND "groupIndex" IS NOT NULL AND "weaknessSignalId" IS NULL)
    OR ("contextType" = 'MISTAKE' AND "studyPlanId" IS NULL AND "groupIndex" IS NULL AND "weaknessSignalId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "TutorConversation_userId_studyPlanId_groupIndex_key" ON "TutorConversation"("userId", "studyPlanId", "groupIndex");
CREATE UNIQUE INDEX "TutorConversation_userId_weaknessSignalId_key" ON "TutorConversation"("userId", "weaknessSignalId");
CREATE INDEX "TutorConversation_userId_contextType_updatedAt_idx" ON "TutorConversation"("userId", "contextType", "updatedAt");

CREATE TABLE "TutorMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role" "TutorMessageRole" NOT NULL,
  "status" "TutorMessageStatus" NOT NULL DEFAULT 'COMPLETED',
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TutorMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TutorMessage_conversationId_createdAt_idx" ON "TutorMessage"("conversationId", "createdAt");

CREATE TABLE "TutorDailyUsage" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "usageDate" DATE NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TutorDailyUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TutorDailyUsage_userId_usageDate_key" ON "TutorDailyUsage"("userId", "usageDate");

ALTER TABLE "WeaknessSignal" ADD CONSTRAINT "WeaknessSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeaknessSignal" ADD CONSTRAINT "WeaknessSignal_bookWordId_fkey" FOREIGN KEY ("bookWordId") REFERENCES "VocabularyBookWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorConversation" ADD CONSTRAINT "TutorConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorConversation" ADD CONSTRAINT "TutorConversation_studyPlanId_fkey" FOREIGN KEY ("studyPlanId") REFERENCES "StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorConversation" ADD CONSTRAINT "TutorConversation_weaknessSignalId_fkey" FOREIGN KEY ("weaknessSignalId") REFERENCES "WeaknessSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorMessage" ADD CONSTRAINT "TutorMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "TutorConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorDailyUsage" ADD CONSTRAINT "TutorDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
