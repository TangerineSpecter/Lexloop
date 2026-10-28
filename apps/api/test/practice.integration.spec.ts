import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OutputService } from '../src/modules/practice/output.service';
import { ConfusionService } from '../src/modules/practice/confusion.service';
import { PracticeEvidenceService } from '../src/modules/practice/practice-evidence.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

// Opt in with a migrated, isolated database. Every fixture belongs to a fresh
// user; the test never truncates shared tables or calls an external model.
describe.skipIf(!process.env.PRACTICE_TEST_DATABASE_URL)('practice database concurrency', () => {
  it('creates one daily snapshot and applies each submission and contrast exactly once', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.PRACTICE_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `practice-${fixtureId}@example.invalid`,
        passwordHash: 'isolated-test-fixture',
      },
    });
    try {
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: user.id,
          kind: 'PERSONAL',
          sourceKey: fixtureId,
          title: 'Practice test',
          sourcePath: 'test',
          category: 'GENERAL',
        },
      });
      await prisma.userVocabularyBook.create({
        data: { userId: user.id, bookId: book.id, isDefault: true },
      });
      for (const [position, text] of ['affect', 'effect', 'borrow'].entries()) {
        const word = await prisma.vocabularyWord.upsert({
          where: { normalized: text },
          create: { normalized: text, text, meaning: 'test' },
          update: {},
        });
        const bookWord = await prisma.vocabularyBookWord.create({
          data: { bookId: book.id, wordId: word.id, position },
        });
        await prisma.userWordProgress.create({
          data: { userId: user.id, bookWordId: bookWord.id, state: 'LEARNING' },
        });
      }
      const mistakes = new MistakesService(prisma as never);
      const evidence = new PracticeEvidenceService(mistakes);
      const models = {
        selectedProvider: vi.fn().mockResolvedValue({
          id: 'mock',
          provider: 'OPENAI_COMPATIBLE',
          baseUrl: 'https://example.invalid',
          model: 'mock',
          apiKey: 'test-only',
        }),
      };
      const queue = { add: vi.fn().mockResolvedValue({ id: 'queued' }) };
      const output = new OutputService(
        prisma as never,
        { get: () => 'Asia/Shanghai' } as never,
        models as never,
        evidence,
        queue as never,
      );
      const snapshots = await Promise.all(Array.from({ length: 12 }, () => output.daily(user.id)));
      expect(new Set(snapshots.map((item) => item?.id)).size).toBe(1);
      const daily = snapshots[0]!;
      expect(daily.targets).toHaveLength(3);
      const clientId = randomUUID();
      const submissions = await Promise.all(
        Array.from({ length: 8 }, () =>
          output.submit(
            user.id,
            daily.id,
            'The effect may affect my plans. I borrow a book.',
            clientId,
            3000,
          ),
        ),
      );
      expect(new Set(submissions.map((row) => row.id)).size).toBe(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      const token = queue.add.mock.calls[0][1].workerToken;
      const id = submissions[0].id;
      const claim = await output.claim(id, token);
      expect(claim.done).toBe(false);
      const occupied = await output.claim(id, token);
      expect(occupied.done).toBe(false);
      expect(occupied.waitUntil).toBeGreaterThan(Date.now());
      expect(occupied).not.toHaveProperty('provider');
      await prisma.outputSubmission.update({
        where: { id },
        data: { processingStartedAt: new Date(Date.now() - 121_000) },
      });
      const recovered = await output.claim(id, token);
      expect(recovered.leaseToken).not.toBe(claim.leaseToken);
      const feedback = {
        grammarScore: 80,
        coherenceScore: 80,
        correctedText: 'The effect may affect my plans. I borrow a book.',
        comments: [],
        words: daily.targets.map((target) => ({
          bookWordId: target.bookWordId,
          used: true,
          correct: true,
          feedback: '搭配正确',
        })),
      };
      const completions = await Promise.allSettled([
        output.complete(id, token, recovered.leaseToken!, feedback),
        output.complete(id, token, recovered.leaseToken!, feedback),
      ]);
      expect(completions.some((result) => result.status === 'fulfilled')).toBe(true);
      expect(
        await prisma.wordReviewAttempt.count({
          where: { userId: user.id, questionType: 'OUTPUT' },
        }),
      ).toBe(3);
      expect(
        await prisma.learningEvent.count({ where: { userId: user.id, type: 'OUTPUT_COMPLETED' } }),
      ).toBe(1);

      const retryClientId = randomUUID();
      const retryAnswer = 'The effect can affect my plans. I borrow a book.';
      const retryQueue = {
        add: vi
          .fn()
          .mockRejectedValueOnce(new Error('isolated queue outage'))
          .mockRejectedValueOnce(new Error('isolated queue outage'))
          .mockResolvedValueOnce({ id: 'recovered' }),
      };
      const retryOutput = new OutputService(
        prisma as never,
        { get: () => 'Asia/Shanghai' } as never,
        models as never,
        evidence,
        retryQueue as never,
      );
      const attemptsBeforeRetry = await prisma.wordReviewAttempt.count({
        where: { userId: user.id, questionType: 'OUTPUT' },
      });
      const eventsBeforeRetry = await prisma.learningEvent.count({
        where: { userId: user.id, type: 'OUTPUT_COMPLETED' },
      });
      await expect(
        retryOutput.submit(user.id, daily.id, retryAnswer, retryClientId, 4200),
      ).rejects.toMatchObject({ status: 503 });
      const firstFailed = await prisma.outputSubmission.findUniqueOrThrow({
        where: {
          challengeId_clientRequestId: { challengeId: daily.id, clientRequestId: retryClientId },
        },
      });
      expect(firstFailed.status).toBe('FAILED');

      await expect(
        retryOutput.submit(user.id, daily.id, retryAnswer, retryClientId, 4200),
      ).rejects.toMatchObject({ status: 503 });
      const secondFailed = await prisma.outputSubmission.findUniqueOrThrow({
        where: { id: firstFailed.id },
      });
      expect(secondFailed.status).toBe('FAILED');
      expect(secondFailed.answer).toBe(retryAnswer);
      expect(secondFailed.responseTimeMs).toBe(4200);
      expect(secondFailed.workerTokenHash).not.toBe(firstFailed.workerTokenHash);

      const retries = await Promise.all([
        retryOutput.submit(user.id, daily.id, retryAnswer, retryClientId, 4200),
        retryOutput.submit(user.id, daily.id, retryAnswer, retryClientId, 4200),
      ]);
      expect(new Set(retries.map((row) => row.id)).size).toBe(1);
      expect(retries.map((row) => row.status)).toEqual(['QUEUED', 'QUEUED']);
      expect(retryQueue.add).toHaveBeenCalledTimes(3);
      const retryJobIds = retryQueue.add.mock.calls.map((call) => call[2].jobId);
      expect(new Set(retryJobIds).size).toBe(3);
      const retried = await prisma.outputSubmission.findUniqueOrThrow({
        where: { id: firstFailed.id },
      });
      expect(retried.status).toBe('QUEUED');
      expect(retried.answer).toBe(retryAnswer);
      expect(retried.workerTokenHash).not.toBe(secondFailed.workerTokenHash);
      const staleWorkerToken = retryQueue.add.mock.calls[0][1].workerToken;
      const auditsBeforeStaleJob = await prisma.aiCallAudit.count({
        where: { userId: user.id, purpose: 'daily-output' },
      });
      await expect(retryOutput.claim(firstFailed.id, staleWorkerToken)).rejects.toThrow();
      expect(
        await prisma.aiCallAudit.count({ where: { userId: user.id, purpose: 'daily-output' } }),
      ).toBe(auditsBeforeStaleJob);

      const expiredId = randomUUID();
      await prisma.outputSubmission.create({
        data: {
          challengeId: daily.id,
          clientRequestId: expiredId,
          answer: retryAnswer,
          status: 'FAILED',
          workerTokenHash: 'expired-fixture',
          createdAt: new Date(Date.now() - 16 * 60_000),
        },
      });
      const expiredReplay = await retryOutput.submit(
        user.id,
        daily.id,
        retryAnswer,
        expiredId,
        4200,
      );
      expect(expiredReplay.status).toBe('FAILED');
      expect(retryQueue.add).toHaveBeenCalledTimes(3);
      expect(
        await prisma.wordReviewAttempt.count({
          where: { userId: user.id, questionType: 'OUTPUT' },
        }),
      ).toBe(attemptsBeforeRetry);
      expect(
        await prisma.learningEvent.count({ where: { userId: user.id, type: 'OUTPUT_COMPLETED' } }),
      ).toBe(eventsBeforeRetry);

      const contrast = new ConfusionService(prisma as never, evidence);
      const answers = ['effect', 'effect', 'affect', 'effect'].map((selected, index) => ({
        questionId: `affect-effect-${index + 1}`,
        selected,
      }));
      const contrastId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          contrast.submit(user.id, 'affect-effect', answers, contrastId, 4000),
        ),
      );
      expect(new Set(results.map((row) => row.id)).size).toBe(1);
      expect(results[0].correctCount).toBe(3);
      const groups = await contrast.list(user.id);
      expect(groups.find((group) => group.id === 'affect-effect')?.practiced).toBe(true);
      expect(groups.filter((group) => group.practiced)).toHaveLength(1);
      expect(
        await prisma.wordReviewAttempt.count({
          where: { userId: user.id, questionType: 'CONFUSION' },
        }),
      ).toBe(2);
      expect(
        await prisma.learningEvent.count({
          where: { userId: user.id, type: 'CONFUSION_COMPLETED' },
        }),
      ).toBe(1);
      expect(
        await prisma.weaknessSignal.count({
          where: { userId: user.id, questionType: 'CONFUSION', status: 'ACTIVE' },
        }),
      ).toBe(1);
      await expect(output.submission('another-user', id)).rejects.toThrow();
      const previousDate = new Date(new Date(daily.date).getTime() - 86_400_000);
      const previous = await prisma.outputChallenge.create({
        data: {
          userId: user.id,
          challengeDate: previousDate,
          prompt: 'Previous output',
          targets: daily.targets,
        },
      });
      await prisma.outputSubmission.create({
        data: {
          challengeId: previous.id,
          clientRequestId: randomUUID(),
          answer: 'An older draft.',
          status: 'FAILED',
          workerTokenHash: 'expired-fixture',
        },
      });
      const history = await output.history(user.id);
      expect(history.items).toHaveLength(1);
      expect(history.items[0].date).toBe(previousDate.toISOString().slice(0, 10));
      expect(history.items[0]).not.toHaveProperty('workerTokenHash');
      expect((await output.history('another-user')).items).toHaveLength(0);

      const firstPracticeWord = await prisma.vocabularyWord.create({
        data: {
          normalized: `practice-first-progress-${fixtureId}`,
          text: 'first-progress',
          meaning: '首次记录进度',
        },
      });
      const firstPracticeBookWord = await prisma.vocabularyBookWord.create({
        data: { bookId: book.id, wordId: firstPracticeWord.id, position: 3 },
      });
      expect(
        await prisma.userWordProgress.findUnique({
          where: {
            userId_bookWordId: { userId: user.id, bookWordId: firstPracticeBookWord.id },
          },
        }),
      ).toBeNull();
      const firstPracticeEvidence = {
        bookWordId: firstPracticeBookWord.id,
        correct: true,
        questionType: 'OUTPUT' as const,
        answer: 'first-progress appears in a sentence.',
        prompt: 'Use first-progress in a sentence.',
        explanation: 'The expression fits this context.',
        expected: 'first-progress',
        responseTimeMs: 900,
      };
      await Promise.all([
        prisma.$transaction((tx) => evidence.record(tx, user.id, [firstPracticeEvidence])),
        prisma.$transaction((tx) => evidence.record(tx, user.id, [firstPracticeEvidence])),
      ]);
      const initializedProgress = await prisma.userWordProgress.findUniqueOrThrow({
        where: {
          userId_bookWordId: { userId: user.id, bookWordId: firstPracticeBookWord.id },
        },
      });
      expect(initializedProgress).toMatchObject({
        totalAttempts: 2,
        correctAttempts: 2,
        reviewCount: 2,
        consecutiveCorrect: 2,
        state: 'REVIEWING',
      });
      expect(
        await prisma.wordReviewAttempt.count({
          where: { userId: user.id, bookWordId: firstPracticeBookWord.id },
        }),
      ).toBe(2);
    } finally {
      await prisma.wordReviewAttempt.deleteMany({ where: { userId: user.id } });
      await prisma.aiCallAudit.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    }
  }, 30_000);

  it('keeps newer weakness corrections when an older ignore request finishes late', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.PRACTICE_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `weakness-status-${fixtureId}@example.invalid`,
        passwordHash: 'isolated-test-fixture',
      },
    });
    const anotherUser = await prisma.user.create({
      data: {
        email: `weakness-status-other-${fixtureId}@example.invalid`,
        passwordHash: 'isolated-test-fixture',
      },
    });
    let bookId: string | undefined;
    try {
      const book = await prisma.vocabularyBook.create({
        data: {
          ownerId: user.id,
          kind: 'PERSONAL',
          sourceKey: fixtureId,
          title: 'Weakness status race test',
          sourcePath: 'test',
          category: 'GENERAL',
        },
      });
      bookId = book.id;
      const words = await Promise.all(
        ['resolved', 'reactivated'].map((text) =>
          prisma.vocabularyWord.create({
            data: {
              normalized: `weakness-status-${fixtureId}-${text}`,
              text,
              meaning: '状态竞态测试',
            },
          }),
        ),
      );
      const bookWords = await Promise.all(
        words.map((word, position) =>
          prisma.vocabularyBookWord.create({
            data: { bookId: book.id, wordId: word.id, position },
          }),
        ),
      );
      const now = new Date(Date.now() - 1_000);
      const signals = await Promise.all(
        bookWords.map((bookWord) =>
          prisma.weaknessSignal.create({
            data: {
              userId: user.id,
              bookWordId: bookWord.id,
              questionType: 'MEANING_RECOGNITION',
              status: 'ACTIVE',
              wrongCount: 1,
              consecutiveCorrect: 1,
              lastWrongAt: now,
              lastAttemptAt: now,
            },
          }),
        ),
      );
      const mistakes = new MistakesService(prisma as never);
      await expect(mistakes.setStatus(anotherUser.id, signals[0].id, 'IGNORED')).rejects.toThrow(
        '薄弱项不存在',
      );
      expect(
        await prisma.weaknessSignal.findUniqueOrThrow({ where: { id: signals[0].id } }),
      ).toMatchObject({ status: 'ACTIVE', consecutiveCorrect: 1 });

      const pauseStatusRequestAfterRead = (signalId: string) => {
        let markRead!: () => void;
        let resume!: () => void;
        const read = new Promise<void>((resolve) => {
          markRead = resolve;
        });
        const paused = new Promise<void>((resolve) => {
          resume = resolve;
        });
        let firstReadPaused = false;
        const delayedPrisma = {
          weaknessSignal: {
            findFirst: async (args: { where?: { id?: string } }) => {
              const current = await prisma.weaknessSignal.findFirst(args as never);
              if (!firstReadPaused && args.where?.id === signalId) {
                firstReadPaused = true;
                markRead();
                await paused;
              }
              return current;
            },
            updateManyAndReturn: (args: never) => prisma.weaknessSignal.updateManyAndReturn(args),
          },
        };
        return {
          service: new MistakesService(delayedPrisma as never),
          read,
          resume,
        };
      };

      const delayedResolution = pauseStatusRequestAfterRead(signals[0].id);
      const staleIgnore = delayedResolution.service.setStatus(user.id, signals[0].id, 'IGNORED');
      await delayedResolution.read;
      await prisma.$transaction((tx) =>
        mistakes.recordAttempt(tx, {
          userId: user.id,
          bookWordId: bookWords[0].id,
          questionType: 'MEANING_RECOGNITION',
          isCorrect: true,
          at: new Date(),
        }),
      );
      delayedResolution.resume();
      await expect(staleIgnore).rejects.toThrow('已纠正的薄弱项不能手动修改状态');
      expect(
        await prisma.weaknessSignal.findUniqueOrThrow({ where: { id: signals[0].id } }),
      ).toMatchObject({ status: 'RESOLVED', consecutiveCorrect: 2, ignoredAt: null });

      const delayedReactivation = pauseStatusRequestAfterRead(signals[1].id);
      const staleIgnoreAfterError = delayedReactivation.service.setStatus(
        user.id,
        signals[1].id,
        'IGNORED',
      );
      await delayedReactivation.read;
      await prisma.$transaction((tx) =>
        mistakes.recordAttempt(tx, {
          userId: user.id,
          bookWordId: bookWords[1].id,
          questionType: 'MEANING_RECOGNITION',
          isCorrect: false,
          at: new Date(),
        }),
      );
      delayedReactivation.resume();
      await expect(staleIgnoreAfterError).rejects.toThrow('薄弱项刚有新的作答，请刷新错题本后重试');
      expect(
        await prisma.weaknessSignal.findUniqueOrThrow({ where: { id: signals[1].id } }),
      ).toMatchObject({
        status: 'ACTIVE',
        wrongCount: 2,
        consecutiveCorrect: 0,
        ignoredAt: null,
      });

      expect(await mistakes.setStatus(user.id, signals[1].id, 'IGNORED')).toMatchObject({
        status: 'IGNORED',
        wrongCount: 2,
        ignoredAt: expect.any(Date),
      });
      expect(await mistakes.setStatus(user.id, signals[1].id, 'ACTIVE')).toMatchObject({
        status: 'ACTIVE',
        wrongCount: 2,
        ignoredAt: null,
      });
    } finally {
      await prisma.weaknessSignal.deleteMany({ where: { userId: user.id } });
      if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
      await prisma.vocabularyWord.deleteMany({
        where: { normalized: { startsWith: `weakness-status-${fixtureId}-` } },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.user.delete({ where: { id: anotherUser.id } });
      await prisma.$disconnect();
    }
  }, 30_000);
});
