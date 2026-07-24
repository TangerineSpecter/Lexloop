ALTER TABLE "StudyPlan" ADD COLUMN "generationStartedAt" TIMESTAMP(3);

UPDATE "StudyPlan"
SET
  "status" = 'FAILED',
  "generationError" = COALESCE(
    "generationError",
    '旧版学习计划没有生成内容，请重新生成'
  )
WHERE "status" = 'ACTIVE'
  AND "generatedContent" IS NULL;
