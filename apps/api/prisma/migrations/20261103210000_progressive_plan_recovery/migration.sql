ALTER TYPE "StudyPlanStatus" ADD VALUE 'INVALIDATED';
ALTER TABLE "StudyPlan" ADD COLUMN "replacementPlanId" TEXT;
CREATE UNIQUE INDEX "StudyPlan_replacementPlanId_key" ON "StudyPlan"("replacementPlanId");
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_replacementPlanId_fkey" FOREIGN KEY ("replacementPlanId") REFERENCES "StudyPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
