export function reviewQueueOrderNote(words: Array<{ word?: string | null }>) {
  const head = words.find((word) => word.word?.trim())?.word?.trim();
  if (!head) return null;
  return `先刷这些：最逾期的在前；到期时间相同，则更久没复习的在前。队首是「${head}」。`;
}
