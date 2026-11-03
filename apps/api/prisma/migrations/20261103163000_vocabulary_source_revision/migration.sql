-- Existing books stay NULL. Never infer that their associations match a new source revision.
ALTER TABLE "VocabularyBook" ADD COLUMN "sourceRevision" TEXT;
