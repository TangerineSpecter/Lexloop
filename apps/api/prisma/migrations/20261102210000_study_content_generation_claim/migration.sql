CREATE TABLE "StudyContentGenerationClaim" (
  "signature" VARCHAR(64) NOT NULL,
  "ownerToken" VARCHAR(64),
  "leaseExpiresAt" TIMESTAMP(3),
  "retryAfter" TIMESTAMP(3),
  "lastFailureCode" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyContentGenerationClaim_pkey" PRIMARY KEY ("signature")
);

CREATE INDEX "StudyContentGenerationClaim_leaseExpiresAt_idx"
  ON "StudyContentGenerationClaim"("leaseExpiresAt");
CREATE INDEX "StudyContentGenerationClaim_retryAfter_idx"
  ON "StudyContentGenerationClaim"("retryAfter");
