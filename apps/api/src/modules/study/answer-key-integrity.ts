/** Structural integrity only; this does not prove semantic uniqueness or entailment. */
export function hasInvalidStoredAnswerKey(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const question = value as Record<string, unknown>;
  const unique = (values: unknown): values is string[] => {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((v) => typeof v !== 'string' || !v.trim())
    )
      return false;
    const normalized = values.map((v: string) =>
      v.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(),
    );
    return new Set(normalized).size === values.length;
  };
  if (question.type === 'WORD_MATCHING') {
    if (!Array.isArray(question.pairs) || !question.pairs.length) return true;
    const pairs = question.pairs as Array<Record<string, unknown> | null>;
    return !unique(pairs.map((p) => p?.left)) || !unique(pairs.map((p) => p?.right));
  }
  if (
    ![
      'MEANING_RECOGNITION',
      'SYNONYM_REPLACEMENT',
      'READING_COMPREHENSION',
      'WORD_MNEMONIC',
    ].includes(String(question.type))
  )
    return true;
  if (!unique(question.correctAnswers)) return true;
  if (question.type !== 'WORD_MNEMONIC' && question.correctAnswers.length !== 1) return true;
  // Strict recovery is opt-in for current progressive plans, whose UI needs options.
  // The legacy grader remains unchanged when strict validation is not requested.
  if (question.options === undefined) return true;
  return (
    !unique(question.options) ||
    question.correctAnswers.some((answer) => !(question.options as string[]).includes(answer))
  );
}

// Off until all API readers/writers and the migration have been upgraded.
export function progressiveRecoveryEnabled() {
  return process.env.ENABLE_PROGRESSIVE_PLAN_RECOVERY === 'true';
}
