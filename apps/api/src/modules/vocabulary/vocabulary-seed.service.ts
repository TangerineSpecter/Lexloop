import { reviewedSupplementMeaning } from './supplement-meanings';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { VocabularyCategory } from '@prisma/client';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import * as XLSX from 'xlsx';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhonetic } from './lexical';
import { importVersionedVocabularyBook } from './versioned-vocabulary-import';
import {
  DAILY_SOURCE_KEY,
  DAILY_BOUNDARY_REVISION,
  repairDailyBoundaries,
} from './daily-vocabulary-boundaries';

type ImportedWord = {
  normalized: string;
  text: string;
  ukPhonetic: string | null;
  usPhonetic: string | null;
  meaning: string | null;
};
export type ImportedBook = {
  sourceKey: string;
  sourcePath: string;
  sourceRevision?: string;
  category: VocabularyCategory;
  title: string;
  publisher: string | null;
  grade: string | null;
  words: ImportedWord[];
};

const categoryByDirectory: Record<string, VocabularyCategory> = {
  小学: VocabularyCategory.PRIMARY,
  初中: VocabularyCategory.JUNIOR,
  高中: VocabularyCategory.SENIOR,
  大学: VocabularyCategory.COLLEGE,
  考试: VocabularyCategory.EXAM,
  教材: VocabularyCategory.MATERIAL,
  专项: VocabularyCategory.PHRASES,
  通用: VocabularyCategory.GENERAL,
};
const curriculumCategories = new Set<VocabularyCategory>([
  VocabularyCategory.PRIMARY,
  VocabularyCategory.JUNIOR,
  VocabularyCategory.SENIOR,
]);

@Injectable()
export class VocabularySeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VocabularySeedService.name);
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    const root = this.resolveAssetRoot();
    if (!root) {
      this.logger.warn('未找到内置词表目录，跳过词表初始化。');
      return;
    }
    await this.importVocabulary(root);
  }

  private resolveAssetRoot() {
    const candidates = [
      resolve(process.cwd(), 'assets/vocabulary'),
      resolve(process.cwd(), 'apps/api/assets/vocabulary'),
      // `nest build` copies assets to `dist/assets`; compiled modules live in
      // `dist/modules/vocabulary`.
      resolve(__dirname, '../../assets/vocabulary'),
      resolve(__dirname, '../../../assets/vocabulary'),
    ];
    return candidates.find((path) => existsSync(path));
  }

  private async importVocabulary(root: string) {
    const parsedBooks = this.findFiles(root)
      .map((file) => this.readBook(root, file))
      .filter((book): book is ImportedBook => book !== null);
    const books = parsedBooks.filter((book) => !book.sourceRevision);
    const versionedBooks = parsedBooks.filter((book) => !!book.sourceRevision);
    if (!parsedBooks.length) return;
    const sourceWords = new Map<string, ImportedWord>();
    for (const book of parsedBooks)
      for (const word of book.words) {
        const existing = sourceWords.get(word.normalized);
        sourceWords.set(
          word.normalized,
          existing
            ? {
                ...existing,
                ukPhonetic: existing.ukPhonetic ?? word.ukPhonetic,
                usPhonetic: existing.usPhonetic ?? word.usPhonetic,
                meaning: existing.meaning ?? word.meaning,
              }
            : word,
        );
      }
    // Preserve cross-book field merging, but do not create versioned-only words outside
    // their transaction. Existing words continue to use skipDuplicates (no overwrite).
    const unversionedKeys = new Set(
      books.flatMap((book) => book.words.map((word) => word.normalized)),
    );
    const words = new Map([...sourceWords].filter(([key]) => unversionedKeys.has(key)));
    await this.inChunks([...words.values()], 1000, async (chunk) =>
      this.prisma.vocabularyWord.createMany({ data: chunk, skipDuplicates: true }),
    );
    const wordIds = new Map<string, string>();
    await this.inChunks([...words.keys()], 1000, async (chunk) => {
      const records = await this.prisma.vocabularyWord.findMany({
        where: { normalized: { in: chunk } },
        select: { id: true, normalized: true },
      });
      records.forEach((record) => wordIds.set(record.normalized, record.id));
    });
    for (const book of books) {
      const stored = await this.prisma.vocabularyBook.upsert({
        where: { sourceKey: book.sourceKey },
        create: {
          sourceKey: book.sourceKey,
          sourcePath: book.sourcePath,
          ...(book.sourceRevision ? { sourceRevision: book.sourceRevision } : {}),
          category: book.category,
          title: book.title,
          publisher: book.publisher,
          grade: book.grade,
        },
        update: {
          sourcePath: book.sourcePath,
          category: book.category,
          title: book.title,
          publisher: book.publisher,
          grade: book.grade,
          isActive: true,
        },
      });
      await this.inChunks(
        book.words.map((word, index) => ({
          bookId: stored.id,
          wordId: wordIds.get(word.normalized)!,
          position: index + 1,
        })),
        1000,
        async (chunk) =>
          this.prisma.vocabularyBookWord.createMany({ data: chunk, skipDuplicates: true }),
      );
    }
    for (const book of versionedBooks) {
      const result = await importVersionedVocabularyBook(this.prisma, {
        ...book,
        words: book.words.map((word) => sourceWords.get(word.normalized)!),
      });
      if (result === 'preserved')
        this.logger.warn(
          `词书 ${book.sourceKey} 的源修订不匹配，保留既有关联与学习进度；需要另行审阅迁移。`,
        );
    }
    this.logger.log(`词表初始化完成：${parsedBooks.length} 本词书已检查。`);
  }

  private findFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return this.findFiles(path);
      return entry.isFile() && entry.name.endsWith('.xlsx') ? [path] : [];
    });
  }

  private readBook(root: string, file: string): ImportedBook | null {
    const sourcePath = relative(root, file).split(sep).join('/');
    const parts = sourcePath.split('/');
    const category = categoryByDirectory[parts[0]];
    if (!category) return null;
    const workbook = XLSX.readFile(file, { raw: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    let rows = sourceRows;
    if (sourcePath === DAILY_SOURCE_KEY) {
      try {
        rows = repairDailyBoundaries(sourceRows);
      } catch {
        this.logger.warn('日常词书边界修订与源文件不匹配，跳过该书并保留既有数据。');
        return null;
      }
    }
    const seen = new Set<string>();
    const words = rows.flatMap((row) => {
      const text = String(row['单词'] ?? '').trim();
      const normalized = text.toLowerCase().replace(/\s+/g, ' ');
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [
        {
          normalized,
          text,
          ukPhonetic: normalizePhonetic(this.value(row['英音'])),
          usPhonetic: normalizePhonetic(this.value(row['美音'])),
          meaning:
            this.value(row['释义']) ??
            (sourcePath === DAILY_SOURCE_KEY ? reviewedSupplementMeaning(normalized) : null),
        },
      ];
    });
    if (!words.length) return null;
    const stem = parts.at(-1)!.replace(/\.xlsx$/, '');
    return {
      sourceKey: sourcePath,
      sourcePath,
      ...(sourcePath === DAILY_SOURCE_KEY ? { sourceRevision: DAILY_BOUNDARY_REVISION } : {}),
      category,
      title: stem.replace(/(.*?年级)(上|下)$/, '$1（$2）'),
      publisher: curriculumCategories.has(category) ? (parts[1] ?? null) : null,
      grade: stem.match(/[一二三四五六七八九]年级/)?.[0] ?? null,
      words,
    };
  }

  private value(value: unknown) {
    const text = String(value ?? '').trim();
    return !text || text === '无' ? null : text;
  }

  private async inChunks<T>(items: T[], size: number, callback: (chunk: T[]) => Promise<unknown>) {
    for (let index = 0; index < items.length; index += size)
      await callback(items.slice(index, index + size));
  }
}
