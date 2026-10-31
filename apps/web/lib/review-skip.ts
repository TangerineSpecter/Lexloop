const KEY_PREFIX = 'lexloop.review-skip.v1.';
const SKIP_LIMIT = 40;

type StoredSkips = { date: string; ids: string[] };

export function readReviewSkips(storage: Pick<Storage, 'getItem'>, userId: string, date: string) {
  const stored = readStored(storage, userId);
  return stored?.date === date ? stored.ids : [];
}

export function writeReviewSkips(
  storage: Pick<Storage, 'setItem'>,
  userId: string,
  date: string,
  ids: string[],
) {
  if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const next = uniqueIds(ids);
  storage.setItem(`${KEY_PREFIX}${userId}`, JSON.stringify({ date, ids: next }));
}

export function toggleReviewSkip(ids: string[], wordId: string) {
  if (!isWordId(wordId)) return ids;
  return ids.includes(wordId) ? ids.filter((id) => id !== wordId) : uniqueIds([...ids, wordId]);
}

export function orderWithSkips<T extends { id?: string | null }>(words: T[], skipped: string[]) {
  if (!skipped.length) return words;
  const skippedSet = new Set(skipped);
  const leading = words.filter((word) => !word.id || !skippedSet.has(word.id));
  const trailing = words.filter((word) => word.id && skippedSet.has(word.id));
  return [...leading, ...trailing];
}

function readStored(storage: Pick<Storage, 'getItem'>, userId: string): StoredSkips | null {
  try {
    const raw = storage.getItem(`${KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSkips>;
    if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null;
    if (!Array.isArray(value.ids)) return null;
    return { date: value.date, ids: uniqueIds(value.ids) };
  } catch {
    return null;
  }
}

function uniqueIds(ids: unknown[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (!isWordId(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= SKIP_LIMIT) break;
  }
  return next;
}

function isWordId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
