export type WeekGlanceDay = { label: string; active: boolean };

export type WeekGlance = {
  activeDays: number;
  answeredWords: number;
  newWords: number;
  reviewWords: number;
  days: WeekGlanceDay[];
};

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export function buildWeekGlance(input: {
  today: string;
  activeDates: ReadonlySet<string>;
  attempts: Array<{ date: string; bookWordId: string; source: 'NEW' | 'REVIEW' | null }>;
}): WeekGlance {
  const days: WeekGlanceDay[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = shiftDateKey(input.today, -offset);
    days.push({
      label: offset === 0 ? '今' : weekdayLabel(date),
      active: input.activeDates.has(date),
    });
  }
  const windowStart = shiftDateKey(input.today, -6);
  const inWindow = input.attempts.filter(
    (item) => item.bookWordId && item.date >= windowStart && item.date <= input.today,
  );
  const answered = new Set(inWindow.map((item) => item.bookWordId));
  const fresh = new Set(
    inWindow.filter((item) => item.source === 'NEW').map((item) => item.bookWordId),
  );
  const review = new Set(
    inWindow.filter((item) => item.source === 'REVIEW').map((item) => item.bookWordId),
  );
  return {
    activeDays: days.filter((day) => day.active).length,
    answeredWords: answered.size,
    newWords: fresh.size,
    reviewWords: review.size,
    days,
  };
}

function shiftDateKey(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayLabel(date: string) {
  return WEEKDAY[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? '·';
}
