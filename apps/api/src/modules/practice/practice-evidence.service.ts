import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MistakesService } from '../mistakes/mistakes.service';
import { reviewSchedule } from '../study/review-scheduling';
import { lockUserWordProgress } from '../study/user-word-progress-lock';

export type PracticeEvidence = {
  bookWordId: string;
  correct: boolean;
  questionType: 'OUTPUT' | 'CONFUSION';
  answer: string;
  prompt: string;
  explanation: string;
  expected: string;
  responseTimeMs: number;
};
@Injectable()
export class PracticeEvidenceService {
  constructor(private readonly mistakes: MistakesService) {}
  async record(tx: Prisma.TransactionClient, userId: string, evidence: PracticeEvidence[]) {
    const orderedEvidence = [...evidence].sort((left, right) =>
      left.bookWordId < right.bookWordId ? -1 : left.bookWordId > right.bookWordId ? 1 : 0,
    );
    const eligibleWords = await tx.vocabularyBookWord.findMany({
      where: {
        id: { in: orderedEvidence.map((item) => item.bookWordId) },
        book: {
          isActive: true,
          OR: [{ ownerId: userId }, { kind: 'SYSTEM', userBooks: { some: { userId } } }],
        },
      },
      select: { id: true },
    });
    const eligibleWordIds = new Set(eligibleWords.map((word) => word.id));
    const progressCreatedAt = new Date();
    const eligibleEvidence = orderedEvidence.filter((item) => eligibleWordIds.has(item.bookWordId));
    await tx.userWordProgress.createMany({
      data: eligibleEvidence.map((item) => ({
        userId,
        bookWordId: item.bookWordId,
        firstLearnedAt: progressCreatedAt,
        state: 'LEARNING',
      })),
      skipDuplicates: true,
    });
    await lockUserWordProgress(
      tx,
      userId,
      eligibleEvidence.map((item) => item.bookWordId),
    );
    for (const item of orderedEvidence) {
      if (!eligibleWordIds.has(item.bookWordId)) continue;
      const now = new Date();
      const progress = await tx.userWordProgress.findUniqueOrThrow({
        where: { userId_bookWordId: { userId, bookWordId: item.bookWordId } },
      });
      await tx.wordReviewAttempt.create({
        data: {
          userId,
          bookWordId: item.bookWordId,
          questionType: item.questionType,
          isCorrect: item.correct,
          responseTimeMs: item.responseTimeMs,
          selectedAnswer: {
            answer: item.answer,
            question: {
              prompt: item.prompt,
              correctAnswers: [item.expected],
              explanation: item.explanation,
            },
          },
        },
      });
      await this.mistakes.recordAttempt(tx, {
        userId,
        bookWordId: item.bookWordId,
        questionType: item.questionType,
        isCorrect: item.correct,
      });
      if (progress.state !== 'MASTERED')
        await tx.userWordProgress.update({
          where: { id: progress.id },
          data: reviewSchedule(progress, item.correct, now),
        });
    }
  }
}
