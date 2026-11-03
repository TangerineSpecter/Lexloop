import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';
import { importVersionedVocabularyBook } from '../src/modules/vocabulary/versioned-vocabulary-import';

// Executable feasibility probes, not a companion-book implementation. Synthetic
// accounts/words only; no real model, user data or production connection.
async function fixture(
  run: (input: {
    db: PrismaClient;
    userId: string;
    wordId: string;
    oldId: string;
    companionId: string;
    oldBookId: string;
    companionBookId: string;
    service: StudyService;
  }) => Promise<void>,
) {
  const db = new PrismaClient({ datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } } });
  const token = randomUUID();
  let userId: string | undefined;
  let wordId: string | undefined;
  const books: string[] = [];
  const ai = { generateForUser: vi.fn() };
  try {
    userId = (
      await db.user.create({
        data: { email: `companion-${token}@example.invalid`, passwordHash: 'fixture-only' },
      })
    ).id;
    wordId = (
      await db.vocabularyWord.create({
        data: { normalized: `companion-${token}`, text: 'surname', meaning: '姓氏' },
      })
    ).id;
    const entries = [];
    for (const [index, revision] of ['legacy', 'companion-v1'].entries()) {
      const book = await db.vocabularyBook.create({
        data: {
          sourceKey: `${token}-${revision}`,
          sourcePath: 'isolated-fixture',
          title: revision,
          category: 'GENERAL',
          sourceRevision: revision,
          bookWords: { create: { wordId, position: 1 } },
        },
        include: { bookWords: true },
      });
      books.push(book.id);
      entries.push(book.bookWords[0].id);
      await db.userVocabularyBook.create({
        data: { userId, bookId: book.id, isDefault: index === 1 },
      });
    }
    await db.userWordProgress.create({
      data: {
        userId,
        bookWordId: entries[0],
        state: 'REVIEWING',
        totalAttempts: 5,
        correctAttempts: 4,
        familiarity: 70,
        nextReviewAt: new Date(Date.now() + 7 * 86400_000),
      },
    });
    const service = new StudyService(db as never, ai as never, {} as never, {} as never);
    await run({
      db,
      userId,
      wordId,
      oldId: entries[0],
      companionId: entries[1],
      oldBookId: books[0],
      companionBookId: books[1],
      service,
    });
    expect(ai.generateForUser).not.toHaveBeenCalled();
  } finally {
    if (userId) {
      await db.studyPlan.deleteMany({ where: { userId } });
      await db.user.delete({ where: { id: userId } });
    }
    await db.vocabularyBook.deleteMany({ where: { id: { in: books } } });
    if (wordId) await db.vocabularyWord.delete({ where: { id: wordId } });
    await db.$disconnect();
  }
}

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('companion book feasibility boundaries', () => {
  it('shows a learned shared word as NEW in a different book, while explicit mastery excludes it globally', async () => {
    await fixture(async ({ db, userId, wordId, oldId, companionId, service }) => {
      const before = await db.userWordProgress.findMany({ where: { userId } });
      const plan = await service.createProgressivePlan(userId);
      expect(plan.words.map((word) => word.id)).toEqual([companionId]);
      expect(plan.words[0].source).toBe('NEW');
      expect(plan.words[0].id).not.toBe(oldId);
      expect(await db.userWordProgress.findMany({ where: { userId } })).toEqual(before);
      await db.studyPlan.delete({ where: { id: plan.id } });
      await db.userMasteredWord.create({ data: { userId, wordId } });
      await expect(service.createProgressivePlan(userId)).rejects.toThrow('没有带可用释义');
      expect(await db.userWordProgress.findMany({ where: { userId } })).toEqual(before);
    });
  });

  it('still selects both due associations after the companion is inactive and unsubscribed', async () => {
    await fixture(
      async ({ db, userId, oldId, companionId, oldBookId, companionBookId, service }) => {
        await db.userWordProgress.update({
          where: { userId_bookWordId: { userId, bookWordId: oldId } },
          data: { nextReviewAt: new Date(0) },
        });
        await db.userWordProgress.create({
          data: { userId, bookWordId: companionId, state: 'REVIEWING', nextReviewAt: new Date(0) },
        });
        await db.userVocabularyBook.delete({
          where: { userId_bookId: { userId, bookId: companionBookId } },
        });
        await db.userVocabularyBook.update({
          where: { userId_bookId: { userId, bookId: oldBookId } },
          data: { isDefault: true },
        });
        await db.vocabularyBook.update({
          where: { id: companionBookId },
          data: { isActive: false },
        });
        const before = await db.userWordProgress.findMany({
          where: { userId },
          orderBy: { id: 'asc' },
        });
        const plan = await service.createProgressivePlan(userId);
        expect(plan.words.map((word) => word.id).sort()).toEqual([oldId, companionId].sort());
        expect(plan.words.every((word) => word.source === 'REVIEW')).toBe(true);
        expect(
          await db.userWordProgress.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
        ).toEqual(before);
      },
    );
  });

  it('demonstrates why deletion cannot serve as undo after companion learning, with transactional rollback', async () => {
    await fixture(async ({ db, userId, companionId, companionBookId }) => {
      await db.userWordProgress.create({
        data: { userId, bookWordId: companionId, state: 'REVIEWING', totalAttempts: 1 },
      });
      const plan = await db.studyPlan.create({
        data: {
          userId,
          status: 'COMPLETED',
          completedAt: new Date(),
          items: {
            create: {
              bookWordId: companionId,
              source: 'NEW',
              groupIndex: 0,
              completedAt: new Date(),
            },
          },
        },
        include: { items: true },
      });
      await db.wordReviewAttempt.create({
        data: { userId, bookWordId: companionId, planItemId: plan.items[0].id, isCorrect: true },
      });
      const snapshot = async () => ({
        progress: await db.userWordProgress.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
        items: await db.studyPlanItem.findMany({ where: { planId: plan.id } }),
        attempts: await db.wordReviewAttempt.findMany({ where: { userId } }),
      });
      const before = await snapshot();
      await expect(
        db.$transaction(async (tx) => {
          await tx.vocabularyBook.delete({ where: { id: companionBookId } });
          expect(
            await tx.userWordProgress.count({ where: { userId, bookWordId: companionId } }),
          ).toBe(0);
          expect(await tx.studyPlanItem.count({ where: { planId: plan.id } })).toBe(0);
          expect(await tx.wordReviewAttempt.count({ where: { userId } })).toBe(0);
          throw new Error('probe rollback');
        }),
      ).rejects.toThrow('probe rollback');
      expect(await snapshot()).toEqual(before);
    });
  });

  it('can append an association without remapping or copying prior learning evidence', async () => {
    await fixture(async ({ db, userId, oldId, companionId, companionBookId }) => {
      const before = await db.userWordProgress.findMany({ where: { userId } });
      const association = await db.vocabularyBookWord.findUniqueOrThrow({
        where: { id: companionId },
      });
      const word = await db.vocabularyWord.create({
        data: { normalized: `append-${randomUUID()}`, text: 'nickname', meaning: '昵称' },
      });
      try {
        const book = await db.vocabularyBook.findUniqueOrThrow({ where: { id: companionBookId } });
        const existing = await db.vocabularyWord.findUniqueOrThrow({
          where: { id: association.wordId },
        });
        const proposal = {
          sourceKey: book.sourceKey,
          sourcePath: book.sourcePath,
          sourceRevision: book.sourceRevision!,
          title: book.title,
          category: book.category,
          publisher: book.publisher,
          grade: book.grade,
          words: [existing, word],
        };
        // The shipping importer does not support append: its published map is
        // immutable, and a changed revision preserves the existing edition.
        await expect(importVersionedVocabularyBook(db, proposal)).rejects.toThrow(
          'association conflict',
        );
        expect(
          await importVersionedVocabularyBook(db, { ...proposal, sourceRevision: 'companion-v2' }),
        ).toBe('preserved');
        expect(await db.vocabularyBookWord.count({ where: { bookId: companionBookId } })).toBe(1);
        await db.$transaction(async (tx) => {
          await tx.vocabularyBookWord.createMany({
            data: [{ bookId: companionBookId, wordId: word.id, position: 2 }],
            skipDuplicates: true,
          });
        });
        expect(
          await db.vocabularyBookWord.findUniqueOrThrow({ where: { id: companionId } }),
        ).toEqual(association);
        expect(await db.userWordProgress.findMany({ where: { userId } })).toEqual(before);
        expect(before.map((row) => row.bookWordId)).toEqual([oldId]);
        expect(await db.vocabularyBookWord.count({ where: { bookId: companionBookId } })).toBe(2);
      } finally {
        await db.vocabularyWord.delete({ where: { id: word.id } });
      }
    });
  });
});
