CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "AiCallStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "displayName" TEXT,
  "role" "Role" NOT NULL DEFAULT 'USER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "RefreshToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT NOT NULL,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

CREATE TABLE "LearningEvent" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT NOT NULL,
  CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LearningEvent_userId_createdAt_idx" ON "LearningEvent"("userId", "createdAt");

CREATE TABLE "KnowledgeChunk" (
  "id" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "embedding" vector,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeChunk_sourceType_sourceId_idx" ON "KnowledgeChunk"("sourceType", "sourceId");

CREATE TABLE "AiCallAudit" (
  "id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "promptVersion" TEXT,
  "status" "AiCallStatus" NOT NULL DEFAULT 'PENDING',
  "latencyMs" INTEGER,
  "estimatedCost" DECIMAL(12,6),
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "userId" TEXT,
  CONSTRAINT "AiCallAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiCallAudit_userId_createdAt_idx" ON "AiCallAudit"("userId", "createdAt");

ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiCallAudit" ADD CONSTRAINT "AiCallAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
