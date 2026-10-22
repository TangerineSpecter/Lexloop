ALTER TABLE "VocabularyBookWord" ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'TRAVEL';
ALTER TABLE "VocabularyBookWord" ADD COLUMN "isCollected" BOOLEAN NOT NULL DEFAULT true;
UPDATE "VocabularyBook" SET "title" = '个人生词本' WHERE "kind" = 'PERSONAL' AND "sourceKey" LIKE 'personal:%:travel';
CREATE TABLE "LabLesson" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "input" JSONB NOT NULL, "content" JSONB, "answers" JSONB, "score" INTEGER,
  "error" TEXT, "workerTokenHash" TEXT NOT NULL, "leaseToken" TEXT,
  "processingStartedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3), "submittedAt" TIMESTAMP(3),
  CONSTRAINT "LabLesson_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabLesson_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LabLesson_userId_clientRequestId_key" ON "LabLesson"("userId", "clientRequestId");
CREATE INDEX "LabLesson_userId_kind_createdAt_idx" ON "LabLesson"("userId", "kind", "createdAt");
CREATE INDEX "LabLesson_userId_status_createdAt_idx" ON "LabLesson"("userId", "status", "createdAt");
