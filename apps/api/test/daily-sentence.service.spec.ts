import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSentenceDto } from '../src/modules/daily-sentence/daily-sentence.dto';
import { DailySentenceService } from '../src/modules/daily-sentence/daily-sentence.service';
import { dailySentenceClock, normalizeDailySentence } from '../src/modules/daily-sentence/daily-sentence.rules';
import { DailySentenceSettingsService } from '../src/modules/daily-sentence/daily-sentence-settings.service';

const content = {
  english: 'She walked towards the door.', chinese: '她朝门口走去。', level: 'A1', focus: '用 towards 表示方向',
  chunks: [
    { text: 'She', role: '主语', phraseType: '代词', explanation: '说明是谁在走。' },
    { text: 'walked', role: '谓语动词', phraseType: '动词（V）', explanation: '过去式说明动作发生在过去。' },
    { text: 'towards the door.', role: '方向状语', phraseType: '介词短语（PP）', explanation: '说明朝哪个方向走。' },
  ],
  explanations: [{ question: '为什么用 towards？', answer: '表示朝某个方向移动，不说明一定已经到达。' }],
  pattern: '主语 + 移动动词 + towards + 地点', usage: '说人或物朝某个方向移动时使用。',
  example: { english: 'He ran towards the park.', chinese: '他朝公园跑去。' }, learningReason: '学习证据较少，先从基础短句开始。',
};
const row = { id: 'sentence', userId: 'user', dateKey: '2026-10-22', content, status: 'READY', readAt: null, favorite: false, difficulty: null, attempts: 1, generationToken: 'token' };

function harness() {
  const prisma = {
    systemFeatureSetting: { findUnique: vi.fn().mockResolvedValue({ enabled: true }), upsert: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'user' }]),
    dailySentence: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), upsert: vi.fn().mockResolvedValue({ ...row, status: 'GENERATING' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ selectedAiModel: { isEnabled: true } }), findMany: vi.fn().mockResolvedValue([]) },
    languageProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    userWordProgress: { findMany: vi.fn().mockResolvedValue([{ bookWord: { word: { text: 'walk' } } }]) },
    weaknessSignal: { findMany: vi.fn().mockResolvedValue([]) },
    aiCallAudit: { create: vi.fn().mockResolvedValue({ id: 'audit' }), update: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  const ai = { selectedChatCompletions: vi.fn().mockResolvedValue({ json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) }) };
  const settings = new DailySentenceSettingsService(prisma as never);
  const service = new DailySentenceService(prisma as never, ai as never, settings);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T02:00:00Z'));
  return { prisma, ai, service, settings };
}
afterEach(() => { vi.useRealTimers(); });

describe('daily sentence scheduling and content', () => {
  it('rejects null and malformed interaction fields before database writes', async () => {
    for (const value of [{ favorite: null }, { favorite: 'true' }, { difficulty: null }, { difficulty: 'INVALID' }]) {
      expect(await validate(plainToInstance(UpdateSentenceDto, value))).not.toHaveLength(0);
    }
    for (const value of [{}, { favorite: false }, { difficulty: 'HARD' }]) {
      expect(await validate(plainToInstance(UpdateSentenceDto, value))).toHaveLength(0);
    }
  });
  it('uses an exclusive user id boundary when candidates change between pages', async () => {
    const { prisma, service } = harness();
    await service.candidates('2026-10-22', 'previous-page-last-user');
    const query = prisma.user.findMany.mock.calls[0][0];
    expect(query.where.id).toEqual({ gt: 'previous-page-last-user' });
    expect(query).not.toHaveProperty('skip');
    expect(query).not.toHaveProperty('cursor');
  });
  it('defaults to enabled and persists the global switch', async () => {
    const { prisma, settings } = harness();
    prisma.systemFeatureSetting.findUnique.mockResolvedValue(null as never);
    expect(await settings.get()).toEqual({ enabled: true });
    prisma.systemFeatureSetting.upsert.mockResolvedValue({ enabled: false });
    expect(await settings.set(false)).toEqual({ enabled: false });
    expect(prisma.systemFeatureSetting.upsert).toHaveBeenCalledWith({ where: { key: 'daily-sentence' }, create: { key: 'daily-sentence', enabled: false }, update: { enabled: false } });
  });
  it('hides the homepage and blocks scheduled, queued, and retry generation when disabled', async () => {
    const { prisma, service, ai } = harness();
    prisma.systemFeatureSetting.findUnique.mockResolvedValue({ enabled: false });
    expect(await service.current('user')).toEqual({ state: 'DISABLED', item: null, canRetry: false });
    expect(await service.candidates('2026-10-22')).toEqual([]);
    await service.generate('user', '2026-10-22');
    await expect(service.retryable('user')).rejects.toThrow();
    expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
    expect(prisma.dailySentence.upsert).not.toHaveBeenCalled();
  });
  it('preserves history and favorites while disabled and resumes the existing unread after enabling', async () => {
    const { prisma, service } = harness();
    prisma.systemFeatureSetting.findUnique.mockResolvedValue({ enabled: false });
    prisma.dailySentence.findMany.mockResolvedValue([{ ...row, favorite: true }] as never);
    expect((await service.history('user', 1, true)).items[0].favorite).toBe(true);
    prisma.systemFeatureSetting.findUnique.mockResolvedValue({ enabled: true });
    prisma.dailySentence.findFirst.mockResolvedValue(row);
    expect((await service.current('user')).item?.id).toBe('sentence');
  });
  it('starts at 06:00 Beijing time and changes date at local midnight', () => {
    expect(dailySentenceClock(new Date('2026-10-21T21:59:59Z'))).toMatchObject({ dateKey: '2026-10-22', due: false });
    expect(dailySentenceClock(new Date('2026-10-21T22:00:00Z'))).toEqual({ dateKey: '2026-10-22', due: true, cutoff: new Date('2026-10-21T22:00:00Z') });
    expect(dailySentenceClock(new Date('2026-10-22T16:00:00Z'))).toMatchObject({ dateKey: '2026-10-23', due: false });
  });
  it('accepts complete aligned teaching content', () => { expect(normalizeDailySentence(content)).toEqual(content); });
  it.each([
    { ...content, chunks: content.chunks.slice(1) },
    { ...content, chunks: [...content.chunks].reverse() },
    { ...content, chunks: [{ ...content.chunks[0], text: 'He' }, ...content.chunks.slice(1)] },
    { ...content, explanations: [] },
    { ...content, usage: 'Use this for motion.' },
    { ...content, level: 'C2' },
    { ...content, english: Array(25).fill('word').join(' ') },
  ])('rejects misaligned, incomplete, or inaccessible content', input => { expect(() => normalizeDailySentence(input)).toThrow(BadGatewayException); });

  it('retains an unread sentence and never calls AI when the homepage loads', async () => {
    const { prisma, ai, service } = harness();
    prisma.dailySentence.findFirst.mockResolvedValue(row);
    const current = await service.current('user');
    expect(current).toMatchObject({ item: { id: 'sentence', readAt: null }, state: 'READY', canRetry: false });
    expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
    expect(prisma.dailySentence.updateMany).not.toHaveBeenCalled();
  });
  it('does not generate when an unread sentence exists, even from an older day', async () => {
    const { prisma, service, ai } = harness();
    prisma.dailySentence.findFirst.mockResolvedValue({ ...row, dateKey: '2026-10-20' });
    await service.generate('user', '2026-10-22');
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.dailySentence.upsert).not.toHaveBeenCalled();
    expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
  });
  it('blocks replenishment after a sentence is read after the daily cutoff', async () => {
    const { prisma, service } = harness();
    await service.candidates('2026-10-22');
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ dailySentences: { none: { status: 'READY', OR: [{ readAt: null }, { readAt: { gte: new Date('2026-10-21T22:00:00Z') } }] } } }) }));
    prisma.dailySentence.findFirst.mockResolvedValue({ ...row, readAt: new Date('2026-10-22T01:00:00Z') });
    expect(await service.claim('user', '2026-10-22')).toBeNull();
  });
  it('does not backfill or generate before the scheduled hour', async () => {
    const { prisma, service } = harness();
    expect(await service.claim('user', '2026-10-21')).toBeNull();
    vi.setSystemTime(new Date('2026-10-21T21:00:00Z'));
    expect(await service.claim('user', '2026-10-22')).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('does not replace a successful sentence even if it is already read', async () => {
    const { prisma, service } = harness();
    prisma.dailySentence.findUnique.mockResolvedValue({ ...row, readAt: new Date() });
    expect(await service.claim('user', '2026-10-22')).toBeNull();
  });
  it('bounds paid attempts and blocks overlapping reservations', async () => {
    const { prisma, service } = harness();
    prisma.dailySentence.findUnique.mockResolvedValue({ ...row, status: 'FAILED', attempts: 3 });
    expect(await service.claim('user', '2026-10-22')).toBeNull();
    prisma.dailySentence.findUnique.mockResolvedValue(null);
    prisma.dailySentence.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...row, status: 'GENERATING' });
    expect(await service.claim('user', '2026-10-22')).toBeNull();
  });
  it('skips users without a usable selected model', async () => {
    const { prisma, service, ai } = harness();
    prisma.user.findUnique.mockResolvedValue({ selectedAiModel: null });
    await service.generate('user', '2026-10-22');
    expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
  });
  it('uses learning evidence and the user model, then stores a guarded completion', async () => {
    const { prisma, service, ai } = harness();
    await service.generate('user', '2026-10-22');
    expect(ai.selectedChatCompletions).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('"knownWords":["walk"]') })]) }), 'user', expect.any(AbortSignal));
    expect(prisma.dailySentence.updateMany).toHaveBeenCalledWith({ where: { id: 'sentence', status: 'GENERATING', generationToken: 'token' }, data: { status: 'READY', content, error: null, generationToken: null } });
  });
  it('fails safely without saving malformed AI output', async () => {
    const { prisma, service, ai } = harness();
    ai.selectedChatCompletions.mockResolvedValue({ json: async () => ({ choices: [{ message: { content: '{secret bad payload' } }] }) });
    await expect(service.generate('user', '2026-10-22')).rejects.toThrow('Daily sentence generation failed');
    expect(prisma.dailySentence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', error: '生成未完成，请检查模型配置或稍后重试。' }) }));
    expect(prisma.aiCallAudit.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
  });
  it('scopes read, favorite, and detail operations to the current user', async () => {
    const { prisma, service } = harness();
    prisma.dailySentence.findFirst.mockResolvedValue(row);
    await service.read('user', 'sentence');
    expect(prisma.dailySentence.updateMany).toHaveBeenCalledWith({ where: { id: 'sentence', userId: 'user', status: 'READY', readAt: null }, data: { readAt: expect.any(Date) } });
    await service.update('user', 'sentence', { favorite: true, difficulty: 'HARD' });
    expect(prisma.dailySentence.updateMany).toHaveBeenCalledWith({ where: { id: 'sentence', userId: 'user', status: 'READY' }, data: { favorite: true, difficulty: 'HARD' } });
    prisma.dailySentence.findFirst.mockResolvedValue(null);
    await expect(service.detail('other-user', 'sentence')).rejects.toThrow(NotFoundException);
  });
  it('paginates history and filters favorites without generating or marking read', async () => {
    const { prisma, service, ai } = harness();
    prisma.dailySentence.findMany.mockResolvedValue(Array.from({ length: 21 }, (_, index) => ({ ...row, id: `sentence-${index}` })));
    const result = await service.history('user', 2, true);
    expect(result.items).toHaveLength(20); expect(result.hasMore).toBe(true);
    expect(prisma.dailySentence.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user', status: 'READY', favorite: true }, skip: 20, take: 21 }));
    expect(ai.selectedChatCompletions).not.toHaveBeenCalled();
    expect(prisma.dailySentence.updateMany).not.toHaveBeenCalled();
  });
});
