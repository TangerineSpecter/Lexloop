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

export function parseDuePreview(value: unknown): DuePreview | null {
  if (!value || typeof value !== 'object') return null;
  const preview = value as { timeZone?: unknown; days?: unknown };
  if (typeof preview.timeZone !== 'string' || preview.timeZone.length < 1 || preview.timeZone.length > 100) {
    return null;
  }
  if (!Array.isArray(preview.days) || preview.days.length !== DUE_PREVIEW_LABELS.length) return null;
  const days: DuePreviewDay[] = [];
  for (let index = 0; index < DUE_PREVIEW_LABELS.length; index += 1) {
    const day = preview.days[index] as { date?: unknown; label?: unknown; count?: unknown };
    if (!day || typeof day !== 'object') return null;
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return null;
    if (day.label !== DUE_PREVIEW_LABELS[index]) return null;
    if (typeof day.count !== 'number' || !Number.isSafeInteger(day.count) || day.count < 0) return null;
    if (index > 0 && day.date !== shiftDateKey(days[index - 1].date, 1)) return null;
    days.push({ date: day.date, label: DUE_PREVIEW_LABELS[index], count: day.count });
  }
  return { timeZone: preview.timeZone, days };
}

function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
