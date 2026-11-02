CREATE TYPE "StudyPlanGenerationPhase" AS ENUM (
  'PREPARING',
  'WAITING_MODEL',
  'VALIDATING',
  'REPAIRING',
  'SAVING'
);

ALTER TABLE "StudyPlan"
ADD COLUMN "generationPhase" "StudyPlanGenerationPhase";
