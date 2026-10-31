type IntervalWord = {
  word?: string | null;
  result?: boolean;
  previousIntervalDays?: number | null;
  lastIntervalDays?: number | null;
};

export function intervalGrowthLine(words: IntervalWord[]) {
  const grown = words
    .filter((word) => {
      const previous = word.previousIntervalDays;
      const next = word.lastIntervalDays;
      return (
        word.result === true &&
        Boolean(word.word?.trim()) &&
        typeof previous === 'number' &&
        typeof next === 'number' &&
        Number.isSafeInteger(previous) &&
        Number.isSafeInteger(next) &&
        previous >= 1 &&
        next - previous >= 2
      );
    })
    .slice(0, 3);
  if (!grown.length) return null;
  const parts = grown.map(
    (word) => `${word.word!.trim()} 从 ${word.previousIntervalDays} 天到 ${word.lastIntervalDays} 天`,
  );
  return `复习间隔拉长：${parts.join('、')}。`;
}
