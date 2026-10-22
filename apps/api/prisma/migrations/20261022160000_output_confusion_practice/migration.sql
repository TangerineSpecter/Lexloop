CREATE TYPE "OutputStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TABLE "OutputChallenge" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "challengeDate" DATE NOT NULL,
  "prompt" TEXT NOT NULL, "targets" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutputChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutputChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OutputChallenge_userId_challengeDate_key" ON "OutputChallenge"("userId", "challengeDate");
CREATE TABLE "OutputSubmission" (
  "id" TEXT NOT NULL, "challengeId" TEXT NOT NULL, "clientRequestId" TEXT NOT NULL,
  "answer" TEXT NOT NULL, "status" "OutputStatus" NOT NULL DEFAULT 'QUEUED',
  "workerTokenHash" TEXT NOT NULL, "leaseToken" TEXT, "processingStartedAt" TIMESTAMP(3),
  "feedback" JSONB, "error" TEXT, "responseTimeMs" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "OutputSubmission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutputSubmission_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "OutputChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OutputSubmission_challengeId_clientRequestId_key" ON "OutputSubmission"("challengeId", "clientRequestId");
CREATE INDEX "OutputSubmission_challengeId_createdAt_idx" ON "OutputSubmission"("challengeId", "createdAt");
CREATE TABLE "ConfusionAttempt" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "groupId" TEXT NOT NULL, "clientRequestId" TEXT NOT NULL,
  "correctCount" INTEGER NOT NULL, "total" INTEGER NOT NULL, "answers" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfusionAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConfusionAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConfusionAttempt_userId_clientRequestId_key" ON "ConfusionAttempt"("userId", "clientRequestId");
CREATE INDEX "ConfusionAttempt_userId_createdAt_idx" ON "ConfusionAttempt"("userId", "createdAt");
CREATE INDEX "ConfusionAttempt_userId_groupId_createdAt_idx" ON "ConfusionAttempt"("userId", "groupId", "createdAt");
CREATE INDEX "WordReviewAttempt_userId_createdAt_idx" ON "WordReviewAttempt"("userId", "createdAt");
