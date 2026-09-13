CREATE TABLE "ScenarioDailyUsage" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "usageDate" DATE NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScenarioDailyUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScenarioDailyUsage_userId_usageDate_key"
  ON "ScenarioDailyUsage"("userId", "usageDate");

ALTER TABLE "ScenarioDailyUsage"
  ADD CONSTRAINT "ScenarioDailyUsage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
