import { Injectable, NotFoundException } from '@nestjs/common';
import { VocabularyCategory } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const categoryLabels: Record<VocabularyCategory, string> = {
  PRIMARY: '小学', JUNIOR: '初中', SENIOR: '高中', COLLEGE: '大学', EXAM: '考试', MATERIAL: '教材', PHRASES: '词组', GENERAL: '其他',
};

@Injectable()
export class VocabularyService {
  constructor(private readonly prisma: PrismaService) {}

  async listSystemBooks(userId: string, category?: string) {
    const selected = category && Object.values(VocabularyCategory).includes(category as VocabularyCategory) ? category as VocabularyCategory : undefined;
    const [books, categories] = await Promise.all([
      this.prisma.vocabularyBook.findMany({
        where: { isActive: true, ...(selected ? { category: selected } : {}) },
        orderBy: [{ category: 'asc' }, { title: 'asc' }],
        include: { _count: { select: { bookWords: true } }, userBooks: { where: { userId }, select: { isDefault: true } }, },
      }),
      this.prisma.vocabularyBook.groupBy({ by: ['category'], where: { isActive: true }, _count: { _all: true } }),
    ]);
    return {
      categories: categories.sort((a, b) => categoryLabels[a.category].localeCompare(categoryLabels[b.category], 'zh-CN')).map((item) => ({ key: item.category, label: categoryLabels[item.category], count: item._count._all })),
      books: books.map((book) => ({ id: book.id, category: book.category, title: book.title, totalWords: book._count.bookWords, learnedWords: 0, isLearning: book.userBooks.length > 0, isDefault: book.userBooks[0]?.isDefault ?? false })),
    };
  }

  async listLearningBooks(userId: string) {
    const books = await this.prisma.userVocabularyBook.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { lastStudiedAt: 'desc' }], include: { book: { include: { _count: { select: { bookWords: true } } } } } });
    return books.map((item) => ({ id: item.book.id, category: item.book.category, title: item.book.title, totalWords: item.book._count.bookWords, learnedWords: 0, isLearning: true, isDefault: item.isDefault, startedAt: item.startedAt, lastStudiedAt: item.lastStudiedAt }));
  }

  async getDefaultBook(userId: string) {
    const item = await this.prisma.userVocabularyBook.findFirst({ where: { userId, isDefault: true }, include: { book: { include: { _count: { select: { bookWords: true } } } } } });
    return item ? { id: item.book.id, title: item.book.title, totalWords: item.book._count.bookWords } : null;
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
