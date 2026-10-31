function localDateKey(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return 'invalid-date';
  return `${year}-${month}-${day}`;
}

function calendarDaysBetween(earlier: Date, later: Date, timeZone: string) {
  const start = Date.parse(`${localDateKey(timeZone, earlier)}T00:00:00Z`);
  const end = Date.parse(`${localDateKey(timeZone, later)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export function reviewDueReason(input: {
  now: Date;
  lastReviewedAt?: string | null;
  nextReviewAt?: string | null;
  lastIntervalDays?: number | null;
  timeZone: string;
}): string | null {
  if (!input.nextReviewAt) return null;
  const next = new Date(input.nextReviewAt);
  if (Number.isNaN(next.getTime()) || next.getTime() > input.now.getTime()) return null;

  const overdueDays = calendarDaysBetween(next, input.now, input.timeZone);
  const interval =
    typeof input.lastIntervalDays === 'number' &&
    Number.isSafeInteger(input.lastIntervalDays) &&
    input.lastIntervalDays > 0
      ? input.lastIntervalDays
      : null;
  const last = input.lastReviewedAt ? new Date(input.lastReviewedAt) : null;
  if (!last || Number.isNaN(last.getTime())) {
    return overdueDays > 0 ? `已过到期日 ${overdueDays} 天` : '已到复习时间';
  }

  const sinceDays = calendarDaysBetween(last, input.now, input.timeZone);
  const parts = [`距上次复习 ${sinceDays} 天`];
  if (interval) parts.push(`计划间隔 ${interval} 天`);
  else if (overdueDays > 0) parts.push(`已过到期日 ${overdueDays} 天`);
  return parts.join(' · ');
}
