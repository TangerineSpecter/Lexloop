export function reviewQueueOrderNote(
  words: Array<{ word?: string | null }>,
  options?: { skipped?: number },
) {
  const head = words.find((word) => word.word?.trim())?.word?.trim();
  if (!head) return null;
  const base = `先刷这些：最逾期的在前；到期时间相同，则更久没复习的在前。队首是「${head}」。`;
  const skipped = options?.skipped ?? 0;
  if (!Number.isSafeInteger(skipped) || skipped <= 0) return base;
  return `${base}另有 ${skipped} 个词在队尾，创建计划时先不抽它们，复习时间不变。`;
}
