export type PersonalVocabularyImportRow = {
  text: string;
  meaning: string;
  example?: string;
};

export type PersonalVocabularyImportPreview = {
  items: PersonalVocabularyImportRow[];
  duplicates: number;
  rowCount: number;
  errors: Array<{ line: number; message: string }>;
};

export function parsePersonalVocabularyTsv(value: string): PersonalVocabularyImportPreview {
  const lines = value
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, value: line.trim() }));
  const rows = lines.filter(({ value: line }) => line.length > 0);
  const errors: PersonalVocabularyImportPreview['errors'] = [];
  const items: PersonalVocabularyImportRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  if (rows.length > 40) errors.push({ line: 0, message: '一次最多导入 40 行，请分批粘贴。' });
  for (const { line, value: source } of rows.slice(0, 40)) {
    const columns = source.split('\t').map((column) => column.trim());
    if (columns.length < 2 || columns.length > 3) {
      errors.push({ line, message: '每行格式应为：英文表达、中文释义、可选例句（用 Tab 分隔）。' });
      continue;
    }
    const [rawText, meaning, example = ''] = columns;
    const text = rawText.replace(/\s+/g, ' ');
    if (!text || !meaning) {
      errors.push({ line, message: '英文表达和中文释义都不能为空。' });
      continue;
    }
    if (text.length > 120 || meaning.length > 500 || example.length > 800) {
      errors.push({ line, message: '本行超出长度限制：英文 120、释义 500、例句 800 字符。' });
      continue;
    }
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) {
      duplicates++;
      continue;
    }
    seen.add(normalized);
    items.push({ text, meaning, ...(example ? { example } : {}) });
  }

  return { items, duplicates, rowCount: rows.length, errors };
}
