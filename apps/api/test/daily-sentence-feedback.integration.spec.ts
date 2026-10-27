import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailySentenceService } from '../src/modules/daily-sentence/daily-sentence.service';

const generatedContent = {
  english: 'They left their bags beside the door.',
  chinese: '他们把包放在门旁边。',
  level: 'A1',
  focus: '用 beside 表示位置',
  chunks: [
    { text: 'They', role: '主语', phraseType: '代词', explanation: '说明是谁。' },
    {
      text: 'left their bags',
      role: '谓语和宾语',
      phraseType: '动词短语',
      explanation: '说明做了什么。',
    },
    {
      text: 'beside the door.',
      role: '地点状语',
      phraseType: '介词短语（PP）',
      explanation: '说明包放在哪里。',
    },
  ],
  explanations: [{ question: '为什么用 beside？', answer: 'beside 表示在旁边，不表示贴在一起。' }],
  pattern: 'leave + 物品 + beside + 地点',
  usage: '描述把物品放在某物旁边。',
  example: { english: 'She left her coat beside the chair.', chinese: '她把外套放在椅子旁边。' },
  learningReason: '用一个常见方位词说明物品的位置。',
};

afterEach(() => vi.useRealTimers());

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('daily sentence difficulty feedback', () => {
  it('uses only ratings with a reliable selection time and keeps legacy ratings intact', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T03:00:00.000Z'));
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const emails = [
      `daily-feedback-${fixtureId}-one@example.invalid`,
      `daily-feedback-${fixtureId}-two@example.invalid`,
    ];
    let modelId: string | undefined;
    const userIds: string[] = [];

    try {
      const model = await prisma.aiModelConfig.create({
        data: {
          displayName: 'Daily sentence isolated fixture',
          provider: 'OPENAI_COMPATIBLE',
          model: 'fixture-model',
          baseUrl: 'https://example.invalid',
          encryptedApiKey: 'test-only',
          isEnabled: true,
        },
        select: { id: true },
      });
      modelId = model.id;
      const users = await Promise.all(
        emails.map((email) =>
          prisma.user.create({
            data: { email, passwordHash: 'isolated-test-fixture', selectedAiModelId: model.id },
            select: { id: true },
          }),
        ),
      );
      userIds.push(...users.map((user) => user.id));

      for (const [userIndex, user] of users.entries()) {
        for (let offset = 0; offset < 22; offset++) {
          const date = new Date(Date.UTC(2026, 9, 12 - offset, 12));
          const dateKey = date.toISOString().slice(0, 10);
          await prisma.dailySentence.create({
            data: {
              userId: user.id,
              dateKey,
              status: 'READY',
              content: {
                english:
                  userIndex === 0 && offset === 11
                    ? 'ANCIENT_SENTENCE_OUTSIDE_RECENT_TEN'
                    : `Archived sentence ${userIndex}-${offset}.`,
                focus: '归档句子',
              },
              readAt: new Date(date.getTime() + 60 * 60 * 1000),
              difficulty: userIndex === 0 ? 'RIGHT' : 'EASY',
              difficultyTimestampReliable: userIndex === 0 && offset === 0,
              difficultyUpdatedAt: new Date(date.getTime() + 30 * 60 * 1000),
              attempts: 1,
            },
          });
        }
      }

      const oldSentence = await prisma.dailySentence.findFirstOrThrow({
        where: { userId: users[0].id, dateKey: '2026-10-01' },
        select: { id: true },
      });
      const reliableSentence = await prisma.dailySentence.findFirstOrThrow({
        where: { userId: users[0].id, dateKey: '2026-10-12' },
        select: { id: true },
      });
      const now = new Date();
      const ai = {
        selectedChatCompletions: vi.fn().mockResolvedValue({
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(generatedContent) } }],
          }),
        }),
      };
      const service = new DailySentenceService(
        prisma as never,
        ai as never,
        { get: vi.fn().mockResolvedValue({ enabled: true }) } as never,
      );

      expect(
        await prisma.dailySentence.findUniqueOrThrow({
          where: { id: oldSentence.id },
          select: { difficulty: true, difficultyTimestampReliable: true },
        }),
      ).toEqual({ difficulty: 'RIGHT', difficultyTimestampReliable: false });

      const oldFeedback = await service.history(users[0].id, 1, false, true);
      expect(oldFeedback.items).toHaveLength(20);
      expect(oldFeedback.hasMore).toBe(true);
      expect(
        oldFeedback.items.every((item) => item.difficulty && !item.difficultyTimestampReliable),
      ).toBe(true);
      expect(oldFeedback.items.map((item) => item.id)).not.toContain(reliableSentence.id);
      const remainingOldFeedback = await service.history(users[0].id, 2, false, true);
      expect(remainingOldFeedback.items).toHaveLength(1);
      expect(remainingOldFeedback.hasMore).toBe(false);
      const otherUsersOldFeedback = await service.history(users[1].id, 1, false, true);
      expect(otherUsersOldFeedback.items).toHaveLength(20);
      expect(otherUsersOldFeedback.hasMore).toBe(true);
      expect(otherUsersOldFeedback.items.map((item) => item.id)).not.toContain(oldSentence.id);

      await service.update(users[0].id, oldSentence.id, { difficulty: 'HARD' });
      const afterReselect = await service.history(users[0].id, 1, false, true);
      expect(afterReselect.items).toHaveLength(20);
      expect(afterReselect.hasMore).toBe(false);
      const ratedAt = await prisma.dailySentence.findUniqueOrThrow({
        where: { id: oldSentence.id },
        select: { difficultyUpdatedAt: true, difficultyTimestampReliable: true },
      });
      expect(ratedAt.difficultyTimestampReliable).toBe(true);
      vi.setSystemTime(new Date(now.getTime() + 60 * 60 * 1000));
      await service.update(users[0].id, oldSentence.id, { favorite: true });
      expect(
        await prisma.dailySentence.findUniqueOrThrow({
          where: { id: oldSentence.id },
          select: { difficultyUpdatedAt: true, difficultyTimestampReliable: true },
        }),
      ).toEqual(ratedAt);

      await service.generate(users[0].id, '2026-10-27');
      const firstPrompt = ai.selectedChatCompletions.mock.calls[0][0].messages[1].content;
      expect(firstPrompt).toContain('"difficultyFeedback":"HARD"');
      expect(firstPrompt).not.toContain('ANCIENT_SENTENCE_OUTSIDE_RECENT_TEN');

      await service.generate(users[1].id, '2026-10-27');
      const secondPrompt = ai.selectedChatCompletions.mock.calls[1][0].messages[1].content;
      expect(secondPrompt).toContain('"difficultyFeedback":null');
      expect(secondPrompt).not.toContain('"difficultyFeedback":"HARD"');
      expect(secondPrompt).not.toContain('"difficultyFeedback":"EASY"');
      expect(ai.selectedChatCompletions).toHaveBeenCalledTimes(2);
    } finally {
      if (userIds.length) {
        await prisma.aiCallAudit.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      if (modelId) await prisma.aiModelConfig.deleteMany({ where: { id: modelId } });
      await prisma.$disconnect();
    }
  }, 30_000);
});
