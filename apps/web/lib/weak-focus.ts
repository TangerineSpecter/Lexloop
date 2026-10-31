export const WEAK_FOCUS_WORD_COUNT = 8;

const KEY_PREFIX = 'lexloop.weak-focus.v1.';

export function rememberWeakFocus(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  planId: string,
) {
  if (!userId || !planId || planId.length > 200) return;
  storage.setItem(`${KEY_PREFIX}${userId}`, planId);
}

export function readWeakFocusPlanId(storage: Pick<Storage, 'getItem'>, userId: string) {
  try {
    const value = storage.getItem(`${KEY_PREFIX}${userId}`);
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}

export function parseWeakFocusCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}
