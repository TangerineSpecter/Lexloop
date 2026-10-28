import { Prisma } from '@prisma/client';

/**
 * Serialize answer-derived progress changes for the same learner and words.
 * Call this before reading a progress row used to compute its next schedule.
 */
export async function lockUserWordProgress(
  tx: Prisma.TransactionClient,
  userId: string,
  bookWordIds: readonly string[],
) {
  const orderedIds = [...new Set(bookWordIds)].sort();
  if (!orderedIds.length) return;

  await tx.$queryRaw(Prisma.sql`
    SELECT "bookWordId"
    FROM "UserWordProgress"
    WHERE "userId" = ${userId}
      AND "bookWordId" IN (${Prisma.join(orderedIds)})
    ORDER BY "bookWordId" COLLATE "C"
    FOR UPDATE
  `);
}
