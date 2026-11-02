CREATE TYPE "StudyContentFeedbackRating" AS ENUM ('UP', 'DOWN');
CREATE TYPE "StudyContentFeedbackReason" AS ENUM (
  'ANSWER_INCORRECT',
  'QUESTION_UNCLEAR',
  'OPTIONS_INCORRECT',
  'EXPLANATION_UNCLEAR',
  'OTHER'
);

ALTER TABLE "StudyContentCache"
  ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "disabledReason" VARCHAR(200),
  ADD COLUMN "disabledByUserId" TEXT;

-- Only caches with traceable links exclusively to ownerless system vocabulary
-- are promoted. Private or orphaned legacy material remains stored but hidden
-- and unavailable for reuse until its source can be reviewed.
UPDATE "StudyContentCache" AS cache
SET "isPublic" = EXISTS (
      SELECT 1
      FROM "StudyPlanItem" AS item
      JOIN "VocabularyBookWord" AS book_word ON book_word."id" = item."bookWordId"
      JOIN "VocabularyBook" AS book ON book."id" = book_word."bookId"
      WHERE item."contentCacheId" = cache."id"
    ) AND NOT EXISTS (
      SELECT 1
      FROM "StudyPlanItem" AS item
      JOIN "VocabularyBookWord" AS book_word ON book_word."id" = item."bookWordId"
      JOIN "VocabularyBook" AS book ON book."id" = book_word."bookId"
      WHERE item."contentCacheId" = cache."id"
        AND (book."kind" <> 'SYSTEM'::"VocabularyBookKind" OR book."ownerId" IS NOT NULL)
    );

UPDATE "StudyContentCache"
SET "isActive" = false,
    "disabledAt" = CURRENT_TIMESTAMP,
    "disabledReason" = '来源无法确认公共词书'
WHERE NOT "isPublic";

CREATE INDEX "StudyContentCache_isPublic_isActive_mode_createdAt_idx"
  ON "StudyContentCache"("isPublic", "isActive", "mode", "createdAt");

CREATE TABLE "StudyContentQuestionFeedback" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "contentCacheId" TEXT NOT NULL,
  "questionFingerprint" VARCHAR(64) NOT NULL,
  "questionSnapshot" JSONB NOT NULL,
  "rating" "StudyContentFeedbackRating" NOT NULL,
  "reason" "StudyContentFeedbackReason",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyContentQuestionFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudyContentQuestionFeedback_userId_contentCacheId_questionFingerprint_key"
  ON "StudyContentQuestionFeedback"("userId", "contentCacheId", "questionFingerprint");
CREATE INDEX "StudyContentQuestionFeedback_contentCacheId_questionFingerprint_rating_idx"
  ON "StudyContentQuestionFeedback"("contentCacheId", "questionFingerprint", "rating");

ALTER TABLE "StudyContentCache"
  ADD CONSTRAINT "StudyContentCache_disabledByUserId_fkey"
  FOREIGN KEY ("disabledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudyContentQuestionFeedback"
  ADD CONSTRAINT "StudyContentQuestionFeedback_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "StudyContentQuestionFeedback_contentCacheId_fkey"
  FOREIGN KEY ("contentCacheId") REFERENCES "StudyContentCache"("id") ON DELETE CASCADE ON UPDATE CASCADE;
