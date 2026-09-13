CREATE TYPE "ProfileSnapshotSource" AS ENUM ('ASSESSMENT', 'SCENARIO', 'BACKFILLED_BASELINE');

CREATE TABLE "LanguageProfileSnapshot" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" "ProfileSnapshotSource" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "overallLevel" "CefrLevel" NOT NULL,
  "confidence" "ProfileConfidence" NOT NULL,
  "vocabularyScore" INTEGER NOT NULL,
  "grammarScore" INTEGER NOT NULL,
  "sentenceBuildingScore" INTEGER NOT NULL,
  "taskCompletionScore" INTEGER NOT NULL,
  "naturalnessScore" INTEGER NOT NULL,
  "provisional" BOOLEAN NOT NULL,
  "backfilled" BOOLEAN NOT NULL DEFAULT false,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LanguageProfileSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningAnalysisCache" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearningAnalysisCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LanguageProfileSnapshot_userId_source_sourceId_key" ON "LanguageProfileSnapshot"("userId", "source", "sourceId");
CREATE INDEX "LanguageProfileSnapshot_userId_recordedAt_idx" ON "LanguageProfileSnapshot"("userId", "recordedAt");
CREATE UNIQUE INDEX "LearningAnalysisCache_userId_key" ON "LearningAnalysisCache"("userId");
ALTER TABLE "LanguageProfileSnapshot" ADD CONSTRAINT "LanguageProfileSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningAnalysisCache" ADD CONSTRAINT "LearningAnalysisCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
