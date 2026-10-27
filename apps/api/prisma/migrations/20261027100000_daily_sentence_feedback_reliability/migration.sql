ALTER TABLE "DailySentence"
ADD COLUMN "difficultyTimestampReliable" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "DailySentence_userId_status_difficultyUpdatedAt_idx";

CREATE INDEX "DailySentence_feedback_time_idx"
ON "DailySentence"("userId", "status", "difficultyTimestampReliable", "difficultyUpdatedAt");
