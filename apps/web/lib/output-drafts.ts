export type OutputDraftIdentity = {
  userId: string;
  challengeId: string;
  date: string;
};

export type OutputDraftSubmission = {
  answer: string;
  id: string;
  responseTimeMs?: number;
};

export type OutputDraftRead = {
  answer: string;
  submission: OutputDraftSubmission | null;
  storageAvailable: boolean;
};

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

const EMPTY_DRAFT = { answer: '', submission: null, storageAvailable: false } as const;

function browserStorage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function outputDraftKey(userId: string) {
  return `lexloop.output.draft.${userId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 80;
}

function validResponseTimeMs(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 3_600_000;
}

export function readOutputDraft(
  identity: OutputDraftIdentity,
  storage: DraftStorage | undefined = browserStorage(),
): OutputDraftRead {
  if (!storage) return EMPTY_DRAFT;
  let raw: string | null;
  try {
    raw = storage.getItem(outputDraftKey(identity.userId));
  } catch {
    return EMPTY_DRAFT;
  }
  if (!raw) return { answer: '', submission: null, storageAvailable: true };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { answer: '', submission: null, storageAvailable: true };
  }
  if (!isRecord(value) || value.date !== identity.date || typeof value.answer !== 'string')
    return { answer: '', submission: null, storageAvailable: true };
  if (typeof value.userId === 'string' && value.userId !== identity.userId)
    return { answer: '', submission: null, storageAvailable: true };
  if (typeof value.challengeId === 'string' && value.challengeId !== identity.challengeId)
    return { answer: '', submission: null, storageAvailable: true };

  const answer = value.answer.slice(0, 1800);
  const hasExactIdentity =
    value.version === 2 &&
    value.userId === identity.userId &&
    value.challengeId === identity.challengeId;
  const submission =
    hasExactIdentity &&
    validRequestId(value.clientRequestId) &&
    value.requestAnswer === answer.trim()
      ? {
          answer: value.requestAnswer,
          id: value.clientRequestId,
          ...(validResponseTimeMs(value.requestResponseTimeMs)
            ? { responseTimeMs: value.requestResponseTimeMs }
            : {}),
        }
      : null;
  return { answer, submission, storageAvailable: true };
}

export function saveOutputDraft(
  identity: OutputDraftIdentity,
  answer: string,
  submission: OutputDraftSubmission | null,
  storage: DraftStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  const savedAnswer = answer.slice(0, 1800);
  const validSubmission =
    submission && submission.answer === savedAnswer.trim() && validRequestId(submission.id)
      ? submission
      : null;
  const value = {
    version: 2,
    userId: identity.userId,
    challengeId: identity.challengeId,
    date: identity.date,
    answer: savedAnswer,
    ...(validSubmission
      ? {
          clientRequestId: validSubmission.id,
          requestAnswer: validSubmission.answer,
          ...(validResponseTimeMs(validSubmission.responseTimeMs)
            ? { requestResponseTimeMs: validSubmission.responseTimeMs }
            : {}),
        }
      : {}),
  };
  try {
    storage.setItem(outputDraftKey(identity.userId), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearOutputDraftSubmissionIfMatches(
  identity: OutputDraftIdentity,
  submission: OutputDraftSubmission,
  storage: DraftStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  const key = outputDraftKey(identity.userId);
  let value: unknown;
  try {
    value = JSON.parse(storage.getItem(key) ?? 'null');
  } catch {
    return false;
  }
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.userId !== identity.userId ||
    value.challengeId !== identity.challengeId ||
    value.date !== identity.date ||
    value.clientRequestId !== submission.id ||
    value.requestAnswer !== submission.answer ||
    typeof value.answer !== 'string' ||
    value.answer.trim() !== submission.answer
  )
    return false;

  const draft = { ...value };
  delete draft.clientRequestId;
  delete draft.requestAnswer;
  delete draft.requestResponseTimeMs;
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
