ALTER TABLE "ScenarioSession"
  ADD COLUMN "processingMessageId" TEXT,
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);

ALTER TABLE "ScenarioTurn"
  ADD COLUMN "replyToTurnId" TEXT;

CREATE UNIQUE INDEX "ScenarioTurn_replyToTurnId_key"
  ON "ScenarioTurn"("replyToTurnId");
