CREATE TYPE "StudyPlanMode" AS ENUM ('GROUP', 'INDIVIDUAL', 'EXAM');

-- PostgreSQL does not allow a newly-added enum value to be used before the
-- surrounding migration transaction commits. Replace the enum type instead,
-- so GENERATING can safely become the column default in this same migration.
CREATE TYPE "StudyPlanStatus_new" AS ENUM ('GENERATING', 'ACTIVE', 'COMPLETED', 'FAILED');
ALTER TABLE "StudyPlan" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "StudyPlan"
  ALTER COLUMN "status" TYPE "StudyPlanStatus_new"
  USING ("status"::text::"StudyPlanStatus_new");
DROP TYPE "StudyPlanStatus";
ALTER TYPE "StudyPlanStatus_new" RENAME TO "StudyPlanStatus";

ALTER TABLE "StudyPlan"
  ADD COLUMN "mode" "StudyPlanMode" NOT NULL DEFAULT 'GROUP',
  ADD COLUMN "generatedContent" JSONB,
  ADD COLUMN "generationError" TEXT,
  ADD COLUMN "generatedAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);

ALTER TABLE "StudyPlan" ALTER COLUMN "status" SET DEFAULT 'GENERATING'::"StudyPlanStatus";

ALTER TABLE "StudyPlanItem"
  ADD COLUMN "question" JSONB;

ALTER TABLE "WordReviewAttempt"
  ADD COLUMN "questionType" TEXT,
  ADD COLUMN "selectedAnswer" JSONB,
  ADD COLUMN "responseTimeMs" INTEGER;
