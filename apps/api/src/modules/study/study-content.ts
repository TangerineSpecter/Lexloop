import { createHash } from 'node:crypto';

type StudyQuestionRecord = Record<string, unknown>;

function isRecord(value: unknown): value is StudyQuestionRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Versioned opt-in lives on the plan, never on shared cache/question snapshots. */
export function progressivePresentationSeed(content: unknown, planId: string): string | undefined {
  return isRecord(content) && content.optionOrderVersion === 1 ? planId : undefined;
}

function presentedQuestion(question: StudyQuestionRecord, seed?: string): StudyQuestionRecord {
  if (
    !seed ||
    !['MEANING_RECOGNITION', 'SYNONYM_REPLACEMENT', 'READING_COMPREHENSION'].includes(
      String(question.type),
    ) ||
    typeof question.bookWordId !== 'string' ||
    !Array.isArray(question.options) ||
    question.options.length !== 4 ||
    !question.options.every((option) => typeof option === 'string')
  )
    return question;
  // Legacy/shared material may refer to its original option labels or positions.
  // Preserve that order rather than reinterpret such references after shuffling.
  const text = [
    question.prompt,
    question.explanation,
    ...question.options,
    ...(Array.isArray(question.optionNotes) ? question.optionNotes : []),
  ].filter((value): value is string => typeof value === 'string');
  if (
    text.some(
      (value) =>
        /\b[A-D]\b/u.test(value) ||
        /(?:\b(?:above|below|former|latter|first|second|third|fourth)\b|[①②③④]|[前后上下][述面者项]|第[一二三四1234]项|[两三四]项|所有选项|以[上下])/iu.test(
          value,
        ),
    )
  )
    return question;
  const options = question.options;
  // Hash ranks are deterministic per plan/word. Do not use the answer key to choose positions.
  const order = options
    .map((_, index) => ({
      index,
      rank: createHash('sha256')
        .update(JSON.stringify(['progressive-options-v1', seed, question.bookWordId, index]))
        .digest('hex'),
    }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.index - b.index)
    .map(({ index }) => index);
  const notes = question.optionNotes;
  return {
    ...question,
    options: order.map((index) => options[index]),
    ...(Array.isArray(notes) && notes.length === options.length
      ? { optionNotes: order.map((index) => notes[index]) }
      : {}),
  };
}

/** Remove answer material from an unsubmitted study question sent to the learner. */
export function publicStudyQuestion(question: unknown, submitted: boolean, seed?: string): unknown {
  if (!isRecord(question)) return question;
  const presented = presentedQuestion(question, seed);
  if (submitted) return presented;

  const { correctAnswers, explanation, optionNotes, pairs, options, ...publicQuestion } = presented;
  if (question.type !== 'WORD_MATCHING') {
    return { ...publicQuestion, ...(options === undefined ? {} : { options }) };
  }
  if (!Array.isArray(pairs) || pairs.length !== 4) {
    return { ...publicQuestion, options: [] };
  }

  // Keep the matching exercise usable while breaking the stored left-to-right answer pairs.
  // Rotate both right-side copy fields together so the hint still describes its definition.
  const publicPairs = pairs.map((value, index) => {
    const pair = isRecord(value) ? value : null;
    const next = isRecord(pairs[(index + 1) % pairs.length])
      ? (pairs[(index + 1) % pairs.length] as StudyQuestionRecord)
      : null;
    if (!pair || !next || typeof pair.left !== 'string' || typeof next.right !== 'string') {
      return null;
    }
    return {
      ...pair,
      right: next.right,
      ...(typeof next.tip === 'string' ? { tip: next.tip } : {}),
    };
  });

  return publicPairs.every(Boolean)
    ? { ...publicQuestion, options: [], pairs: publicPairs }
    : { ...publicQuestion, options: [] };
}

/** Apply the same answer boundary to both copies of generated questions in a study plan. */
export function publicStudyContent(
  content: unknown,
  submittedGroups: ReadonlySet<number>,
  seed?: string,
): unknown {
  if (!isRecord(content) || !Array.isArray(content.groups)) return content;
  return {
    ...content,
    groups: content.groups.map((value) => {
      if (!isRecord(value) || !Array.isArray(value.questions)) return value;
      const submitted = Number.isInteger(value.index) && submittedGroups.has(value.index as number);
      return {
        ...value,
        questions: value.questions.map((question) =>
          publicStudyQuestion(question, submitted, seed),
        ),
      };
    }),
  };
}
