CREATE TABLE "StudyContentCache" (
  "id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "mode" "StudyPlanMode" NOT NULL,
  "material" JSONB NOT NULL,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyContentCache_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StudyContentCache_signature_mode_createdAt_idx"
  ON "StudyContentCache"("signature", "mode", "createdAt");

ALTER TABLE "StudyPlanItem" ADD COLUMN "contentCacheId" TEXT;
CREATE INDEX "StudyPlanItem_contentCacheId_idx" ON "StudyPlanItem"("contentCacheId");
ALTER TABLE "StudyPlanItem"
  ADD CONSTRAINT "StudyPlanItem_contentCacheId_fkey"
  FOREIGN KEY ("contentCacheId") REFERENCES "StudyContentCache"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
