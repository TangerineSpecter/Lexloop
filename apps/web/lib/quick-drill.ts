export const QUICK_DRILL_WORD_COUNT = 10;

const KEY_PREFIX = 'lexloop.quick-drill.v1.';

export function rememberQuickDrill(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  planId: string,
) {
  if (!userId || !planId || planId.length > 200) return;
  storage.setItem(`${KEY_PREFIX}${userId}`, planId);
}

export function readQuickDrillPlanId(storage: Pick<Storage, 'getItem'>, userId: string) {
  try {
    const value = storage.getItem(`${KEY_PREFIX}${userId}`);
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}
