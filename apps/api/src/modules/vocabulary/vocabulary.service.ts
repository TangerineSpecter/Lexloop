import { Injectable, NotFoundException } from '@nestjs/common';
import { VocabularyCategory, WordProgressState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const categoryLabels: Record<VocabularyCategory, string> = {
  PRIMARY: '小学', JUNIOR: '初中', SENIOR: '高中', COLLEGE: '大学', EXAM: '考试', MATERIAL: '教材', PHRASES: '词组', GENERAL: '其他',
};

@Injectable()
export class VocabularyService {
  constructor(private readonly prisma: PrismaService) {}

  async listSystemBooks(userId: string, category?: string) {
    const selected = category && Object.values(VocabularyCategory).includes(category as VocabularyCategory) ? category as VocabularyCategory : undefined;
    const availableToUser = { userBooks: { none: { userId } } };
    const [books, categories] = await Promise.all([
      this.prisma.vocabularyBook.findMany({
        where: { isActive: true, ...availableToUser, ...(selected ? { category: selected } : {}) },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
        include: { _count: { select: { bookWords: true } }, userBooks: { where: { userId }, select: { isDefault: true } }, },
      }),
      this.prisma.vocabularyBook.groupBy({ by: ['category'], where: { isActive: true, ...availableToUser }, _count: { _all: true } }),
    ]);
    return {
      categories: categories.sort((a, b) => categoryLabels[a.category].localeCompare(categoryLabels[b.category], 'zh-CN')).map((item) => ({ key: item.category, label: categoryLabels[item.category], count: item._count._all })),
      books: books.map((book) => ({
        id: book.id,
        category: book.category,
        categoryLabel: categoryLabels[book.category],
        title: book.title,
        publisher: book.publisher,
        grade: book.grade,
        totalWords: book._count.bookWords,
        learnedWords: 0,
        isLearning: book.userBooks.length > 0,
        isDefault: book.userBooks[0]?.isDefault ?? false,
      })),
    };
  }

  async listLearningBooks(userId: string) {
    const books = await this.prisma.userVocabularyBook.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { lastStudiedAt: 'desc' }], include: { book: { include: { _count: { select: { bookWords: true } } } } } });
    return books.map((item) => ({
      id: item.book.id,
      category: item.book.category,
      categoryLabel: categoryLabels[item.book.category],
      title: item.book.title,
      publisher: item.book.publisher,
      grade: item.book.grade,
      totalWords: item.book._count.bookWords,
      learnedWords: 0,
      isLearning: true,
      isDefault: item.isDefault,
      startedAt: item.startedAt,
      lastStudiedAt: item.lastStudiedAt,
    }));
  }

  async getDefaultBook(userId: string) {
    const item = await this.prisma.userVocabularyBook.findFirst({ where: { userId, isDefault: true }, include: { book: { include: { _count: { select: { bookWords: true } } } } } });
    return item ? { id: item.book.id, title: item.book.title, totalWords: item.book._count.bookWords } : null;
  }

  async getProgressSummary(userId: string) {
    const item = await this.prisma.userVocabularyBook.findFirst({
      where: { userId, isDefault: true },
      include: { book: { include: { bookWords: { select: { wordId: true } }, _count: { select: { bookWords: true } } } } },
    });
    if (!item) return { totalWords: 0, masteredWords: 0, progress: 0 };
    const masteredWords = await this.prisma.userMasteredWord.count({
      where: { userId, wordId: { in: item.book.bookWords.map(word => word.wordId) } },
    });
    const totalWords = item.book._count.bookWords;
    return {
      totalWords,
      masteredWords,
      progress: totalWords ? Math.round(masteredWords / totalWords * 1000) / 10 : 0,
    };
  }

  async clearLearningRecords(userId: string) {
    const [plans, progresses, masteredWords, learningEvents] = await this.prisma.$transaction([
      this.prisma.studyPlan.deleteMany({ where: { userId } }),
      this.prisma.userWordProgress.deleteMany({ where: { userId } }),
      this.prisma.userMasteredWord.deleteMany({ where: { userId } }),
      this.prisma.learningEvent.deleteMany({ where: { userId } }),
    ]);
    return {
      success: true,
      cleared: {
        plans: plans.count,
        wordProgresses: progresses.count,
        masteredWords: masteredWords.count,
        learningEvents: learningEvents.count,
      },
    };
  }

  async listMasteredWords(userId: string) {
    const masteredWords = await this.prisma.userMasteredWord.findMany({
      where: { userId },
      orderBy: { masteredAt: 'desc' },
      include: { word: true },
    });
    return masteredWords.map((item) => ({
      id: item.wordId,
      word: item.word.text,
      part: this.getPartOfSpeech(item.word.meaning),
      meaning: this.getMeaning(item.word.meaning),
      masteredAt: item.masteredAt,
    }));
  }

  async listLearningWords(userId: string) {
    const progresses = await this.prisma.userWordProgress.findMany({
      where: { userId, state: { in: [WordProgressState.LEARNING, WordProgressState.REVIEWING] }, bookWord: { book: { userBooks: { some: { userId } } } } },
      orderBy: [{ nextReviewAt: 'asc' }, { lastReviewedAt: 'desc' }],
      include: { bookWord: { include: { word: true, book: { select: { title: true } } } } },
    });
    return progresses.map(progress => {
      const accuracy = progress.totalAttempts ? Math.round(progress.correctAttempts / progress.totalAttempts * 100) : 0;
      const reinforcement = progress.reviewCount >= 4 && accuracy < 60 ? '重点巩固' : accuracy < 70 && progress.totalAttempts > 0 ? '需巩固' : '稳定学习';
      return { ...this.toDashboardWord(progress.bookWord), state: progress.state, accuracy, reinforcement, reviewCount: progress.reviewCount, lastReviewedAt: progress.lastReviewedAt, nextReviewAt: progress.nextReviewAt, bookTitle: progress.bookWord.book.title };
    });
  }

  async removeMasteredWord(userId: string, wordId: string) {
    await this.prisma.$transaction([
      this.prisma.userMasteredWord.deleteMany({ where: { userId, wordId } }),
      this.prisma.userWordProgress.deleteMany({ where: { userId, state: WordProgressState.MASTERED, bookWord: { wordId } } }),
    ]);
    return { success: true };
  }

  async getDashboardWords(userId: string, requestedNewWordCount?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultNewWordCount: true } });
    const parsedCount = Number(requestedNewWordCount);
    const newWordCount = Number.isInteger(parsedCount) ? Math.min(100, Math.max(1, parsedCount)) : user.defaultNewWordCount;
    const [reviewProgresses, defaultBook] = await Promise.all([
      this.prisma.userWordProgress.findMany({
        where: { userId, state: WordProgressState.REVIEWING, nextReviewAt: { lte: new Date() } },
        orderBy: [{ nextReviewAt: 'asc' }, { lastReviewedAt: 'asc' }],
        include: { bookWord: { include: { word: true } } },
      }),
      this.prisma.userVocabularyBook.findFirst({ where: { userId, isDefault: true }, select: { bookId: true } }),
    ]);
    const newBookWords = defaultBook ? await this.prisma.vocabularyBookWord.findMany({
      where: {
        bookId: defaultBook.bookId,
        progress: { none: { userId } },
        word: { masteredBy: { none: { userId } } },
      },
      orderBy: { position: 'asc' },
      take: newWordCount,
      include: { word: true },
    }) : [];
    return {
      defaultNewWordCount: user.defaultNewWordCount,
      reviewWords: reviewProgresses.map((progress) => this.toDashboardWord(progress.bookWord)),
      newWords: newBookWords.map((bookWord) => this.toDashboardWord(bookWord)),
    };
  }

  async updateDefaultNewWordCount(userId: string, defaultNewWordCount: number) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { defaultNewWordCount }, select: { defaultNewWordCount: true } });
    return user;
  }

  async addToReview(userId: string, bookWordId: string) {
    const bookWord = await this.prisma.vocabularyBookWord.findFirst({ where: { id: bookWordId, book: { userBooks: { some: { userId } } } } });
    if (!bookWord) throw new NotFoundException('单词不存在');
    await this.prisma.userWordProgress.upsert({
      where: { userId_bookWordId: { userId, bookWordId } },
      create: { userId, bookWordId, state: WordProgressState.REVIEWING, firstLearnedAt: new Date(), nextReviewAt: new Date() },
      update: { state: WordProgressState.REVIEWING, nextReviewAt: new Date() },
    });
    return { success: true };
  }

  async markMastered(userId: string, bookWordId: string) {
    const bookWord = await this.findUserBookWord(userId, bookWordId);
    await this.prisma.$transaction([
      this.prisma.userMasteredWord.upsert({
        where: { userId_wordId: { userId, wordId: bookWord.wordId } },
        create: { userId, wordId: bookWord.wordId },
        update: {},
      }),
      this.prisma.userWordProgress.upsert({
        where: { userId_bookWordId: { userId, bookWordId } },
        create: { userId, bookWordId, state: WordProgressState.MASTERED, firstLearnedAt: new Date() },
        update: { state: WordProgressState.MASTERED, nextReviewAt: null },
      }),
    ]);
    return { success: true };
  }

  async deferNewWord(userId: string, bookWordId: string) {
    await this.findUserBookWord(userId, bookWordId);
    await this.prisma.userWordProgress.upsert({
      where: { userId_bookWordId: { userId, bookWordId } },
      create: { userId, bookWordId, state: WordProgressState.NEW },
      update: { state: WordProgressState.NEW, nextReviewAt: null },
    });
    return { success: true };
  }

  async deferReview(userId: string, bookWordId: string) {
    const progress = await this.prisma.userWordProgress.findUnique({ where: { userId_bookWordId: { userId, bookWordId } } });
    if (!progress || progress.state !== WordProgressState.REVIEWING) throw new NotFoundException('待复习单词不存在');
    const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
    await this.prisma.userWordProgress.update({ where: { id: progress.id }, data: { nextReviewAt: tomorrow, postponedCount: { increment: 1 } } });
    return { success: true, nextReviewAt: tomorrow };
  }

  private async findUserBookWord(userId: string, bookWordId: string) {
    const bookWord = await this.prisma.vocabularyBookWord.findFirst({
      where: { id: bookWordId, book: { userBooks: { some: { userId } } } },
      select: { id: true, wordId: true },
    });
    if (!bookWord) throw new NotFoundException('单词不存在');
    return bookWord;
  }

  private toDashboardWord(bookWord: { id: string; word: { text: string; meaning: string | null } }) {
    return { id: bookWord.id, word: bookWord.word.text, part: this.getPartOfSpeech(bookWord.word.meaning), meaning: this.getMeaning(bookWord.word.meaning) };
  }

  private getPartOfSpeech(meaning: string | null) {
    return meaning?.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i)?.[1] ?? '';
  }

  private getMeaning(meaning: string | null) {
    const rawMeaning = meaning ?? '暂无释义';
    const match = rawMeaning.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i);
    return rawMeaning.slice(match?.[0].length ?? 0);
  }

  async activateBook(userId: string, bookId: string) {
    const book = await this.prisma.vocabularyBook.findFirst({ where: { id: bookId, isActive: true } });
    if (!book) throw new NotFoundException('词表不存在或暂不可用');
    await this.prisma.$transaction(async (tx) => {
      await tx.userVocabularyBook.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      await tx.userVocabularyBook.upsert({ where: { userId_bookId: { userId, bookId } }, create: { userId, bookId, isDefault: true }, update: { isDefault: true, lastStudiedAt: new Date() } });
    });
    return this.getDefaultBook(userId);
  }
}
