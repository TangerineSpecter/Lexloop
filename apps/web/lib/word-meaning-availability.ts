type MeaningLine = { text?: string | null };

const EMPTY_MEANINGS = new Set(['无', '暂无释义']);
const PART_OF_SPEECH_PREFIX = /^(?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.\s*/i;

export function hasUsableWordMeaning(word: { meaning?: string | null; meanings?: MeaningLine[] }) {
  const candidates = Array.isArray(word.meanings)
    ? word.meanings.map((line) => line?.text ?? '')
    : [word.meaning ?? ''];
  return candidates.some((candidate) => {
    const value = candidate.trim().replace(PART_OF_SPEECH_PREFIX, '').trim();
    return value.length > 0 && !EMPTY_MEANINGS.has(value);
  });
}
