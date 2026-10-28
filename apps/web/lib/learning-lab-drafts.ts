export type LearningLabDraftQuestion = {
  id: string;
  prompt: string;
  options: string[];
};

export type LearningLabDraftSnapshot = {
  answers: number[];
  snapshotId: string | null;
  restored: boolean;
  storageAvailable: boolean;
};

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

function draftKey(userId: string, lessonId: string) {
  return `lexloop.learning-lab.quiz.${encodeKeyPart(userId)}.${encodeKeyPart(lessonId)}`;
}

function questionSignature(questions: LearningLabDraftQuestion[]) {
  const canonical = JSON.stringify(
    questions.map(({ id, prompt, options }) => [id, prompt, options]),
  );
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index++) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

function emptyAnswers(questions: LearningLabDraftQuestion[]) {
  return questions.map(() => -1);
}

function validAnswers(value: unknown, questions: LearningLabDraftQuestion[]): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === questions.length &&
    value.every(
      (answer, index) =>
        Number.isInteger(answer) && answer >= -1 && answer < questions[index].options.length,
    )
  );
}

export function readLearningLabDraft(
  userId: string,
  lessonId: string,
  questions: LearningLabDraftQuestion[],
  storage: DraftStorage | undefined = browserStorage(),
): LearningLabDraftSnapshot {
  const empty = {
    answers: emptyAnswers(questions),
    snapshotId: null,
    restored: false,
    storageAvailable: Boolean(storage),
  };
  if (!storage) return empty;

  const key = draftKey(userId, lessonId);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return empty;
    const value = JSON.parse(raw);
    if (value === null) {
      storage.removeItem(key);
      return empty;
    }
    if (
      !value ||
      value.version !== 1 ||
      value.userId !== userId ||
      value.lessonId !== lessonId ||
      value.questionSignature !== questionSignature(questions) ||
      typeof value.snapshotId !== 'string' ||
      !value.snapshotId.length ||
      !validAnswers(value.answers, questions)
    ) {
      storage.removeItem(key);
      return empty;
    }
    if (!value.answers.some((answer: number) => answer >= 0)) {
      storage.removeItem(key);
      return empty;
    }
    return {
      answers: value.answers,
      snapshotId: value.snapshotId,
      restored: true,
      storageAvailable: true,
    };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* Unavailable storage must not block practice. */
    }
    return { ...empty, storageAvailable: false };
  }
}

function newSnapshotId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export type LearningLabDraftSaveResult = {
  snapshotId: string | null;
  storageAvailable: boolean;
};

export function saveLearningLabDraft(
  userId: string,
  lessonId: string,
  questions: LearningLabDraftQuestion[],
  answers: number[],
  storage: DraftStorage | undefined = browserStorage(),
): LearningLabDraftSaveResult {
  if (!storage || !validAnswers(answers, questions))
    return { snapshotId: null, storageAvailable: false };
  const key = draftKey(userId, lessonId);
  try {
    if (!answers.some((answer) => answer >= 0)) {
      storage.removeItem(key);
      return { snapshotId: null, storageAvailable: true };
    }
    const snapshotId = newSnapshotId();
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId,
        lessonId,
        snapshotId,
        questionSignature: questionSignature(questions),
        answers,
      }),
    );
    return { snapshotId, storageAvailable: true };
  } catch {
    return { snapshotId: null, storageAvailable: false };
  }
}

export function clearLearningLabDraft(
  userId: string,
  lessonId: string,
  storage: DraftStorage | undefined = browserStorage(),
) {
  try {
    storage?.removeItem(draftKey(userId, lessonId));
    return Boolean(storage);
  } catch {
    return false;
  }
}

function sameAnswers(left: number[], right: number[]) {
  return left.length === right.length && left.every((answer, index) => answer === right[index]);
}

export function clearLearningLabDraftIfMatches(
  userId: string,
  lessonId: string,
  questions: LearningLabDraftQuestion[],
  submittedAnswers: number[],
  submittedSnapshotId: string | null,
  storage: DraftStorage | undefined = browserStorage(),
) {
  const current = readLearningLabDraft(userId, lessonId, questions, storage);
  if (
    !current.restored ||
    !sameAnswers(current.answers, submittedAnswers) ||
    (submittedSnapshotId !== null && current.snapshotId !== submittedSnapshotId)
  )
    return false;
  return clearLearningLabDraft(userId, lessonId, storage);
}
