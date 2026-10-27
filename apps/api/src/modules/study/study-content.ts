type StudyQuestionRecord = Record<string, unknown>;

function isRecord(value: unknown): value is StudyQuestionRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Remove answer material from an unsubmitted study question sent to the learner. */
export function publicStudyQuestion(question: unknown, submitted: boolean): unknown {
  if (submitted || !isRecord(question)) return question;

  const { correctAnswers, explanation, optionNotes, pairs, ...publicQuestion } = question;
  if (question.type !== 'WORD_MATCHING' || !Array.isArray(pairs) || pairs.length !== 4) {
    return publicQuestion;
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

  return publicPairs.every(Boolean) ? { ...publicQuestion, pairs: publicPairs } : publicQuestion;
}

/** Apply the same answer boundary to both copies of generated questions in a study plan. */
export function publicStudyContent(
  content: unknown,
  submittedGroups: ReadonlySet<number>,
): unknown {
  if (!isRecord(content) || !Array.isArray(content.groups)) return content;
  return {
    ...content,
    groups: content.groups.map((value) => {
      if (!isRecord(value) || !Array.isArray(value.questions)) return value;
      const submitted = Number.isInteger(value.index) && submittedGroups.has(value.index as number);
      return {
        ...value,
        questions: value.questions.map((question) => publicStudyQuestion(question, submitted)),
      };
    }),
  };
}
