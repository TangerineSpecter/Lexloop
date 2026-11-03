CREATE TYPE "TtsRegion" AS ENUM ('CHINA', 'GLOBAL');

CREATE TABLE "TtsProviderConfig" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "region" "TtsRegion",
  "model" TEXT NOT NULL DEFAULT 'speech-2.8-hd',
  "voiceId" TEXT DEFAULT 'English_captivating_female1',
  "speed" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "volume" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "pitch" INTEGER NOT NULL DEFAULT 0,
  "encryptedApiKey" TEXT,
  "maxGenerationsPerUserPerDay" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TtsProviderConfig_pkey" PRIMARY KEY ("id")
);

INSERT INTO "TtsProviderConfig" (
  "id", "enabled", "region", "model", "voiceId", "speed", "volume", "pitch",
  "encryptedApiKey", "maxGenerationsPerUserPerDay", "updatedAt"
) VALUES (
  'global', false, NULL, 'speech-2.8-hd', 'English_captivating_female1', 1, 1, 0,
  NULL, 100, CURRENT_TIMESTAMP
);

CREATE TABLE "TtsAudioCache" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "cacheKey" VARCHAR(64) NOT NULL,
  "objectName" VARCHAR(80) NOT NULL,
  "configFingerprint" VARCHAR(64) NOT NULL,
  "model" VARCHAR(100) NOT NULL,
  "voiceId" VARCHAR(200) NOT NULL,
  "speed" DOUBLE PRECISION NOT NULL,
  "volume" DOUBLE PRECISION NOT NULL,
  "pitch" INTEGER NOT NULL,
  "format" VARCHAR(12) NOT NULL,
  "mimeType" VARCHAR(80) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "audioSha256" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TtsAudioCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TtsAudioCache_cacheKey_key" ON "TtsAudioCache"("cacheKey");
CREATE UNIQUE INDEX "TtsAudioCache_objectName_key" ON "TtsAudioCache"("objectName");
CREATE INDEX "TtsAudioCache_userId_lastUsedAt_idx" ON "TtsAudioCache"("userId", "lastUsedAt");
CREATE INDEX "TtsAudioCache_createdAt_idx" ON "TtsAudioCache"("createdAt");

CREATE TABLE "TtsAudioGenerationClaim" (
  "cacheKey" VARCHAR(64) NOT NULL,
  "ownerToken" VARCHAR(64),
  "leaseExpiresAt" TIMESTAMP(3),
  "retryAfter" TIMESTAMP(3),
  "lastFailureCode" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TtsAudioGenerationClaim_pkey" PRIMARY KEY ("cacheKey")
);

CREATE INDEX "TtsAudioGenerationClaim_leaseExpiresAt_idx" ON "TtsAudioGenerationClaim"("leaseExpiresAt");
CREATE INDEX "TtsAudioGenerationClaim_retryAfter_idx" ON "TtsAudioGenerationClaim"("retryAfter");

CREATE TABLE "TtsDailyUsage" (
  "userId" TEXT NOT NULL,
  "dateKey" VARCHAR(10) NOT NULL,
  "generationCount" INTEGER NOT NULL DEFAULT 0,
  "characterCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TtsDailyUsage_pkey" PRIMARY KEY ("userId", "dateKey")
);

CREATE INDEX "TtsDailyUsage_dateKey_idx" ON "TtsDailyUsage"("dateKey");

ALTER TABLE "TtsAudioCache"
  ADD CONSTRAINT "TtsAudioCache_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TtsDailyUsage"
  ADD CONSTRAINT "TtsDailyUsage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
