export type TargetWordMatch = { start: number; end: number; wordIndex: number };

const WORD_CHARACTERS = String.raw`\p{L}\p{N}_'’\u2010\u2011\u2012\u2013\u2014`;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function targetPattern(value: string) {
  return value
    .trim()
    .split(/\s+/u)
    .map(escapeRegExp)
    .join(String.raw`\s+`);
}

/** Finds exact English target terms without marking substrings in other words. */
export function findTargetWordMatches(text: string, targets: string[]): TargetWordMatch[] {
  const candidates = targets
    .map((target, wordIndex) => ({ target: target.trim(), wordIndex }))
    .filter(({ target }) => target.length > 0)
    .sort((left, right) => right.target.length - left.target.length);
  if (!text || candidates.length === 0) return [];

  const alternatives = candidates.map(({ target }) => targetPattern(target)).join('|');
  const matcher = new RegExp(
    String.raw`(?<![${WORD_CHARACTERS}])(${alternatives})(?![${WORD_CHARACTERS}])`,
    'giu',
  );
  const targetIndexes = new Map<string, number>();
  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate.target);
    if (!targetIndexes.has(normalized)) targetIndexes.set(normalized, candidate.wordIndex);
  }

  const matches: TargetWordMatch[] = [];
  for (const match of text.matchAll(matcher)) {
    const matchedText = match[1];
    const start = match.index!;
    const wordIndex = targetIndexes.get(normalizeWhitespace(matchedText));
    if (wordIndex === undefined) continue;
    matches.push({ start, end: start + matchedText.length, wordIndex });
  }
  return matches;
}
