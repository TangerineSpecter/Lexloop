import { Prisma } from '@prisma/client';
import review from './daily-vocabulary-boundary-review.json';

export const DAILY_SUPPLEMENT_KEY = 'supplement:daily-boundaries-v2';
export const DAILY_SUPPLEMENT_REVISION = 'daily-supplement-v1';
export const DAILY_SUPPLEMENT_WORDS = review.reviewed
  .filter((entry) => entry.classification === 'word-list')
  .flatMap((entry) => entry.entries ?? []);

// Only supplements use cross-book ownership. Ordinary context-specific learning
// retains its existing behavior when no supplement has claimed the global word.
export function unclaimedBySupplement(userId: string): Prisma.VocabularyWordWhereInput {
  return {
    bookWords: {
      none: {
        book: { isSupplement: true },
        OR: [
          { progress: { some: { userId } } },
          { studyPlanItems: { some: { plan: { userId } } } },
        ],
      },
    },
  };
}
export function ordinaryNewWordSql(userId: string) {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "VocabularyBookWord" owned
    JOIN "VocabularyBook" owner_book ON owner_book."id"=owned."bookId"
    WHERE owned."wordId"=w."id" AND owner_book."isSupplement"=TRUE
      AND (EXISTS (SELECT 1 FROM "UserWordProgress" p WHERE p."bookWordId"=owned."id" AND p."userId"=${userId})
        OR EXISTS (SELECT 1 FROM "StudyPlanItem" i JOIN "StudyPlan" p ON p."id"=i."planId"
          WHERE i."bookWordId"=owned."id" AND p."userId"=${userId}))
  )`;
}
export const ordinaryBookSql = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "VocabularyBook" b WHERE b."id"=bw."bookId" AND b."isSupplement"=TRUE
)`;

// Call under the account advisory lock. Fixed curricula and already queued
// activities retain their original references, but share the supplement's SRS.
export async function canonicalSupplementWord(
  tx: Prisma.TransactionClient,
  userId: string,
  bookWordId: string,
) {
  const original = await tx.vocabularyBookWord.findUniqueOrThrow({
    where: { id: bookWordId },
    select: { wordId: true },
  });
  const claimed = await tx.vocabularyBookWord.findFirst({
    where: {
      wordId: original.wordId,
      book: { isSupplement: true },
      OR: [{ progress: { some: { userId } } }, { studyPlanItems: { some: { plan: { userId } } } }],
    },
    select: { id: true },
  });
  return claimed?.id ?? bookWordId;
}
export async function lockSupplementAccount(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId},0)) IS NULL`;
}
// Output challenges remain answerable from history. Reserve every referenced
// global word, even if the challenge has already received a submission.
export async function outputReservedWords(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<Array<{ wordId: string }>>(Prisma.sql`
    SELECT DISTINCT bw."wordId" FROM "OutputChallenge" c
    CROSS JOIN LATERAL jsonb_array_elements(c."targets") target
    JOIN "VocabularyBookWord" bw ON bw."id" = target->>'bookWordId'
    WHERE c."userId" = ${userId}
  `);
  return new Set(rows.map((row) => row.wordId));
}
