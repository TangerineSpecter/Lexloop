import type { OutputFeedback, OutputTarget, WeeklyPrescription } from '@lexloop/types';

const DAY = 86_400_000;
export function practiceDate(now = new Date(), timezone = 'Asia/Shanghai') {
  const value = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${value}T00:00:00.000Z`);
}
export function practiceWeek(date: Date) {
  const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY);
  return {
    start: monday.toISOString().slice(0, 10),
    end: new Date(monday.getTime() + 6 * DAY).toISOString().slice(0, 10),
  };
}
function practiceDateStart(date: Date, timezone: string) {
  let candidate = date.getTime();
  for (let index = 0; index < 3; index++) {
    const zone =
      new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(candidate))
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(zone);
    const offset = match
      ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1)
      : 0;
    candidate = date.getTime() - offset * 60_000;
  }
  return new Date(candidate);
}
export function practiceDayStart(now = new Date(), timezone = 'Asia/Shanghai') {
  return practiceDateStart(practiceDate(now, timezone), timezone);
}
export function practiceLookbackStart(
  now = new Date(),
  calendarDays = 7,
  timezone = 'Asia/Shanghai',
) {
  if (!Number.isInteger(calendarDays) || calendarDays < 1)
    throw new RangeError('calendarDays must be a positive integer');
  const firstDate = new Date(practiceDate(now, timezone).getTime() - (calendarDays - 1) * DAY);
  return practiceDateStart(firstDate, timezone);
}
export function englishWordPresent(answer: string, word: string) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z])${escaped}(?![a-z])`, 'i').test(answer);
}
function text(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('批改内容格式不完整，请重试');
  return value.trim();
}
function score(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
    throw new Error('批改分数格式无效，请重试');
  return Math.round(value);
}
export function normalizeOutputFeedback(
  raw: unknown,
  targets: OutputTarget[],
  answer: string,
): OutputFeedback {
  if (!raw || typeof raw !== 'object') throw new Error('批改结果格式无效，请重试');
  const data = raw as Record<string, unknown>;
  if (
    !Array.isArray(data.words) ||
    data.words.length !== targets.length ||
    !Array.isArray(data.comments) ||
    data.comments.length > 6
  )
    throw new Error('批改结果缺少逐词反馈，请重试');
  const rows = data.words as Array<Record<string, unknown>>;
  if (new Set(rows.map((row) => row?.bookWordId)).size !== targets.length)
    throw new Error('批改词汇重复，请重试');
  const words = targets.map((target) => {
    const row = rows.find((value) => value?.bookWordId === target.bookWordId);
    if (
      !row ||
      typeof row.used !== 'boolean' ||
      typeof row.correct !== 'boolean' ||
      (row.correct && !row.used)
    )
      throw new Error('批改词汇不匹配，请重试');
    const used = englishWordPresent(answer, target.word);
    return {
      bookWordId: target.bookWordId,
      used,
      correct: used && row.used && row.correct,
      feedback: used ? text(row.feedback, 500) : `未找到 ${target.word}，请保留给定拼写再试一次。`,
    };
  });
  const grammarScore = score(data.grammarScore);
  const coherenceScore = score(data.coherenceScore);
  return {
    grammarScore,
    coherenceScore,
    score: Math.round(
      (words.filter((word) => word.correct).length / targets.length) * 60 +
        grammarScore * 0.25 +
        coherenceScore * 0.15,
    ),
    correctedText: text(data.correctedText, 3000),
    comments: data.comments.map((value) => text(value, 500)),
    words,
  };
}

export function weeklyActions(
  summary: WeeklyPrescription['summary'],
  suggestedGroup?: string,
): WeeklyPrescription['actions'] {
  return [
    {
      id: 'output',
      title: summary.outputs ? '把学过的词再用一次' : '完成一次主动表达',
      reason: summary.outputs
        ? `近 7 天已完成 ${summary.outputs} 次输出，继续练习不同表达。`
        : '近 7 天还没有完成输出挑战，先把认识的词写进句子。',
      instruction: '使用今天的目标词写一小段英文，根据反馈重写。',
      minutes: 5,
      href: '/dashboard/practice?tab=output',
    },
    {
      id: 'confusion',
      title: '分清容易混淆的表达',
      reason: summary.contrasts
        ? `近 7 天已练习 ${summary.contrasts} 组，可重练错题或换一组。`
        : '近 7 天还没有对比训练，先做一组检查词义和搭配差异。',
      instruction: '先完成填空，再对照规则复盘；间隔一天重练。',
      minutes: 4,
      href: `/dashboard/practice?tab=confusion${suggestedGroup ? `&group=${encodeURIComponent(suggestedGroup)}` : ''}`,
    },
    summary.dueReviews > 0
      ? {
          id: 'review',
          title: '优先清理到期复习',
          reason: `当前有 ${summary.dueReviews} 个词到期，先处理积压再增加新词。`,
          instruction: '回到首页，从待复习单词开始一轮学习。',
          minutes: 6,
          href: '/dashboard',
        }
      : summary.weaknesses > 0
        ? {
            id: 'weakness',
            title: '回访待巩固单词',
            reason: `当前有 ${summary.weaknesses} 项待巩固记录，适合做针对练习。`,
            instruction: '打开待巩固，选择薄弱词生成专项或回到对应题型。',
            minutes: 6,
            href: '/dashboard?view=mistakes',
          }
        : {
            id: 'study',
            title: '留下一次新的学习记录',
            reason: summary.attempts
              ? `近 7 天完成 ${summary.attempts} 道词汇题，保持小步学习。`
              : '词汇答题证据还不足，暂不判断你的强弱项。',
            instruction: '选择一本词书，完成一个学习分组，再回来看处方。',
            minutes: 6,
            href: '/dashboard',
          },
  ];
}
