export const AUTOMATIC_STUDY_PLAN_TIME_ZONE = 'Asia/Shanghai';
export const AUTOMATIC_STUDY_PLAN_QUEUE = 'automatic-study-plan';
export const AUTOMATIC_STUDY_PLAN_DEFAULT_TIME = '06:30';
export const AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS = 2;
export const AUTOMATIC_STUDY_PLAN_RETRY_DELAY_MS = 5 * 60_000;
export const AUTOMATIC_STUDY_PLAN_LEASE_MS = 10 * 60_000;

export type AutomaticStudyPlanClock = {
  dateKey: string;
  minuteOfDay: number;
  due: boolean;
  startsAt: Date;
  dayStartsAt: Date;
  nextDayStartsAt: Date;
};

export function isValidAutomaticStudyPlanTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function automaticStudyPlanClock(
  now: Date,
  scheduleTime = AUTOMATIC_STUDY_PLAN_DEFAULT_TIME,
): AutomaticStudyPlanClock {
  if (!isValidAutomaticStudyPlanTime(scheduleTime)) {
    throw new Error('Automatic study plan time must use HH:mm.');
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AUTOMATIC_STUDY_PLAN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  const dateKey = `${value('year')}-${value('month')}-${value('day')}`;
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  const [scheduleHour, scheduleMinute] = scheduleTime.split(':').map(Number);
  const dayStartsAt = new Date(`${dateKey}T00:00:00+08:00`);
  return {
    dateKey,
    minuteOfDay: hour * 60 + minute,
    due: hour * 60 + minute >= scheduleHour * 60 + scheduleMinute,
    startsAt: new Date(`${dateKey}T${scheduleTime}:00+08:00`),
    dayStartsAt,
    nextDayStartsAt: new Date(dayStartsAt.getTime() + 24 * 60 * 60_000),
  };
}

export function chinaDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AUTOMATIC_STUDY_PLAN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function chinaDateRange(dateKey: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid China date key.');
  const start = new Date(`${dateKey}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || chinaDateKey(start) !== dateKey) {
    throw new Error('Invalid China date key.');
  }
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}
