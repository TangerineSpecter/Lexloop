ALTER TABLE "DailySentence"
ADD COLUMN "difficultyUpdatedAt" TIMESTAMP(3);

UPDATE "DailySentence"
SET "difficultyUpdatedAt" = "updatedAt"
WHERE "difficulty" IS NOT NULL;

CREATE INDEX "DailySentence_userId_status_difficultyUpdatedAt_idx"
ON "DailySentence"("userId", "status", "difficultyUpdatedAt");
