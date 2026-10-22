CREATE TABLE "DailySentence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dateKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'GENERATING',
  "content" JSONB,
  "readAt" TIMESTAMP(3),
  "favorite" BOOLEAN NOT NULL DEFAULT false,
  "difficulty" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "generationToken" TEXT,
  "generationStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailySentence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailySentence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DailySentence_status_check" CHECK ("status" IN ('GENERATING', 'READY', 'FAILED')),
  CONSTRAINT "DailySentence_difficulty_check" CHECK ("difficulty" IS NULL OR "difficulty" IN ('EASY', 'RIGHT', 'HARD'))
);
CREATE UNIQUE INDEX "DailySentence_userId_dateKey_key" ON "DailySentence"("userId", "dateKey");
CREATE INDEX "DailySentence_userId_status_readAt_createdAt_idx" ON "DailySentence"("userId", "status", "readAt", "createdAt");
-- Also guard the unread backlog across workers and dates.
CREATE UNIQUE INDEX "DailySentence_one_unread" ON "DailySentence"("userId") WHERE "status" = 'READY' AND "readAt" IS NULL;
