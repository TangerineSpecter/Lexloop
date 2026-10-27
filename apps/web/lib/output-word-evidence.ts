export type TargetWordExcerpt = { before: string; match: string; after: string };

export function findTargetExcerpt(answer: string, word: string): TargetWordExcerpt | null {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![a-z])${escaped}(?![a-z])`, 'i').exec(answer);
  if (!match) return null;

  const start = Math.max(0, match.index - 64);
  const end = Math.min(answer.length, match.index + match[0].length + 64);
  const leftBoundary = start > 0 ? answer.indexOf(' ', start) : -1;
  const rightBoundary = end < answer.length ? answer.lastIndexOf(' ', end) : -1;
  const excerptStart = leftBoundary > -1 && leftBoundary < match.index ? leftBoundary + 1 : start;
  const matchEnd = match.index + match[0].length;
  const excerptEnd = rightBoundary > matchEnd ? rightBoundary : end;

  return {
    before: `${excerptStart > 0 ? '…' : ''}${answer.slice(excerptStart, match.index)}`,
    match: match[0],
    after: `${answer.slice(matchEnd, excerptEnd)}${excerptEnd < answer.length ? '…' : ''}`,
  };
}
