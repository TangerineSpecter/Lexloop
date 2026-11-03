import { PrismaClient, Prisma } from '@prisma/client';
import type { ImportedBook } from './vocabulary-seed.service';

/** A revision is published together with its complete position map, never as an empty book. */
export async function importVersionedVocabularyBook(prisma: PrismaClient, book: ImportedBook) {
  return prisma.$transaction(
    async (tx) => {
      const reservation = await tx.vocabularyBook.createMany({
        data: [
          {
            sourceKey: book.sourceKey,
            sourcePath: book.sourcePath,
            sourceRevision: book.sourceRevision,
            category: book.category,
            title: book.title,
            publisher: book.publisher,
            grade: book.grade,
          },
        ],
        skipDuplicates: true,
      });
      // This also excludes legacy upserts. FK inserts from a legacy writer that has already
      // upserted the book must wait for this parent-row lock before adding associations.
      await tx.$queryRaw`SELECT "id" FROM "VocabularyBook" WHERE "sourceKey"=${book.sourceKey} FOR UPDATE`;
      const stored = await tx.vocabularyBook.findUniqueOrThrow({
        where: { sourceKey: book.sourceKey },
      });
      if (
        stored.sourceRevision !== book.sourceRevision ||
        stored.kind !== 'SYSTEM' ||
        stored.ownerId !== null
      )
        return 'preserved' as const;
      await tx.$queryRaw`SELECT "id" FROM "VocabularyBookWord" WHERE "bookId"=${stored.id} ORDER BY "id" FOR UPDATE`;
      const readMap = () =>
        tx.vocabularyBookWord.findMany({
          where: { bookId: stored.id },
          orderBy: { position: 'asc' },
          select: { position: true, word: { select: { normalized: true } } },
        });
      const verify = (map: Awaited<ReturnType<typeof readMap>>, complete: boolean) => {
        if (
          (complete && map.length !== book.words.length) ||
          map.some((row) => book.words[row.position - 1]?.normalized !== row.word.normalized)
        )
          throw new Error(
            'Versioned vocabulary association conflict; existing data preserved, manual review required',
          );
      };
      // A previous failed candidate or manual change must not be silently accepted or deleted.
      // Published revisions must already be complete. An exposed empty/partial book
      // from an older candidate requires review, not an automatic association repair.
      verify(await readMap(), reservation.count === 0);
      for (let i = 0; i < book.words.length; i += 1000)
        await tx.vocabularyWord.createMany({
          data: book.words.slice(i, i + 1000),
          skipDuplicates: true,
        });
      const ids = new Map<string, string>();
      for (let i = 0; i < book.words.length; i += 1000) {
        const words = await tx.vocabularyWord.findMany({
          where: { normalized: { in: book.words.slice(i, i + 1000).map((w) => w.normalized) } },
          select: { id: true, normalized: true },
        });
        words.forEach((word) => ids.set(word.normalized, word.id));
      }
      const data = book.words.map((word, index) => ({
        bookId: stored.id,
        wordId: ids.get(word.normalized)!,
        position: index + 1,
      }));
      for (let i = 0; i < data.length; i += 1000)
        await tx.vocabularyBookWord.createMany({
          data: data.slice(i, i + 1000),
          skipDuplicates: true,
        });
      verify(await readMap(), true);
      return 'imported' as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
  );
}
