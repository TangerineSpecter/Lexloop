export const WRONG_ITEM_RETEST_LIMIT = 8;

type RetestQuestion = {
  type?: string;
  options?: unknown;
  correctAnswers?: unknown;
  pairs?: unknown;
};

export function wrongRetestPlan<T extends { result?: boolean; question?: RetestQuestion | null }>(
  words: T[],
  limit = WRONG_ITEM_RETEST_LIMIT,
) {
  const eligible = words.filter(
    (word) => word.result === false && canRetestQuestion(word.question),
  );
  const cap = Math.max(0, limit);
  return {
    items: eligible.slice(0, cap),
    omitted: Math.max(0, eligible.length - cap),
  };
}

function canRetestQuestion(question: RetestQuestion | null | undefined) {
  if (!question || typeof question.type !== 'string') return false;
  if (question.type === 'WORD_MATCHING') {
    return Array.isArray(question.pairs) && question.pairs.length > 0;
  }
  return (
    Array.isArray(question.options) &&
    question.options.length > 0 &&
    Array.isArray(question.correctAnswers) &&
    question.correctAnswers.length > 0
  );
}
