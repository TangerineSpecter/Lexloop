import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WeeklyPrescription } from '@lexloop/types';
import { PrismaService } from '../../prisma/prisma.service';
import { CONFUSION_CATALOG } from './confusion.catalog';
import { practiceDate, practiceDayStart, practiceWeek, weeklyActions } from './practice.rules';

@Injectable()
export class WeeklyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  async prescription(userId: string): Promise<WeeklyPrescription> {
    const timezone = this.config.get<string>('APP_TIMEZONE') ?? 'Asia/Shanghai';
    const date = practiceDate(new Date(), timezone);
    const week = practiceWeek(date);
    const start = practiceDayStart(new Date(Date.now() - 6 * 86_400_000), timezone);
    const [attempts, correct, dueReviews, weaknesses, outputs, contrasts, top] = await Promise.all([
      this.prisma.wordReviewAttempt.count({ where: { userId, createdAt: { gte: start } } }),
      this.prisma.wordReviewAttempt.count({
        where: { userId, createdAt: { gte: start }, isCorrect: true },
      }),
      this.prisma.userWordProgress.count({
        where: {
          userId,
          state: { in: ['LEARNING', 'REVIEWING'] },
          nextReviewAt: { lte: new Date() },
        },
      }),
      this.prisma.weaknessSignal.count({ where: { userId, status: 'ACTIVE' } }),
      this.prisma.outputSubmission.count({
        where: {
          challenge: {
            userId,
            challengeDate: { gte: new Date(practiceDate(start, timezone).getTime() - 86_400_000) },
          },
          status: 'COMPLETED',
          completedAt: { gte: start },
        },
      }),
      this.prisma.confusionAttempt.count({ where: { userId, createdAt: { gte: start } } }),
      this.prisma.weaknessSignal.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: { wrongCount: 'desc' },
        take: 30,
        select: { bookWord: { select: { word: { select: { normalized: true } } } } },
      }),
    ]);
    const days = await this.prisma.$queryRaw<Array<{ day: string }>>`
      SELECT DISTINCT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day
      FROM (
        SELECT "createdAt" FROM "WordReviewAttempt" WHERE "userId" = ${userId} AND "createdAt" >= ${start}
        UNION ALL SELECT "createdAt" FROM "LearningEvent" WHERE "userId" = ${userId} AND "createdAt" >= ${start} AND "type" IN ('OUTPUT_COMPLETED', 'CONFUSION_COMPLETED', 'READING_COMPLETED', 'GRAMMAR_COMPLETED', 'MICRO_STORY_COMPLETED')
        UNION ALL SELECT "completedAt" AS "createdAt" FROM "ScenarioSession" WHERE "userId" = ${userId} AND "completedAt" >= ${start}
        UNION ALL SELECT "completedAt" AS "createdAt" FROM "AssessmentAttempt" WHERE "userId" = ${userId} AND "completedAt" >= ${start}
      ) activity
      LIMIT 8
    `;
    const activeDays = days.length;
    const summary = {
      attempts,
      accuracy: attempts ? Math.round((correct / attempts) * 100) : null,
      dueReviews,
      weaknesses,
      outputs,
      contrasts,
      activeDays,
    };
    const weakWords = new Set(top.map((row) => row.bookWord.word.normalized));
    const suggestedGroup = CONFUSION_CATALOG.find((group) =>
      group.words.some((word) => weakWords.has(word.word)),
    )?.id;
    return {
      weekStart: week.start,
      weekEnd: week.end,
      evidenceStart: practiceDate(start, timezone).toISOString().slice(0, 10),
      evidenceEnd: date.toISOString().slice(0, 10),
      summary,
      actions: weeklyActions(summary, suggestedGroup),
    };
  }
}
