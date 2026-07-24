CREATE TYPE "VocabularyCategory" AS ENUM ('PRIMARY', 'JUNIOR', 'SENIOR', 'COLLEGE', 'EXAM', 'MATERIAL', 'PHRASES', 'GENERAL');
CREATE TYPE "WordProgressState" AS ENUM ('NEW', 'LEARNING', 'REVIEWING', 'MASTERED');

CREATE TABLE "VocabularyBook" (
  "id" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "category" "VocabularyCategory" NOT NULL,
  "title" TEXT NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "publisher" TEXT,
  "grade" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VocabularyBook_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VocabularyBook_sourceKey_key" ON "VocabularyBook"("sourceKey");
CREATE INDEX "VocabularyBook_category_isActive_idx" ON "VocabularyBook"("category", "isActive");

CREATE TABLE "VocabularyWord" (
  "id" TEXT NOT NULL,
  "normalized" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "ukPhonetic" TEXT,
  "usPhonetic" TEXT,
  "meaning" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VocabularyWord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VocabularyWord_normalized_key" ON "VocabularyWord"("normalized");

CREATE TABLE "VocabularyBookWord" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "wordId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "VocabularyBookWord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VocabularyBookWord_bookId_wordId_key" ON "VocabularyBookWord"("bookId", "wordId");
CREATE UNIQUE INDEX "VocabularyBookWord_bookId_position_key" ON "VocabularyBookWord"("bookId", "position");
CREATE INDEX "VocabularyBookWord_wordId_idx" ON "VocabularyBookWord"("wordId");

CREATE TABLE "UserVocabularyBook" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastStudiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserVocabularyBook_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserVocabularyBook_userId_bookId_key" ON "UserVocabularyBook"("userId", "bookId");
CREATE INDEX "UserVocabularyBook_userId_isDefault_idx" ON "UserVocabularyBook"("userId", "isDefault");

CREATE TABLE "UserWordProgress" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bookWordId" TEXT NOT NULL,
  "state" "WordProgressState" NOT NULL DEFAULT 'NEW',
  "familiarity" INTEGER NOT NULL DEFAULT 0,
  "reviewCount" INTEGER NOT NULL DEFAULT 0,
  "nextReviewAt" TIMESTAMP(3),
  "firstLearnedAt" TIMESTAMP(3),
  "lastReviewedAt" TIMESTAMP(3),
  CONSTRAINT "UserWordProgress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserWordProgress_userId_bookWordId_key" ON "UserWordProgress"("userId", "bookWordId");
CREATE INDEX "UserWordProgress_userId_state_nextReviewAt_idx" ON "UserWordProgress"("userId", "state", "nextReviewAt");

ALTER TABLE "VocabularyBookWord" ADD CONSTRAINT "VocabularyBookWord_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "VocabularyBook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VocabularyBookWord" ADD CONSTRAINT "VocabularyBookWord_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "VocabularyWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserVocabularyBook" ADD CONSTRAINT "UserVocabularyBook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserVocabularyBook" ADD CONSTRAINT "UserVocabularyBook_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "VocabularyBook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserWordProgress" ADD CONSTRAINT "UserWordProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserWordProgress" ADD CONSTRAINT "UserWordProgress_bookWordId_fkey" FOREIGN KEY ("bookWordId") REFERENCES "VocabularyBookWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
