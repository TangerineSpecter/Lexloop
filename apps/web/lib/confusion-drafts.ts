export type ConfusionDraftQuestion = { id: string; sentence: string; options: string[] };
export type ConfusionDraftAnswers = Record<string, string>;
export type ConfusionDraftSnapshot = {
  answers: ConfusionDraftAnswers;
  snapshotId: string | null;
};

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function draftKey(userId: string, groupId: string) {
  return `lexloop.confusion.draft.${encodeURIComponent(userId)}.${encodeURIComponent(groupId)}`;
}

function questionSetSignature(questions: ConfusionDraftQuestion[]) {
  return JSON.stringify(
    [...questions]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((question) => [question.id, question.sentence, [...question.options].sort()]),
  );
}

function newSnapshotId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function sameAnswers(left: ConfusionDraftAnswers, right: ConfusionDraftAnswers) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

export function readConfusionDraft(
  userId: string,
  groupId: string,
  questions: ConfusionDraftQuestion[],
  storage: DraftStorage | undefined = browserStorage(),
): ConfusionDraftAnswers {
  return readConfusionDraftSnapshot(userId, groupId, questions, storage).answers;
}

export function readConfusionDraftSnapshot(
  userId: string,
  groupId: string,
  questions: ConfusionDraftQuestion[],
  storage: DraftStorage | undefined = browserStorage(),
): ConfusionDraftSnapshot {
  const empty = { answers: {}, snapshotId: null };
  if (!storage) return empty;
  try {
    const value = JSON.parse(storage.getItem(draftKey(userId, groupId)) ?? 'null');
    if (
      !value ||
      value.version !== 3 ||
      value.groupId !== groupId ||
      value.questionSignature !== questionSetSignature(questions) ||
      typeof value.snapshotId !== 'string' ||
      value.snapshotId.length === 0 ||
      !value.answers ||
      typeof value.answers !== 'object' ||
      Array.isArray(value.answers)
    )
      return empty;

    const answers = Object.fromEntries(
      questions.flatMap((question) => {
        const answer = value.answers[question.id];
        return typeof answer === 'string' && question.options.includes(answer)
          ? [[question.id, answer]]
          : [];
      }),
    );
    return { answers, snapshotId: value.snapshotId };
  } catch {
    return empty;
  }
}

export function saveConfusionDraft(
  userId: string,
  groupId: string,
  questions: ConfusionDraftQuestion[],
  answers: ConfusionDraftAnswers,
  storage: DraftStorage | undefined = browserStorage(),
): string | null {
  if (!storage) return null;
  const validAnswers = Object.fromEntries(
    questions.flatMap((question) => {
      const answer = answers[question.id];
      return typeof answer === 'string' && question.options.includes(answer)
        ? [[question.id, answer]]
        : [];
    }),
  );
  if (!Object.keys(validAnswers).length) {
    clearConfusionDraft(userId, groupId, storage);
    return null;
  }

  const snapshotId = newSnapshotId();
  try {
    storage.setItem(
      draftKey(userId, groupId),
      JSON.stringify({
        version: 3,
        groupId,
        questionSignature: questionSetSignature(questions),
        snapshotId,
        answers: validAnswers,
      }),
    );
    return snapshotId;
  } catch {
    return null;
  }
}

export function clearConfusionDraft(
  userId: string,
  groupId: string,
  storage: DraftStorage | undefined = browserStorage(),
) {
  try {
    storage?.removeItem(draftKey(userId, groupId));
  } catch {
    /* Local storage is optional. */
  }
}

export function clearConfusionDraftIfMatches(
  userId: string,
  groupId: string,
  questions: ConfusionDraftQuestion[],
  submittedAnswers: ConfusionDraftAnswers,
  submittedSnapshotId: string | null,
  storage: DraftStorage | undefined = browserStorage(),
) {
  if (!submittedSnapshotId) return false;
  const current = readConfusionDraftSnapshot(userId, groupId, questions, storage);
  if (current.snapshotId !== submittedSnapshotId || !sameAnswers(current.answers, submittedAnswers))
    return false;
  clearConfusionDraft(userId, groupId, storage);
  return true;
}
