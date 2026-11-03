CREATE TYPE "TtsQuotaState" AS ENUM ('RESERVED', 'DISPATCHING', 'REFUNDED');
CREATE TABLE "TtsQuotaReservation" (
  "auditId" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "dateKey" VARCHAR(10) NOT NULL,
  "characterCount" INTEGER NOT NULL CHECK ("characterCount" > 0),
  "lastRecoveryError" VARCHAR(80),
  "state" "TtsQuotaState" NOT NULL DEFAULT 'RESERVED',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TtsQuotaReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TtsQuotaReservation_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AiCallAudit"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "TtsQuotaReservation_state_expiresAt_idx" ON "TtsQuotaReservation"("state", "expiresAt");

ALTER TABLE "TtsQuotaReservation" ADD CONSTRAINT "TtsQuotaReservation_userId_dateKey_fkey" FOREIGN KEY ("userId", "dateKey") REFERENCES "TtsDailyUsage"("userId", "dateKey") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
