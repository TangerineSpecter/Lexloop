CREATE TABLE "MicroProgress" (
  "userId" TEXT NOT NULL,
  "completedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "interpretationKey" TEXT,
  "interpretation" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MicroProgress_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "MicroProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "MicroError" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lessonKey" TEXT NOT NULL,
  "interpretation" TEXT NOT NULL,
  "ownSentence" TEXT,
  "reviewCount" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MicroError_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MicroError_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MicroError_userId_lessonKey_key" ON "MicroError"("userId", "lessonKey");
CREATE INDEX "MicroError_userId_dueAt_idx" ON "MicroError"("userId", "dueAt");
