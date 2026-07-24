ALTER TABLE "User" ADD COLUMN "selectedAiModelId" TEXT;

CREATE INDEX "User_selectedAiModelId_idx" ON "User"("selectedAiModelId");

ALTER TABLE "User" ADD CONSTRAINT "User_selectedAiModelId_fkey" FOREIGN KEY ("selectedAiModelId") REFERENCES "AiModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
