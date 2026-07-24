CREATE TYPE "AiModelProvider" AS ENUM ('DEEPSEEK', 'OPENAI_COMPATIBLE');

CREATE TABLE "AiModelConfig" (
  "id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "provider" "AiModelProvider" NOT NULL,
  "model" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "encryptedApiKey" TEXT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiModelConfig_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiModelConfig_isEnabled_createdAt_idx" ON "AiModelConfig"("isEnabled", "createdAt");

ALTER TABLE "User" ADD COLUMN "selectedAiModelId" TEXT;
CREATE INDEX "User_selectedAiModelId_idx" ON "User"("selectedAiModelId");
ALTER TABLE "User" ADD CONSTRAINT "User_selectedAiModelId_fkey" FOREIGN KEY ("selectedAiModelId") REFERENCES "AiModelConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
