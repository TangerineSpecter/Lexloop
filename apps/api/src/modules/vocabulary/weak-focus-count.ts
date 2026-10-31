import { lexicalFields } from './lexical';

export function countDistinctUsableWeakWords(
  rows: Array<{ bookWordId: string; meaning: string | null; contextMeaning?: string | null }>,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.bookWordId || seen.has(row.bookWordId)) continue;
    const raw = row.contextMeaning != null ? row.contextMeaning : row.meaning;
    const usable = lexicalFields(raw).meanings.some((line) => {
      const value = line.text.trim();
      return value.length > 0 && value !== '无' && value !== '暂无释义';
    });
    if (!usable) continue;
    seen.add(row.bookWordId);
  }
  return seen.size;
}
