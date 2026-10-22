import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MistakesService } from '../mistakes/mistakes.service';
import { reviewSchedule } from '../study/review-scheduling';

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
    for (const item of [...evidence].sort((a, b) => a.bookWordId.localeCompare(b.bookWordId))) {
      const word = await tx.vocabularyBookWord.findFirst({
        where: {
          id: item.bookWordId,
          book: {
            isActive: true,
            OR: [{ ownerId: userId }, { kind: 'SYSTEM', userBooks: { some: { userId } } }],
          },
        },
      });
      if (!word) continue;
      const now = new Date();
      const progress = await tx.userWordProgress.upsert({
        where: { userId_bookWordId: { userId, bookWordId: item.bookWordId } },
        create: { userId, bookWordId: item.bookWordId, firstLearnedAt: now, state: 'LEARNING' },
        update: {},
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
