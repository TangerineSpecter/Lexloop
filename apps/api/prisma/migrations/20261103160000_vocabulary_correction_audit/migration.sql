CREATE TABLE "VocabularyCorrectionAudit" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'APPLIED',
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    CONSTRAINT "VocabularyCorrectionAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VocabularyCorrectionAudit_state_check" CHECK ("state" IN ('APPLIED', 'RESTORED'))
);
CREATE UNIQUE INDEX "VocabularyCorrectionAudit_batchId_wordId_key" ON "VocabularyCorrectionAudit"("batchId", "wordId");
