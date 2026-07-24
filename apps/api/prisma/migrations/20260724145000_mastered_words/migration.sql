CREATE TABLE "UserMasteredWord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "masteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMasteredWord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserMasteredWord_userId_wordId_key" ON "UserMasteredWord"("userId", "wordId");
CREATE INDEX "UserMasteredWord_wordId_idx" ON "UserMasteredWord"("wordId");

ALTER TABLE "UserMasteredWord" ADD CONSTRAINT "UserMasteredWord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMasteredWord" ADD CONSTRAINT "UserMasteredWord_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "VocabularyWord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
