import { BadGatewayException } from '@nestjs/common';
import type { DailySentenceContent } from '@lexloop/types';

export const DAILY_SENTENCE_QUEUE = 'daily-sentence';
export const DAILY_SENTENCE_TIME_ZONE = 'Asia/Shanghai';
export const DAILY_SENTENCE_HOUR = 6;
export const MAX_GENERATION_ATTEMPTS = 3;

export function dailySentenceClock(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_SENTENCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const dateKey = `${part('year')}-${part('month')}-${part('day')}`;
  return {
    dateKey,
    due: Number(part('hour')) >= DAILY_SENTENCE_HOUR,
    cutoff: new Date(`${dateKey}T06:00:00+08:00`),
  };
}

export function normalizeDailySentence(raw: unknown): DailySentenceContent {
  const fail = () => {
    throw new BadGatewayException('每日一句内容不完整，请稍后重试。');
  };
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fail();
  const text = (value: unknown, max: number, chinese = false): string => {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > max ||
      (chinese && !/[\u3400-\u9fff]/.test(value))
    )
      return fail();
    return value.trim();
  };
  const value = object(raw);
  const english = text(value.english, 220);
  if (english.split(/\s+/).length < 3 || english.split(/\s+/).length > 24) return fail();
  if (!Array.isArray(value.chunks) || value.chunks.length < 2 || value.chunks.length > 8)
    return fail();
  const chunks = value.chunks.map((item) => {
    const chunk = object(item);
    return {
      text: text(chunk.text, 220),
      role: text(chunk.role, 50, true),
      phraseType: text(chunk.phraseType, 60, true),
      explanation: text(chunk.explanation, 500, true),
    };
  });
  // Ignore only whitespace. Every word and punctuation mark must appear exactly once, in order.
  if (
    chunks
      .map((chunk) => chunk.text)
      .join('')
      .replace(/\s/g, '') !== english.replace(/\s/g, '')
  )
    return fail();
  if (
    !Array.isArray(value.explanations) ||
    value.explanations.length < 1 ||
    value.explanations.length > 3
  )
    return fail();
  const explanations = value.explanations.map((item) => {
    const entry = object(item);
    return { question: text(entry.question, 150, true), answer: text(entry.answer, 800, true) };
  });
  const example = object(value.example);
  const level = text(value.level, 2);
  if (!['A1', 'A2', 'B1', 'B2', 'C1'].includes(level)) return fail();
  return {
    english,
    chinese: text(value.chinese, 300, true),
    level,
    focus: text(value.focus, 100, true),
    chunks,
    explanations,
    pattern: text(value.pattern, 300, true),
    usage: text(value.usage, 600, true),
    example: { english: text(example.english, 220), chinese: text(example.chinese, 300, true) },
    learningReason: text(value.learningReason, 300, true),
  };
}
