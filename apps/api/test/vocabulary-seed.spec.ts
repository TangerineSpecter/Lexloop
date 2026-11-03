import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { expect, it, vi } from 'vitest';
import { VocabularySeedService } from '../src/modules/vocabulary/vocabulary-seed.service';

it('normalizes known phonetic delimiters on import without rewriting sources or overwriting existing words', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexloop-seed-quality-'));
  const file = join(root, 'fixture.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['单词', '英音', '美音', '释义'],
      ['chair', '[tʃeə]', '/tʃer/', 'n. 椅子'],
      ['unknown', '无', '无', '无'],
      ['review', '[rɪˈvjuː', 'rɪˈvjuː]', '复核'],
    ]),
    'fixture',
  );
  XLSX.writeFile(workbook, file);
  const before = await readFile(file);
  const prisma = {
    vocabularyWord: {
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
      findMany: vi.fn().mockResolvedValue([
        { id: '1', normalized: 'chair' },
        { id: '2', normalized: 'unknown' },
        { id: '3', normalized: 'review' },
      ]),
    },
    vocabularyBook: { upsert: vi.fn().mockResolvedValue({ id: 'book' }) },
    vocabularyBookWord: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
  };
  const service = new VocabularySeedService(prisma as never) as unknown as {
    readBook: (root: string, file: string) => unknown;
    findFiles: () => string[];
    importVocabulary: (root: string) => Promise<void>;
  };
  // Keep the fixture inside the recognized general-book directory without touching real assets.
  const { mkdir, rename } = await import('node:fs/promises');
  await mkdir(join(root, '通用'));
  const target = join(root, '通用', 'fixture.xlsx');
  await rename(file, target);
  try {
    await service.importVocabulary(root);
    expect(prisma.vocabularyWord.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        {
          normalized: 'chair',
          text: 'chair',
          ukPhonetic: 'tʃeə',
          usPhonetic: 'tʃer',
          meaning: 'n. 椅子',
        },
        {
          normalized: 'unknown',
          text: 'unknown',
          ukPhonetic: null,
          usPhonetic: null,
          meaning: null,
        },
        {
          normalized: 'review',
          text: 'review',
          ukPhonetic: '[rɪˈvjuː',
          usPhonetic: 'rɪˈvjuː]',
          meaning: '复核',
        },
      ],
    });
    expect(await readFile(target)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reads the corrected daily source first sheet without importing its attribution sheet', () => {
  const service = new VocabularySeedService({} as never) as unknown as {
    readBook: (
      root: string,
      file: string,
    ) => {
      words: Array<{
        text: string;
        meaning: string | null;
        ukPhonetic: string | null;
        usPhonetic: string | null;
      }>;
    };
  };
  const root = join(process.cwd(), 'assets/vocabulary');
  const book = service.readBook(root, join(root, '通用/日常生活单词.xlsx'));
  expect(book.words).toHaveLength(1177);
  expect(book.words.find((word) => word.text === 'moped')).toMatchObject({
    meaning: 'n. 摩托自行车',
    ukPhonetic: 'ˈməʊ.pɛd',
    usPhonetic: 'ˈmoʊ.pɛd',
  });
  expect(book.words.find((word) => word.text === 'crate')).toMatchObject({
    meaning: 'n. 板条箱',
    ukPhonetic: null,
    usPhonetic: null,
  });
  expect(book.words.some((word) => word.text === 'word')).toBe(false);
});
