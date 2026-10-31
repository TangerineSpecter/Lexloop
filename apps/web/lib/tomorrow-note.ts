const KEY_PREFIX = 'lexloop.tomorrow-note.v1.';

export function tomorrowPreviewLine(count: number) {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (count === 0) return '明天还没有排到新的到期词。';
  return `明天有 ${count} 个词排到到期。今天留着不做完也没关系。`;
}

export function readTomorrowNoteDismissed(storage: Pick<Storage, 'getItem'>, userId: string) {
  try {
    const raw = storage.getItem(`${KEY_PREFIX}${userId}`);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function dismissTomorrowNote(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  date: string,
) {
  if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  storage.setItem(`${KEY_PREFIX}${userId}`, date);
}
