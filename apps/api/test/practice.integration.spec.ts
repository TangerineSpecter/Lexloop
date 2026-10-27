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
    } finally {
      await prisma.wordReviewAttempt.deleteMany({ where: { userId: user.id } });
      await prisma.aiCallAudit.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    }
  }, 30_000);
});
