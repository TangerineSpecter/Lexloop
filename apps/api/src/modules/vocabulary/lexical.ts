const POS_PATTERN = /^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i;

export type MeaningLine = { part: string; text: string };

export function parseMeaningLines(raw: string | null | undefined): MeaningLine[] {
  const value = raw?.trim() ?? '';
  if (!value || value === '无') return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(POS_PATTERN);
      if (!match) return { part: '', text: line };
      return { part: match[1], text: line.slice(match[0].length).trim() };
    });
}

export function lexicalFields(raw: string | null | undefined) {
  const meanings = parseMeaningLines(raw);
  const part = meanings.find((line) => line.part)?.part ?? '';
  let meaning = '暂无释义';
  if (meanings.length === 1) meaning = meanings[0].text || '暂无释义';
  else if (meanings.length > 1) {
    meaning = meanings.map((line) => (line.part ? `${line.part} ${line.text}` : line.text)).join('\n');
  }
  return { part, meaning, meanings };
}

export function presentLexicalWord(
  word: {
    text: string;
    meaning: string | null;
    ukPhonetic?: string | null;
    usPhonetic?: string | null;
    cefrLevel?: string | null;
  },
  contextMeaning?: string | null,
) {
  return {
    word: word.text,
    ...lexicalFields(contextMeaning ?? word.meaning),
    ukPhonetic: word.ukPhonetic?.trim() || null,
    usPhonetic: word.usPhonetic?.trim() || null,
    cefrLevel: word.cefrLevel ?? null,
  };
}
