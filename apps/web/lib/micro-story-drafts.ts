const STORY_DRAFT_PREFIX = 'lexloop.micro-story.story.';
const REVIEW_DRAFT_PREFIX = 'lexloop.micro-story.review.';

type ReviewDraft = { attempt: string; requiresRestore: boolean } | null;

type StoryDraft = {
  storyKey: string;
  interpretation: string;
  ownSentence: string;
};

function legacyStoryDraftKey(userId: string) {
  return `${STORY_DRAFT_PREFIX}${encodeKeyPart(userId)}`;
}

function storyDraftKey(userId: string, storyKey: string) {
  return `${STORY_DRAFT_PREFIX}${encodeKeyPart(userId)}.${encodeKeyPart(storyKey)}`;
}

function reviewDraftKey(userId: string, reviewId: string) {
  return `${REVIEW_DRAFT_PREFIX}${encodeKeyPart(userId)}.${encodeKeyPart(reviewId)}`;
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

export function readStoryDraft(userId: string, storyKey: string | null): StoryDraft | null {
  if (!storyKey) return null;
  const key = storyDraftKey(userId, storyKey);
  try {
    const directValue = localStorage.getItem(key);
    const sourceKey = directValue === null ? legacyStoryDraftKey(userId) : key;
    const value = directValue ?? localStorage.getItem(sourceKey);
    if (!value) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      localStorage.removeItem(sourceKey);
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      localStorage.removeItem(sourceKey);
      return null;
    }
    const draft = parsed as Partial<StoryDraft>;
    if (draft.storyKey !== storyKey) {
      if (sourceKey === key) localStorage.removeItem(key);
      // Keep a legacy draft for its own story so selecting another story cannot erase it.
      return null;
    }
    const restored = {
      storyKey,
      interpretation:
        typeof draft.interpretation === 'string' ? draft.interpretation.slice(0, 500) : '',
      ownSentence: typeof draft.ownSentence === 'string' ? draft.ownSentence.slice(0, 280) : '',
    };
    if (sourceKey !== key) {
      try {
        localStorage.setItem(key, JSON.stringify(restored));
        localStorage.removeItem(sourceKey);
      } catch {
        // A legacy draft remains readable even if storage cannot migrate it.
      }
    }
    return restored;
  } catch {
    return null;
  }
}

export function saveStoryDraft(userId: string, draft: StoryDraft) {
  try {
    localStorage.setItem(storyDraftKey(userId, draft.storyKey), JSON.stringify(draft));
  } catch {
    // Storage is optional; the in-memory draft remains usable.
  }
}

export function clearStoryDraft(userId: string, storyKey: string) {
  try {
    localStorage.removeItem(storyDraftKey(userId, storyKey));
    const legacyKey = legacyStoryDraftKey(userId);
    const legacy = localStorage.getItem(legacyKey);
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as Partial<StoryDraft>;
        if (parsed.storyKey === storyKey) localStorage.removeItem(legacyKey);
      } catch {
        localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Storage is optional.
  }
}

export function readReviewDraft(userId: string, reviewId: string, dueAt: string): ReviewDraft {
  try {
    const value = localStorage.getItem(reviewDraftKey(userId, reviewId));
    if (!value) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Earlier releases stored the learner's text directly. Its review cycle is unknown,
      // so keep it available for an explicit restore instead of pre-filling a new attempt.
      return { attempt: value.slice(0, 500), requiresRestore: true };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { attempt: value.slice(0, 500), requiresRestore: true };
    }

    const draft = parsed as { version?: unknown; attempt?: unknown; dueAt?: unknown };
    if (
      draft.version !== 1 ||
      typeof draft.attempt !== 'string' ||
      typeof draft.dueAt !== 'string'
    ) {
      return { attempt: value.slice(0, 500), requiresRestore: true };
    }

    if (draft.dueAt !== dueAt) {
      localStorage.removeItem(reviewDraftKey(userId, reviewId));
      return null;
    }
    return { attempt: draft.attempt.slice(0, 500), requiresRestore: false };
  } catch {
    return null;
  }
}

export function saveReviewDraft(userId: string, reviewId: string, dueAt: string, attempt: string) {
  try {
    localStorage.setItem(
      reviewDraftKey(userId, reviewId),
      JSON.stringify({ version: 1, dueAt, attempt: attempt.slice(0, 500) }),
    );
  } catch {
    // Storage is optional; the in-memory draft remains usable.
  }
}

export function clearReviewDraft(userId: string, reviewId: string) {
  try {
    localStorage.removeItem(reviewDraftKey(userId, reviewId));
  } catch {
    // Storage is optional.
  }
}

export function clearMicroStoryDrafts(userId: string) {
  const storyPrefix = `${STORY_DRAFT_PREFIX}${encodeKeyPart(userId)}.`;
  const reviewPrefix = `${REVIEW_DRAFT_PREFIX}${encodeKeyPart(userId)}.`;
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (
        key &&
        (key === legacyStoryDraftKey(userId) ||
          key.startsWith(storyPrefix) ||
          key.startsWith(reviewPrefix))
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage is optional.
  }
}
