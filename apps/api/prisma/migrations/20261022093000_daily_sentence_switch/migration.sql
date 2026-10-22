CREATE TABLE "SystemFeatureSetting" (
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemFeatureSetting_pkey" PRIMARY KEY ("key")
);
INSERT INTO "SystemFeatureSetting" ("key", "enabled", "updatedAt") VALUES ('daily-sentence', true, CURRENT_TIMESTAMP);
