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

export type NotebookContextRecallPart =
  { kind: 'text'; value: string } | { kind: 'blank'; key: number };

export type NotebookContextPrompt = {
  parts: NotebookContextRecallPart[];
  occurrenceCount: number;
};

/** Replaces every complete target occurrence so the saved sentence cannot reveal the answer. */
export function buildNotebookContextPrompt(
  example: string | null | undefined,
  target: string,
): NotebookContextPrompt | null {
  if (!example?.trim() || !target.trim()) return null;

  const matches = findTargetWordMatches(example, [target]);
  if (matches.length === 0) return null;

  const parts: NotebookContextRecallPart[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    if (match.start < cursor) continue;
    if (match.start > cursor)
      parts.push({ kind: 'text', value: example.slice(cursor, match.start) });
    parts.push({ kind: 'blank', key: index });
    cursor = match.end;
  }
  if (cursor < example.length) parts.push({ kind: 'text', value: example.slice(cursor) });

  return { parts, occurrenceCount: matches.length };
}
