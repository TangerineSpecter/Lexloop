import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  CefrLevel,
  LexicalItemType,
  VocabularyBookKind,
  VocabularyCategory,
  WordProgressState,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const categoryLabels: Record<VocabularyCategory, string> = {
  PRIMARY: '小学',
  JUNIOR: '初中',
  SENIOR: '高中',
  COLLEGE: '大学',
  EXAM: '考试',
  MATERIAL: '教材',
  PHRASES: '词组',
  GENERAL: '其他',
};

@Injectable()
export class VocabularyService {
  constructor(private readonly prisma: PrismaService) {}

  async listSystemBooks(userId: string, category?: string) {
    const selected =
      category && Object.values(VocabularyCategory).includes(category as VocabularyCategory)
        ? (category as VocabularyCategory)
        : undefined;
    const availableToUser = { userBooks: { none: { userId } } };
    const [books, categories] = await Promise.all([
      this.prisma.vocabularyBook.findMany({
        where: {
          isActive: true,
          kind: VocabularyBookKind.SYSTEM,
          ownerId: null,
          ...availableToUser,
          ...(selected ? { category: selected } : {}),
        },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
        include: {
          _count: { select: { bookWords: true } },
          userBooks: { where: { userId }, select: { isDefault: true } },
        },
      }),
      this.prisma.vocabularyBook.groupBy({
        by: ['category'],
        where: {
          isActive: true,
          kind: VocabularyBookKind.SYSTEM,
          ownerId: null,
          ...availableToUser,
        },
        _count: { _all: true },
      }),
    ]);
    return {
      categories: categories
        .sort((a, b) =>
          categoryLabels[a.category].localeCompare(categoryLabels[b.category], 'zh-CN'),
        )
        .map((item) => ({
          key: item.category,
          label: categoryLabels[item.category],
          count: item._count._all,
        })),
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
    const books = await this.prisma.userVocabularyBook.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { lastStudiedAt: 'desc' }],
      include: { book: { include: { _count: { select: { bookWords: true } } } } },
    });
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
    const item = await this.prisma.userVocabularyBook.findFirst({
      where: { userId, isDefault: true },
      include: { book: { include: { _count: { select: { bookWords: true } } } } },
    });
    return item
      ? { id: item.book.id, title: item.book.title, totalWords: item.book._count.bookWords }
      : null;
  }

  async getProgressSummary(userId: string) {
    const item = await this.prisma.userVocabularyBook.findFirst({
      where: { userId, isDefault: true },
      include: {
        book: {
          include: {
            bookWords: { select: { wordId: true } },
            _count: { select: { bookWords: true } },
          },
        },
      },
    });
    if (!item) return { totalWords: 0, masteredWords: 0, progress: 0 };
    const masteredWords = await this.prisma.userMasteredWord.count({
      where: { userId, wordId: { in: item.book.bookWords.map((word) => word.wordId) } },
    });
    const totalWords = item.book._count.bookWords;
    return {
      totalWords,
      masteredWords,
      progress: totalWords ? Math.round((masteredWords / totalWords) * 1000) / 10 : 0,
    };
  }

  async clearLearningRecords(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`learning-records:${userId}`}))`,
      );
      await tx.user.update({
        where: { id: userId },
        data: { learningRecordsVersion: { increment: 1 } },
      });
      const personalWords = await tx.vocabularyBookWord.findMany({
        where: { book: { ownerId: userId, kind: VocabularyBookKind.PERSONAL } },
        select: { wordId: true },
      });
      const personalWordIds = [...new Set(personalWords.map((item) => item.wordId))];
      const adventureQuests = await tx.adventureDailyQuest.deleteMany({ where: { userId } });
      const adventureRuns = await tx.dungeonRun.deleteMany({ where: { userId } });
      const adventureFloorProgresses = await tx.userFloorProgress.deleteMany({ where: { userId } });
      const inventoryItems = await tx.inventoryItem.deleteMany({ where: { userId } });
      const adventureProfiles = await tx.adventureProfile.deleteMany({ where: { userId } });
      const plans = await tx.studyPlan.deleteMany({ where: { userId } });
      const weaknesses = await tx.weaknessSignal.deleteMany({ where: { userId } });
      const tutorConversations = await tx.tutorConversation.deleteMany({ where: { userId } });
      const tutorDailyUsages = await tx.tutorDailyUsage.deleteMany({ where: { userId } });
      const travelPlans = await tx.dailyPracticePlan.deleteMany({ where: { userId } });
      const scenarioSessions = await tx.scenarioSession.deleteMany({ where: { userId } });
      const assessments = await tx.assessmentAttempt.deleteMany({ where: { userId } });
      const skillProgresses = await tx.userSkillProgress.deleteMany({ where: { userId } });
      const languageProfiles = await tx.languageProfile.deleteMany({ where: { userId } });
      const scenarioDailyUsages = await tx.scenarioDailyUsage.deleteMany({ where: { userId } });
      const profileSnapshots = await tx.languageProfileSnapshot.deleteMany({ where: { userId } });
      const analysisCache = await tx.learningAnalysisCache.deleteMany({ where: { userId } });
      const progresses = await tx.userWordProgress.deleteMany({ where: { userId } });
      const masteredWords = await tx.userMasteredWord.deleteMany({ where: { userId } });
      const learningEvents = await tx.learningEvent.deleteMany({ where: { userId } });
      const personalBooks = await tx.vocabularyBook.deleteMany({
        where: { ownerId: userId, kind: VocabularyBookKind.PERSONAL },
      });
      const orphanWords = await tx.vocabularyWord.deleteMany({
        where: { id: { in: personalWordIds }, bookWords: { none: {} } },
      });
      const outputs = await tx.outputChallenge.deleteMany({ where: { userId } });
      const contrasts = await tx.confusionAttempt.deleteMany({ where: { userId } });
      const attempts = await tx.wordReviewAttempt.deleteMany({ where: { userId } });
      const labLessons = await tx.labLesson.deleteMany({ where: { userId } });
      const microErrors = await tx.microError.deleteMany({ where: { userId } });
      const microProgress = await tx.microProgress.deleteMany({ where: { userId } });
      return {
        success: true,
        cleared: {
          labLessons: labLessons.count,
          microErrors: microErrors.count,
          microProgress: microProgress.count,
          outputs: outputs.count,
          contrasts: contrasts.count,
          attempts: attempts.count,
          adventureQuests: adventureQuests.count,
          adventureRuns: adventureRuns.count,
          adventureFloorProgresses: adventureFloorProgresses.count,
          inventoryItems: inventoryItems.count,
          adventureProfiles: adventureProfiles.count,
          plans: plans.count,
          weaknesses: weaknesses.count,
          tutorConversations: tutorConversations.count,
          tutorDailyUsages: tutorDailyUsages.count,
          travelPlans: travelPlans.count,
          scenarioSessions: scenarioSessions.count,
          assessments: assessments.count,
          skillProgresses: skillProgresses.count,
          languageProfiles: languageProfiles.count,
          scenarioDailyUsages: scenarioDailyUsages.count,
          profileSnapshots: profileSnapshots.count,
          analysisCache: analysisCache.count,
          wordProgresses: progresses.count,
          masteredWords: masteredWords.count,
          learningEvents: learningEvents.count,
          personalBooks: personalBooks.count,
          orphanWords: orphanWords.count,
        },
      };
    });
  }

  async savePersonalItem(
    userId: string,
    input: {
      text: string;
      type: LexicalItemType;
      meaning: string;
      example: string;
      sourceType?: string;
      sourceScenario?: string;
      cefrLevel?: CefrLevel;
    },
  ) {
    const normalized = input.text.trim().toLowerCase().replace(/\s+/g, ' ');
    const personalNormalized = `personal:${userId}:${normalized}`;
    const text = input.text.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new BadRequestException('要收藏的表达不能为空');
    if (!input.meaning.trim() || !input.example.trim())
      throw new BadRequestException('请填写词义和原句');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`notebook:${userId}`}))`,
      );
      const book = await tx.vocabularyBook.upsert({
        where: { sourceKey: `personal:${userId}:travel` },
        create: {
          sourceKey: `personal:${userId}:travel`,
          sourcePath: `personal://${userId}/travel`,
          category: VocabularyCategory.GENERAL,
          title: '个人生词本',
          kind: VocabularyBookKind.PERSONAL,
          ownerId: userId,
        },
        update: { isActive: true },
      });
      await tx.userVocabularyBook.upsert({
        where: { userId_bookId: { userId, bookId: book.id } },
        create: { userId, bookId: book.id },
        update: { lastStudiedAt: new Date() },
      });
      const word = await tx.vocabularyWord.upsert({
        where: { normalized: personalNormalized },
        create: {
          normalized: personalNormalized,
          meaning: input.meaning.trim(),
          text,
          itemType: input.type,
          cefrLevel: input.cefrLevel,
          spokenPriority: 100,
        },
        update: { text, itemType: input.type, cefrLevel: input.cefrLevel, spokenPriority: 100 },
      });
      const existing = await tx.vocabularyBookWord.findUnique({
        where: { bookId_wordId: { bookId: book.id, wordId: word.id } },
      });
      const last = await tx.vocabularyBookWord.aggregate({
        where: { bookId: book.id },
        _max: { position: true },
      });
      const position = existing?.position ?? (last._max.position ?? 0) + 1;
      const bookWord = await tx.vocabularyBookWord.upsert({
        where: { bookId_wordId: { bookId: book.id, wordId: word.id } },
        create: {
          bookId: book.id,
          wordId: word.id,
          position,
          contextMeaning: input.meaning.trim(),
          sourceScenario: input.sourceScenario?.trim() || null,
          sourceExample: input.example.trim(),
          sourceType: input.sourceType ?? 'TRAVEL',
        },
        update: { isCollected: true },
        include: { word: true },
      });
      await tx.userWordProgress.upsert({
        where: { userId_bookWordId: { userId, bookWordId: bookWord.id } },
        create: {
          userId,
          bookWordId: bookWord.id,
          state: WordProgressState.REVIEWING,
          firstLearnedAt: new Date(),
          nextReviewAt: new Date(),
        },
        update: {},
      });
      return {
        id: bookWord.id,
        wordId: word.id,
        text: word.text,
        type: word.itemType,
        meaning: bookWord.contextMeaning ?? word.meaning,
        example: bookWord.sourceExample,
        sourceScenario: bookWord.sourceScenario,
        addedToReview: true,
      };
    });
  }

  async listPersonalItems(userId: string) {
    const book = await this.prisma.vocabularyBook.findUnique({
      where: { sourceKey: `personal:${userId}:travel` },
    });
    if (!book || book.ownerId !== userId) return [];
    const items = await this.prisma.vocabularyBookWord.findMany({
      where: { bookId: book.id, isCollected: true },
      include: { word: true, progress: { where: { userId }, take: 1 } },
      orderBy: { position: 'desc' },
    });
    return items.map((item) => ({
      id: item.id,
      wordId: item.wordId,
      text: item.word.text,
      type: item.word.itemType,
      level: item.word.cefrLevel,
      meaning: item.contextMeaning ?? item.word.meaning,
      example: item.sourceExample,
      sourceScenario: item.sourceScenario,
      state: item.progress[0]?.state ?? WordProgressState.NEW,
      nextReviewAt: item.progress[0]?.nextReviewAt ?? null,
    }));
  }

  async notebook(userId: string, page: number, search: string, source?: string) {
    const where: Prisma.VocabularyBookWordWhereInput = {
      book: { ownerId: userId, kind: VocabularyBookKind.PERSONAL },
      isCollected: true,
      ...(source ? { sourceType: source } : {}),
      ...(search
        ? {
            OR: [
              { word: { text: { contains: search, mode: 'insensitive' } } },
              { contextMeaning: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.vocabularyBookWord.findMany({
        where,
        skip: (page - 1) * 20,
        take: 21,
        orderBy: [{ position: 'desc' }, { id: 'desc' }],
        include: { word: true, progress: { where: { userId }, take: 1 } },
      }),
      this.prisma.vocabularyBookWord.count({ where }),
    ]);
    return {
      total,
      hasMore: items.length > 20,
      items: items.slice(0, 20).map((item) => ({
        id: item.id,
        wordId: item.wordId,
        text: item.word.text,
        type: item.word.itemType,
        meaning: item.contextMeaning ?? item.word.meaning,
        example: item.sourceExample,
        sourceScenario: item.sourceScenario,
        sourceType: item.sourceType,
        state: item.progress[0]?.state ?? 'NEW',
        nextReviewAt: item.progress[0]?.nextReviewAt ?? null,
      })),
    };
  }

  async removePersonalItem(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`notebook:${userId}`}))`,
      );
      const item = await tx.vocabularyBookWord.findFirst({
        where: { id, book: { ownerId: userId, kind: 'PERSONAL' } },
      });
      if (!item) throw new NotFoundException('收藏词汇不存在');
      await tx.vocabularyBookWord.update({ where: { id }, data: { isCollected: false } });
      return { success: true };
    });
  }

  async clearPersonalItems(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`notebook:${userId}`}))`,
      );
      const book = await tx.vocabularyBook.findFirst({
        where: {
          ownerId: userId,
          kind: VocabularyBookKind.PERSONAL,
          sourceKey: `personal:${userId}:travel`,
        },
        include: { bookWords: { select: { wordId: true } } },
      });
      if (!book) return { success: true, cleared: 0, orphanWords: 0 };
      const wordIds = [...new Set(book.bookWords.map((item) => item.wordId))];
      await tx.vocabularyBook.delete({ where: { id: book.id } });
      const orphanWords = await tx.vocabularyWord.deleteMany({
        where: { id: { in: wordIds }, bookWords: { none: {} } },
      });
      return { success: true, cleared: 1, orphanWords: orphanWords.count };
    });
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
      where: {
        userId,
        state: { in: [WordProgressState.LEARNING, WordProgressState.REVIEWING] },
        bookWord: { book: { userBooks: { some: { userId } } } },
      },
      orderBy: [{ nextReviewAt: 'asc' }, { lastReviewedAt: 'desc' }],
      include: { bookWord: { include: { word: true, book: { select: { title: true } } } } },
    });
    return progresses.map((progress) => {
      const accuracy = progress.totalAttempts
        ? Math.round((progress.correctAttempts / progress.totalAttempts) * 100)
        : 0;
      const reinforcement =
        progress.reviewCount >= 4 && accuracy < 60
          ? '重点巩固'
          : accuracy < 70 && progress.totalAttempts > 0
            ? '需巩固'
            : '稳定学习';
      return {
        ...this.toDashboardWord(progress.bookWord),
        state: progress.state,
        accuracy,
        reinforcement,
        reviewCount: progress.reviewCount,
        lastReviewedAt: progress.lastReviewedAt,
        nextReviewAt: progress.nextReviewAt,
        bookTitle: progress.bookWord.book.title,
      };
    });
  }

  async removeMasteredWord(userId: string, wordId: string) {
    await this.prisma.$transaction([
      this.prisma.userMasteredWord.deleteMany({ where: { userId, wordId } }),
      this.prisma.userWordProgress.deleteMany({
        where: { userId, state: WordProgressState.MASTERED, bookWord: { wordId } },
      }),
    ]);
    return { success: true };
  }

  async getDashboardWords(userId: string, requestedNewWordCount?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { defaultNewWordCount: true },
    });
    const parsedCount = Number(requestedNewWordCount);
    const newWordCount = Number.isInteger(parsedCount)
      ? Math.min(100, Math.max(1, parsedCount))
      : user.defaultNewWordCount;
    const [reviewProgresses, defaultBook] = await Promise.all([
      this.prisma.userWordProgress.findMany({
        where: { userId, state: WordProgressState.REVIEWING, nextReviewAt: { lte: new Date() } },
        orderBy: [{ nextReviewAt: 'asc' }, { lastReviewedAt: 'asc' }],
        include: { bookWord: { include: { word: true } } },
      }),
      this.prisma.userVocabularyBook.findFirst({
        where: { userId, isDefault: true },
        select: { bookId: true },
      }),
    ]);
    const newBookWords = defaultBook
      ? await this.prisma.vocabularyBookWord.findMany({
          where: {
            bookId: defaultBook.bookId,
            progress: { none: { userId } },
            word: { masteredBy: { none: { userId } } },
          },
          orderBy: { position: 'asc' },
          take: newWordCount,
          include: { word: true },
        })
      : [];
    return {
      defaultNewWordCount: user.defaultNewWordCount,
      reviewWords: reviewProgresses.map((progress) => this.toDashboardWord(progress.bookWord)),
      newWords: newBookWords.map((bookWord) => this.toDashboardWord(bookWord)),
    };
  }

  async updateDefaultNewWordCount(userId: string, defaultNewWordCount: number) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { defaultNewWordCount },
      select: { defaultNewWordCount: true },
    });
    return user;
  }

  async addToReview(userId: string, bookWordId: string) {
    const bookWord = await this.prisma.vocabularyBookWord.findFirst({
      where: { id: bookWordId, book: { userBooks: { some: { userId } } } },
    });
    if (!bookWord) throw new NotFoundException('单词不存在');
    await this.prisma.userWordProgress.upsert({
      where: { userId_bookWordId: { userId, bookWordId } },
      create: {
        userId,
        bookWordId,
        state: WordProgressState.REVIEWING,
        firstLearnedAt: new Date(),
        nextReviewAt: new Date(),
      },
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
        create: {
          userId,
          bookWordId,
          state: WordProgressState.MASTERED,
          firstLearnedAt: new Date(),
        },
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
    const progress = await this.prisma.userWordProgress.findUnique({
      where: { userId_bookWordId: { userId, bookWordId } },
    });
    if (!progress || progress.state !== WordProgressState.REVIEWING)
      throw new NotFoundException('待复习单词不存在');
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    await this.prisma.userWordProgress.update({
      where: { id: progress.id },
      data: { nextReviewAt: tomorrow, postponedCount: { increment: 1 } },
    });
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

  private toDashboardWord(bookWord: {
    id: string;
    contextMeaning?: string | null;
    word: { text: string; meaning: string | null };
  }) {
    const meaning = bookWord.contextMeaning ?? bookWord.word.meaning;
    return {
      id: bookWord.id,
      word: bookWord.word.text,
      part: this.getPartOfSpeech(meaning),
      meaning: this.getMeaning(meaning),
    };
  }

  private getPartOfSpeech(meaning: string | null) {
    return (
      meaning?.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i)?.[1] ?? ''
    );
  }

  private getMeaning(meaning: string | null) {
    const rawMeaning = meaning ?? '暂无释义';
    const match = rawMeaning.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i);
    return rawMeaning.slice(match?.[0].length ?? 0);
  }

  async activateBook(userId: string, bookId: string) {
    const book = await this.prisma.vocabularyBook.findFirst({
      where: {
        id: bookId,
        isActive: true,
        OR: [{ kind: VocabularyBookKind.SYSTEM }, { ownerId: userId }],
      },
    });
    if (!book) throw new NotFoundException('词表不存在或暂不可用');
    await this.prisma.$transaction(async (tx) => {
      await tx.userVocabularyBook.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      await tx.userVocabularyBook.upsert({
        where: { userId_bookId: { userId, bookId } },
        create: { userId, bookId, isDefault: true },
        update: { isDefault: true, lastStudiedAt: new Date() },
      });
    });
    return this.getDefaultBook(userId);
  }
}
