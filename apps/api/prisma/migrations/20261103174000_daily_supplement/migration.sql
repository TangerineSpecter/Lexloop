-- Existing books/enrollments retain their prior behavior. No word or progress is changed.
ALTER TABLE "VocabularyBook" ADD COLUMN "isSupplement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserVocabularyBook" ADD COLUMN "isPaused" BOOLEAN NOT NULL DEFAULT false;
