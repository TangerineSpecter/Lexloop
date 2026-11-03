import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'parallel final study groups on PostgreSQL',
  () => {
    it.each(['NORMAL', 'PROGRESSIVE'] as const)(
      'finishes already-started %s plans when separate groups commit concurrently',
      async (purpose) => {
        const db = new PrismaClient({
          datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
        });
        const id = randomUUID();
        const user = await db.user.create({
          data: { email: `group-race-${id}@example.invalid`, passwordHash: 'fixture' },
        });
        const wordIds: string[] = [];
        let release!: () => void;
        const bothCounted = new Promise<void>((resolve) => {
          release = resolve;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const book = await db.vocabularyBook.create({
            data: {
              ownerId: user.id,
              kind: 'PERSONAL',
              sourceKey: id,
              title: 'Concurrent completion fixture',
              sourcePath: 'fixture',
              category: 'GENERAL',
            },
          });
          const bookWords = [];
          for (const [position, text] of ['help', 'repair'].entries()) {
            const word = await db.vocabularyWord.create({
              data: { normalized: `${id}-${text}`, text, meaning: 'v. 帮助' },
            });
            wordIds.push(word.id);
            const bw = await db.vocabularyBookWord.create({
              data: { bookId: book.id, wordId: word.id, position },
            });
            bookWords.push(bw);
            await db.userWordProgress.create({
              data: { userId: user.id, bookWordId: bw.id, state: 'REVIEWING' },
            });
          }
          const questions = bookWords.map((bw) => ({
            bookWordId: bw.id,
            type: 'MEANING_RECOGNITION',
            prompt: 'Choose the meaning.',
            options: ['帮助', '拒绝'],
            correctAnswers: ['帮助'],
            explanation: 'Fixture explanation.',
          }));
          if (purpose === 'PROGRESSIVE')
            await db.progressivePracticeProgress.create({
              data: { userId: user.id, trackVersion: 1, highestUnlockedStage: 'FOUNDATION' },
            });
          const plan = await db.studyPlan.create({
            data: {
              userId: user.id,
              mode: 'GROUP',
              purpose,
              ...(purpose === 'PROGRESSIVE'
                ? { progressiveStage: 'FOUNDATION' as const, progressiveVersion: 1 }
                : {}),
              status: 'ACTIVE',
              startedAt: new Date(),
              generatedAt: new Date(),
              generatedContent: {
                groups: questions.map((q, index) => ({
                  index,
                  title: 'Fixture',
                  sentences: [],
                  questions: [q],
                })),
              },
              items: {
                create: questions.map((q, index) => ({
                  bookWordId: q.bookWordId,
                  source: 'REVIEW',
                  groupIndex: index,
                  question: q,
                })),
              },
            },
          });
          const observed: number[] = [];
          const proxy = new Proxy(db, {
            get(target, key) {
              if (key === '$transaction')
                return async (callback: (tx: unknown) => unknown) =>
                  target.$transaction(async (tx) =>
                    callback(
                      new Proxy(tx, {
                        get(inner, member) {
                          if (member === 'studyPlanItem')
                            return new Proxy(tx.studyPlanItem, {
                              get(delegate, method) {
                                if (method === 'count')
                                  return async (...args: Parameters<typeof delegate.count>) => {
                                    const count = await delegate.count(...args);
                                    observed.push(count);
                                    if (observed.length === 1) timer = setTimeout(release, 500);
                                    if (observed.length === 2) release();
                                    await bothCounted;
                                    return count;
                                  };
                                const value = Reflect.get(delegate, method);
                                return typeof value === 'function' ? value.bind(delegate) : value;
                              },
                            });
                          const value = Reflect.get(inner, member);
                          return typeof value === 'function' ? value.bind(inner) : value;
                        },
                      }),
                    ),
                  );
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const service = new StudyService(
            proxy as never,
            {} as never,
            {} as never,
            new MistakesService({} as never),
          );
          await Promise.all(
            bookWords.map((bw, index) =>
              service.completeGroup(user.id, plan.id, index, [
                { bookWordId: bw.id, selectedAnswer: ['帮助'] },
              ]),
            ),
          );
          console.log('concurrent final-group remaining counts', observed);
          expect(
            await db.studyPlanItem.count({ where: { planId: plan.id, completedAt: null } }),
          ).toBe(0);
          expect(await db.studyPlan.findUnique({ where: { id: plan.id } })).toMatchObject({
            status: 'COMPLETED',
            completedAt: expect.any(Date),
          });
          expect(await db.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(2);
          if (purpose === 'PROGRESSIVE')
            expect(
              await db.progressivePracticeProgress.findUnique({
                where: { userId_trackVersion: { userId: user.id, trackVersion: 1 } },
              }),
            ).toMatchObject({ highestUnlockedStage: 'CONTEXT' });
          const beforeReplay = await db.userWordProgress.findMany({
            where: { userId: user.id },
            orderBy: { id: 'asc' },
          });
          await Promise.all(
            bookWords.map((bw, index) =>
              service.completeGroup(user.id, plan.id, index, [
                { bookWordId: bw.id, selectedAnswer: ['拒绝'] },
              ]),
            ),
          );
          expect(await db.wordReviewAttempt.count({ where: { userId: user.id } })).toBe(2);
          expect(
            await db.userWordProgress.findMany({
              where: { userId: user.id },
              orderBy: { id: 'asc' },
            }),
          ).toEqual(beforeReplay);

          const progress = await db.userWordProgress.findMany({ where: { userId: user.id } });
          expect(progress.map((row) => row.totalAttempts)).toEqual([1, 1]);
        } finally {
          release();
          if (timer) clearTimeout(timer);
          await db.user.delete({ where: { id: user.id } });
          await db.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
          await db.$disconnect();
        }
      },
      15_000,
    );
  },
);
