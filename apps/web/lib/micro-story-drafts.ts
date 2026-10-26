const STORY_DRAFT_PREFIX = 'lexloop.micro-story.story.';
const REVIEW_DRAFT_PREFIX = 'lexloop.micro-story.review.';

type StoryDraft = {
  storyKey: string;
  interpretation: string;
  ownSentence: string;
};

function storyDraftKey(userId: string) {
  return `${STORY_DRAFT_PREFIX}${encodeKeyPart(userId)}`;
}

function reviewDraftKey(userId: string, reviewId: string) {
  return `${REVIEW_DRAFT_PREFIX}${encodeKeyPart(userId)}.${encodeKeyPart(reviewId)}`;
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

export function readStoryDraft(userId: string, storyKey: string | null): StoryDraft | null {
  const key = storyDraftKey(userId);
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      localStorage.removeItem(key);
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      localStorage.removeItem(key);
      return null;
    }
    const draft = parsed as Partial<StoryDraft>;
    if (!storyKey || draft.storyKey !== storyKey) {
      localStorage.removeItem(key);
      return null;
    }
    return {
      storyKey,
      interpretation:
        typeof draft.interpretation === 'string' ? draft.interpretation.slice(0, 500) : '',
      ownSentence: typeof draft.ownSentence === 'string' ? draft.ownSentence.slice(0, 280) : '',
    };
  } catch {
    return null;
  }
}

export function saveStoryDraft(userId: string, draft: StoryDraft) {
  try {
    localStorage.setItem(storyDraftKey(userId), JSON.stringify(draft));
  } catch {
    // Storage is optional; the in-memory draft remains usable.
  }
}

export function clearStoryDraft(userId: string) {
  try {
    localStorage.removeItem(storyDraftKey(userId));
  } catch {
    // Storage is optional.
  }
}

export function readReviewDraft(userId: string, reviewId: string): string {
  try {
    const value = localStorage.getItem(reviewDraftKey(userId, reviewId));
    return value ? value.slice(0, 500) : '';
  } catch {
    return '';
  }
}

export function saveReviewDraft(userId: string, reviewId: string, attempt: string) {
  try {
    localStorage.setItem(reviewDraftKey(userId, reviewId), attempt.slice(0, 500));
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
  const reviewPrefix = `${REVIEW_DRAFT_PREFIX}${encodeKeyPart(userId)}.`;
  try {
    localStorage.removeItem(storyDraftKey(userId));
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(reviewPrefix)) localStorage.removeItem(key);
    }
  } catch {
    // Storage is optional.
  }
}
