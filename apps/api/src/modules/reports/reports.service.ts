import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const DAY = 86_400_000;
type Signal = { word: string; attempts: number; correct: number; familiarity: number; reviewCount: number };

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async statistics(userId: string, days: number) {
    const end = endOfToday();
    const start = new Date(end.getTime() - days * DAY);
    const previousStart = new Date(start.getTime() - days * DAY);
    const [attempts, previousAttempts, progresses, mastered, allMastered] = await Promise.all([
      this.prisma.wordReviewAttempt.findMany({
        where: { userId, createdAt: { gte: start, lt: end } },
        include: { item: { include: { bookWord: { include: { word: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.wordReviewAttempt.count({ where: { userId, createdAt: { gte: previousStart, lt: start } } }),
      this.prisma.userWordProgress.findMany({
        where: { userId },
        include: { bookWord: { include: { word: true } } },
      }),
      this.prisma.userMasteredWord.count({ where: { userId, masteredAt: { gte: start, lt: end } } }),
      this.prisma.userMasteredWord.count({ where: { userId } }),
    ]);
    const activity = Array.from({ length: days }, (_, index) => {
      const date = new Date(start.getTime() + index * DAY);
      const next = new Date(date.getTime() + DAY);
      const daily = attempts.filter(attempt => attempt.createdAt >= date && attempt.createdAt < next);
      return {
        label: `${date.getMonth() + 1} 月 ${date.getDate()} 日`,
        words: new Set(daily.map(attempt => attempt.bookWordId)).size,
        today: index === days - 1,
      };
    });
    const chart = days === 7
      ? activity.map((day, index) => ({ ...day, label: index === 6 ? '今天' : weekDay(new Date(start.getTime() + index * DAY)), completed: day.words > 0 }))
      : Array.from({ length: 10 }, (_, index) => {
        const slice = activity.slice(index * 3, index * 3 + 3);
        return { label: index === 9 ? '至今' : `${index * 3 + 1}–${index * 3 + 3}`, words: slice.reduce((sum, day) => sum + day.words, 0), completed: slice.some(day => day.words > 0), today: index === 9 };
      });
    const activeDays = activity.filter(day => day.words > 0).length;
    const totalWords = activity.reduce((sum, day) => sum + day.words, 0);
    const previousWords = previousAttempts;
    const newWords = progresses.filter(progress => progress.firstLearnedAt && progress.firstLearnedAt >= start && progress.firstLearnedAt < end).length;
    const signals = signalRows(progresses, attempts);
    const streak = await this.currentStreak(userId);
    return {
      activeDays,
      activity,
      chart,
      currentStreak: streak,
      learnedWords: progresses.filter(progress => progress.firstLearnedAt).length,
      masteredWords: mastered,
      totalMasteredWords: allMastered,
      newWords,
      reviewWords: attempts.length,
      versusPrevious: previousWords ? Math.round((attempts.length - previousWords) / previousWords * 100) : attempts.length ? 100 : 0,
      summary: activeDays ? `本期有 ${activeDays} 天完成学习，共练习 ${attempts.length} 道题。` : '本期还没有学习记录。',
      suggestion: signals.unfamiliar[0] ? `建议优先巩固 ${signals.unfamiliar[0].word}，它目前的陌生程度最高。` : '从一个单词开始，建立今天的学习节奏。',
      rankings: signals,
    };
  }

  private async currentStreak(userId: string) {
    const attempts = await this.prisma.wordReviewAttempt.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - 366 * DAY) } },
      select: { createdAt: true },
    });
    const days = new Set(attempts.map(attempt => dateKey(attempt.createdAt)));
    let cursor = new Date();
    if (!days.has(dateKey(cursor))) cursor = new Date(cursor.getTime() - DAY);
    let streak = 0;
    while (days.has(dateKey(cursor))) {
      streak++;
      cursor = new Date(cursor.getTime() - DAY);
    }
    return streak;
  }
}

function signalRows(
  progresses: Array<{ bookWordId: string; familiarity: number; reviewCount: number; totalAttempts: number; correctAttempts: number; bookWord: { word: { text: string } } }>,
  attempts: Array<{ bookWordId: string; isCorrect: boolean }>,
) {
  const rows: Signal[] = progresses.map(progress => {
    const rangeAttempts = attempts.filter(attempt => attempt.bookWordId === progress.bookWordId);
    return {
      word: progress.bookWord.word.text,
      attempts: rangeAttempts.length,
      correct: rangeAttempts.filter(attempt => attempt.isCorrect).length,
      familiarity: progress.familiarity,
      reviewCount: progress.reviewCount,
    };
  });
  const withAttempts = rows.filter(row => row.attempts > 0);
  const rate = (row: Signal) => row.attempts ? row.correct / row.attempts * 100 : 0;
  return {
    reviews: [...rows].filter(row => row.reviewCount > 0).sort((a, b) => b.reviewCount - a.reviewCount).slice(0, 5).map(row => ({ word: row.word, count: row.reviewCount })),
    unfamiliar: [...rows].sort((a, b) => a.familiarity - b.familiarity).slice(0, 5).reverse().map(row => ({ word: row.word, rate: 100 - row.familiarity })),
    errorRate: [...withAttempts].sort((a, b) => rate(a) - rate(b)).slice(0, 10).map(row => ({ word: row.word, rate: 100 - rate(row) })),
    accuracy: [...withAttempts].sort((a, b) => rate(b) - rate(a)).slice(0, 10).map(row => ({ word: row.word, rate: rate(row) })),
  };
}

function endOfToday() { const date = new Date(); date.setHours(24, 0, 0, 0); return date; }
function dateKey(date: Date) { return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; }
function weekDay(date: Date) { return `周${'日一二三四五六'[date.getDay()]}`; }
