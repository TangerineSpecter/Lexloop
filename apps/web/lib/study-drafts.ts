export type StudyDraftQuestion = {
  bookWordId: string;
  type: string;
  prompt: string;
  options: string[];
  pairs?: Array<{ left: string; right: string }>;
};
export type StudyDraftAnswer = { selected: string[]; confirmed: boolean };
export type StudyDraftAnswers = Record<string, StudyDraftAnswer>;
export type StudyDraftSnapshot = { answers: StudyDraftAnswers; snapshotId: string | null };

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

function draftKey(userId: string, planId: string, groupIndex: number) {
  return `lexloop.study.draft.${encodeKeyPart(userId)}.${encodeKeyPart(planId)}.${groupIndex}`;
}

function questionSignature(questions: StudyDraftQuestion[]) {
  const canonical = JSON.stringify(
    [...questions]
      .sort((left, right) =>
        left.bookWordId < right.bookWordId ? -1 : left.bookWordId > right.bookWordId ? 1 : 0,
      )
      .map((question) => ({
        id: question.bookWordId,
        type: question.type,
        prompt: question.prompt,
        options: [...question.options].sort(),
        matching:
          question.type === 'WORD_MATCHING'
            ? {
                left: (question.pairs ?? []).map((pair) => pair.left).sort(),
                right: (question.pairs ?? []).map((pair) => pair.right).sort(),
              }
            : undefined,
      })),
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

function validAnswer(question: StudyDraftQuestion, value: unknown): StudyDraftAnswer | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray((value as Partial<StudyDraftAnswer>).selected) ||
    typeof (value as Partial<StudyDraftAnswer>).confirmed !== 'boolean'
  )
    return null;

  const selected = (value as StudyDraftAnswer).selected;
  if (selected.length > Math.max(question.options.length, question.pairs?.length ?? 0)) return null;
  if (selected.some((answer) => typeof answer !== 'string')) return null;
  if (new Set(selected).size !== selected.length) return null;

  if (question.type === 'WORD_MATCHING') {
    const left = new Set((question.pairs ?? []).map((pair) => pair.left));
    const right = new Set((question.pairs ?? []).map((pair) => pair.right));
    const selectedLeft = new Set<string>();
    const selectedRight = new Set<string>();
    for (const answer of selected) {
      const separator = answer.lastIndexOf('=>');
      if (separator <= 0) return null;
      const selectedPhrase = answer.slice(0, separator);
      const selectedMeaning = answer.slice(separator + 2);
      if (!left.has(selectedPhrase) || !right.has(selectedMeaning)) return null;
      if (selectedLeft.has(selectedPhrase) || selectedRight.has(selectedMeaning)) return null;
      selectedLeft.add(selectedPhrase);
      selectedRight.add(selectedMeaning);
    }
  } else if (selected.some((answer) => !question.options.includes(answer))) {
    return null;
  }

  return { selected: [...selected], confirmed: (value as StudyDraftAnswer).confirmed };
}

function normalizeAnswers(questions: StudyDraftQuestion[], value: unknown): StudyDraftAnswers {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    questions.flatMap((question) => {
      const answer = validAnswer(question, (value as Record<string, unknown>)[question.bookWordId]);
      return answer && answer.selected.length ? [[question.bookWordId, answer]] : [];
    }),
  );
}

function newSnapshotId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function sameAnswers(left: StudyDraftAnswers, right: StudyDraftAnswers) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => {
      const first = left[key];
      const second = right[key];
      return (
        key === rightKeys[index] &&
        first.confirmed === second.confirmed &&
        first.selected.length === second.selected.length &&
        first.selected.every((answer, answerIndex) => answer === second.selected[answerIndex])
      );
    })
  );
}

export function studyDraftIdentity(
  userId: string,
  planId: string,
  groupIndex: number,
  questions: StudyDraftQuestion[],
) {
  return JSON.stringify([userId, planId, groupIndex, questionSignature(questions)]);
}

export function readStudyDraftSnapshot(
  userId: string,
  planId: string,
  groupIndex: number,
  questions: StudyDraftQuestion[],
  storage: DraftStorage | undefined = browserStorage(),
): StudyDraftSnapshot {
  const empty = { answers: {}, snapshotId: null };
  if (!storage) return empty;
  const key = draftKey(userId, planId, groupIndex);
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    if (
      !value ||
      value.version !== 1 ||
      value.userId !== userId ||
      value.planId !== planId ||
      value.groupIndex !== groupIndex ||
      value.questionSignature !== questionSignature(questions) ||
      typeof value.snapshotId !== 'string' ||
      !value.snapshotId.length
    ) {
      if (value !== null) storage.removeItem(key);
      return empty;
    }
    const answers = normalizeAnswers(questions, value.answers);
    if (!Object.keys(answers).length) {
      clearStudyDraft(userId, planId, groupIndex, storage);
      return empty;
    }
    return { answers, snapshotId: value.snapshotId };
  } catch {
    clearStudyDraft(userId, planId, groupIndex, storage);
    return empty;
  }
}

export function saveStudyDraft(
  userId: string,
  planId: string,
  groupIndex: number,
  questions: StudyDraftQuestion[],
  answers: StudyDraftAnswers,
  storage: DraftStorage | undefined = browserStorage(),
) {
  if (!storage) return null;
  const validAnswers = normalizeAnswers(questions, answers);
  const key = draftKey(userId, planId, groupIndex);
  if (!Object.keys(validAnswers).length) {
    clearStudyDraft(userId, planId, groupIndex, storage);
    return null;
  }

  const snapshotId = newSnapshotId();
  try {
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId,
        planId,
        groupIndex,
        questionSignature: questionSignature(questions),
        snapshotId,
        answers: validAnswers,
      }),
    );
    return snapshotId;
  } catch {
    return null;
  }
}

export function clearStudyDraft(
  userId: string,
  planId: string,
  groupIndex: number,
  storage: DraftStorage | undefined = browserStorage(),
) {
  try {
    storage?.removeItem(draftKey(userId, planId, groupIndex));
  } catch {
    /* Local storage is optional. */
  }
}

export function clearStudyDraftIfMatches(
  userId: string,
  planId: string,
  groupIndex: number,
  questions: StudyDraftQuestion[],
  submittedAnswers: StudyDraftAnswers,
  submittedSnapshotId: string | null,
  storage: DraftStorage | undefined = browserStorage(),
) {
  if (!submittedSnapshotId) return false;
  const current = readStudyDraftSnapshot(userId, planId, groupIndex, questions, storage);
  if (current.snapshotId !== submittedSnapshotId || !sameAnswers(current.answers, submittedAnswers))
    return false;
  clearStudyDraft(userId, planId, groupIndex, storage);
  return true;
}
