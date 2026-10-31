const KEY_PREFIX = 'lexloop.due-cleared.v1.';

export type DueClearState = {
  date: string;
  seenDue: boolean;
  dismissed: boolean;
};

export function nextDueClearState(
  previous: DueClearState | null,
  date: string,
  reviewCount: number,
): { show: boolean; next: DueClearState } {
  const sameDay = previous?.date === date ? previous : null;
  if (!Number.isSafeInteger(reviewCount) || reviewCount < 0) {
    return {
      show: false,
      next: sameDay ?? { date, seenDue: false, dismissed: false },
    };
  }
  if (reviewCount > 0) {
    return { show: false, next: { date, seenDue: true, dismissed: false } };
  }
  const seenDue = Boolean(sameDay?.seenDue);
  const dismissed = Boolean(sameDay?.dismissed && seenDue);
  return {
    show: seenDue && !dismissed,
    next: { date, seenDue, dismissed },
  };
}

export function dismissDueClear(state: DueClearState): DueClearState {
  return { ...state, dismissed: true };
}

export function readDueClearState(storage: Pick<Storage, 'getItem'>, userId: string) {
  try {
    const raw = storage.getItem(`${KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DueClearState>;
    if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null;
    if (typeof value.seenDue !== 'boolean' || typeof value.dismissed !== 'boolean') return null;
    return { date: value.date, seenDue: value.seenDue, dismissed: value.dismissed };
  } catch {
    return null;
  }
}

export function writeDueClearState(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  state: DueClearState,
) {
  if (!userId) return;
  storage.setItem(`${KEY_PREFIX}${userId}`, JSON.stringify(state));
}
