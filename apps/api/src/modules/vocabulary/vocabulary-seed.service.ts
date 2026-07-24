import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { VocabularyCategory } from '@prisma/client';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import * as XLSX from 'xlsx';
import { PrismaService } from '../../prisma/prisma.service';

type ImportedWord = { normalized: string; text: string; ukPhonetic: string | null; usPhonetic: string | null; meaning: string | null };
type ImportedBook = { sourceKey: string; sourcePath: string; category: VocabularyCategory; title: string; publisher: string | null; grade: string | null; words: ImportedWord[] };

const categoryByDirectory: Record<string, VocabularyCategory> = {
  '小学': VocabularyCategory.PRIMARY, '初中': VocabularyCategory.JUNIOR, '高中': VocabularyCategory.SENIOR, '大学': VocabularyCategory.COLLEGE,
  '考试': VocabularyCategory.EXAM, '教材': VocabularyCategory.MATERIAL, '专项': VocabularyCategory.PHRASES, '通用': VocabularyCategory.GENERAL,
};
const curriculumCategories = new Set<VocabularyCategory>([VocabularyCategory.PRIMARY, VocabularyCategory.JUNIOR, VocabularyCategory.SENIOR]);

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
    const books = this.findFiles(root).map((file) => this.readBook(root, file)).filter((book): book is ImportedBook => book !== null);
    if (!books.length) return;
    const words = new Map<string, ImportedWord>();
    for (const book of books) for (const word of book.words) {
      const existing = words.get(word.normalized);
      words.set(word.normalized, existing ? {
        ...existing,
        ukPhonetic: existing.ukPhonetic ?? word.ukPhonetic,
        usPhonetic: existing.usPhonetic ?? word.usPhonetic,
        meaning: existing.meaning ?? word.meaning,
      } : word);
    }
    await this.inChunks([...words.values()], 1000, async (chunk) => this.prisma.vocabularyWord.createMany({ data: chunk, skipDuplicates: true }));
    const wordIds = new Map<string, string>();
    await this.inChunks([...words.keys()], 1000, async (chunk) => {
      const records = await this.prisma.vocabularyWord.findMany({ where: { normalized: { in: chunk } }, select: { id: true, normalized: true } });
      records.forEach((record) => wordIds.set(record.normalized, record.id));
    });
    for (const book of books) {
      const stored = await this.prisma.vocabularyBook.upsert({
        where: { sourceKey: book.sourceKey },
        create: { sourceKey: book.sourceKey, sourcePath: book.sourcePath, category: book.category, title: book.title, publisher: book.publisher, grade: book.grade },
        update: { sourcePath: book.sourcePath, category: book.category, title: book.title, publisher: book.publisher, grade: book.grade, isActive: true },
      });
      await this.inChunks(book.words.map((word, index) => ({ bookId: stored.id, wordId: wordIds.get(word.normalized)!, position: index + 1 })), 1000, async (chunk) => this.prisma.vocabularyBookWord.createMany({ data: chunk, skipDuplicates: true }));
    }
    this.logger.log(`词表初始化完成：${books.length} 本词书，${words.size} 个唯一词条。`);
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
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    const seen = new Set<string>();
    const words = rows.flatMap((row) => {
      const text = String(row['单词'] ?? '').trim();
      const normalized = text.toLowerCase().replace(/\s+/g, ' ');
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ normalized, text, ukPhonetic: this.value(row['英音']), usPhonetic: this.value(row['美音']), meaning: this.value(row['释义']) }];
    });
    if (!words.length) return null;
    const stem = parts.at(-1)!.replace(/\.xlsx$/, '');
    return {
      sourceKey: sourcePath,
      sourcePath,
      category,
      title: stem.replace(/(.*?年级)(上|下)$/, '$1（$2）'),
      publisher: curriculumCategories.has(category) ? parts[1] ?? null : null,
      grade: stem.match(/[一二三四五六七八九]年级/)?.[0] ?? null,
      words,
    };
  }

  private value(value: unknown) {
    const text = String(value ?? '').trim();
    return !text || text === '无' ? null : text;
  }

  private async inChunks<T>(items: T[], size: number, callback: (chunk: T[]) => Promise<unknown>) {
    for (let index = 0; index < items.length; index += size) await callback(items.slice(index, index + size));
  }
}
