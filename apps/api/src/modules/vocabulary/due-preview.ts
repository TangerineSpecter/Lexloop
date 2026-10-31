export const DUE_PREVIEW_LABELS = ['今天', '明天', '后天', '大后天'] as const;

export type DuePreviewDay = {
  date: string;
  label: (typeof DUE_PREVIEW_LABELS)[number];
  count: number;
};

export type DuePreview = {
  timeZone: string;
  days: DuePreviewDay[];
};

export function resolveTimeZone(value: string | undefined) {
  const raw = (value ?? '').trim() || 'UTC';
  if (raw.length > 100) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function localDateKey(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildDuePreview(input: {
  dueAt: Array<Date | string | null | undefined>;
  now: Date;
  timeZone: string | undefined;
}): DuePreview | null {
  const timeZone = resolveTimeZone(input.timeZone);
  const today = localDateKey(timeZone, input.now);
  if (!today) return null;
  const days: DuePreviewDay[] = [];
  for (let offset = 0; offset < DUE_PREVIEW_LABELS.length; offset += 1) {
    const date = shiftDateKey(today, offset);
    if (!date) return null;
    days.push({ date, label: DUE_PREVIEW_LABELS[offset], count: 0 });
  }
  const indexByDate = new Map(days.map((day, index) => [day.date, index]));
  for (const value of input.dueAt) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    const key = localDateKey(timeZone, date);
    if (!key) continue;
    const index = key < today ? 0 : indexByDate.get(key);
    if (index === undefined) continue;
    days[index].count += 1;
  }
  return { timeZone, days };
}
