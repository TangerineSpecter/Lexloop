CREATE INDEX "UserWordProgress_userId_nextReviewAt_bookWordId_idx"
ON "UserWordProgress"("userId", "nextReviewAt", "bookWordId");

CREATE INDEX "UserMasteredWord_userId_masteredAt_wordId_idx"
ON "UserMasteredWord"("userId", "masteredAt", "wordId");
