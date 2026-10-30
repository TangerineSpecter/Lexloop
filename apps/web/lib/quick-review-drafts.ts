export type QuickReviewDraft = {
  version: 1;
  userId: string;
  wordIds: string[];
  currentIndex: number;
  revealed: boolean;
};

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type QuickReviewDraftRead = {
  draft: QuickReviewDraft | null;
  storageAvailable: boolean;
  stale: boolean;
};

const DRAFT_FIELDS = ['currentIndex', 'revealed', 'userId', 'version', 'wordIds'];

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

function draftKey(userId: string) {
  return `lexloop.quick-review.v1.${encodeKeyPart(userId)}.due`;
}

function validDraft(value: unknown, userId: string): value is QuickReviewDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const draft = value as Partial<QuickReviewDraft>;
  const fields = Object.keys(value).sort();
  return (
    fields.length === DRAFT_FIELDS.length &&
    fields.every((field, index) => field === DRAFT_FIELDS[index]) &&
    draft.version === 1 &&
    draft.userId === userId &&
    Array.isArray(draft.wordIds) &&
    draft.wordIds.length >= 1 &&
    draft.wordIds.length <= 10 &&
    draft.wordIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100) &&
    new Set(draft.wordIds).size === draft.wordIds.length &&
    Number.isInteger(draft.currentIndex) &&
    (draft.currentIndex as number) >= 0 &&
    (draft.currentIndex as number) < draft.wordIds.length &&
    typeof draft.revealed === 'boolean'
  );
}

function samePrefix(prefix: string[], values: string[]) {
  return prefix.length === values.length && prefix.every((value, index) => value === values[index]);
}

export function readQuickReviewDraft(
  userId: string,
  currentDueWordIds: string[],
  storage: DraftStorage | undefined = browserStorage(),
): QuickReviewDraftRead {
  if (!storage) return { draft: null, storageAvailable: false, stale: false };
  const key = draftKey(userId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { draft: null, storageAvailable: false, stale: false };
  }
  if (raw === null) return { draft: null, storageAvailable: true, stale: false };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      return { draft: null, storageAvailable: false, stale: false };
    }
    return { draft: null, storageAvailable: true, stale: false };
  }

  if (!validDraft(value, userId)) {
    try {
      storage.removeItem(key);
    } catch {
      return { draft: null, storageAvailable: false, stale: false };
    }
    return { draft: null, storageAvailable: true, stale: false };
  }

  const stillCurrent = samePrefix(currentDueWordIds.slice(0, value.wordIds.length), value.wordIds);
  if (!stillCurrent) {
    try {
      storage.removeItem(key);
    } catch {
      return { draft: null, storageAvailable: false, stale: true };
    }
    return { draft: null, storageAvailable: true, stale: true };
  }

  return { draft: value, storageAvailable: true, stale: false };
}

export function saveQuickReviewDraft(
  draft: QuickReviewDraft,
  storage: DraftStorage | undefined = browserStorage(),
) {
  if (!storage) return false;
  try {
    const safeDraft: QuickReviewDraft = {
      version: 1,
      userId: draft.userId,
      wordIds: [...draft.wordIds],
      currentIndex: draft.currentIndex,
      revealed: draft.revealed,
    };
    storage.setItem(draftKey(draft.userId), JSON.stringify(safeDraft));
    return true;
  } catch {
    return false;
  }
}

export function clearQuickReviewDraft(
  userId: string,
  storage: DraftStorage | undefined = browserStorage(),
) {
  if (!storage) return false;
  try {
    storage.removeItem(draftKey(userId));
    return true;
  } catch {
    return false;
  }
}
