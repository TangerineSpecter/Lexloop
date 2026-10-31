export type WeekGlance = {
  activeDays: number;
  answeredWords: number;
  newWords: number;
  reviewWords: number;
  days: Array<{ label: string; active: boolean }>;
};

export function parseWeekGlance(value: unknown): WeekGlance | null {
  if (!value || typeof value !== 'object') return null;
  const week = value as Partial<WeekGlance>;
  if (!isCount(week.activeDays) || week.activeDays > 7) return null;
  if (!isCount(week.answeredWords) || !isCount(week.newWords) || !isCount(week.reviewWords)) {
    return null;
  }
  if (!Array.isArray(week.days) || week.days.length !== 7) return null;
  const days = week.days.map((day) => {
    if (!day || typeof day !== 'object') return null;
    const label = (day as { label?: unknown }).label;
    const active = (day as { active?: unknown }).active;
    if (typeof label !== 'string' || label.length < 1 || label.length > 2) return null;
    if (typeof active !== 'boolean') return null;
    return { label, active };
  });
  if (days.some((day) => day === null)) return null;
  const parsed = days as WeekGlance['days'];
  if (parsed.filter((day) => day.active).length !== week.activeDays) return null;
  return {
    activeDays: week.activeDays,
    answeredWords: week.answeredWords!,
    newWords: week.newWords!,
    reviewWords: week.reviewWords!,
    days: parsed,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
