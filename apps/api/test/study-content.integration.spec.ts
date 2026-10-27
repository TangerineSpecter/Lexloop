import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'study answer visibility in an isolated database',
  () => {
    it('unlocks answers only after every item in that user group is complete and preserves completed history', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const createdAt = new Date();
      const completedAt = new Date(Date.now() + 1_000);
      const users: Array<{ id: string }> = [];
      const words: Array<{ id: string }> = [];
      let bookId: string | undefined;
      try {
        for (const suffix of ['one', 'two']) {
          users.push(
            await prisma.user.create({
              data: {
                email: `study-answer-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          );
        }
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: users[0].id,
            kind: 'PERSONAL',
            sourceKey: fixtureId,
            title: 'Study answer visibility test',
            sourcePath: 'test',
            category: 'GENERAL',
          },
        });
        bookId = book.id;
        for (const [position, text] of ['bright', 'help'].entries()) {
          words.push(
            await prisma.vocabularyWord.create({
              data: {
                normalized: `study-answer-${fixtureId}-${text}`,
                text,
                meaning: position ? '帮助' : '明亮的',
              },
              select: { id: true },
            }),
          );
        }
        const bookWords = await Promise.all(
          words.map((word, position) =>
            prisma.vocabularyBookWord.create({
              data: { bookId: book.id, wordId: word.id, position },
              select: { id: true },
            }),
          ),
        );
        const questions = [
          {
            bookWordId: bookWords[0].id,
            type: 'MEANING_RECOGNITION',
            prompt: 'Choose the meaning of bright.',
            options: ['暗的', '明亮的'],
            correctAnswers: ['明亮的'],
            explanation: 'bright 描述光线充足或颜色鲜明。',
          },
          {
            bookWordId: bookWords[1].id,
            type: 'MEANING_RECOGNITION',
            prompt: 'Choose the meaning of help.',
            options: ['帮助', '拒绝'],
            correctAnswers: ['帮助'],
            explanation: 'help 表示提供帮助。',
          },
        ];
        const generatedContent = {
          groups: [
            {
              index: 0,
              title: 'A bright helping hand',
              wordOccurrences: { bright: 1, help: 1 },
              sentences: [],
              questions,
            },
          ],
        };
        const createPlan = async (
          userId: string,
          status: 'ACTIVE' | 'COMPLETED',
          completedIndices: number[],
        ) =>
          prisma.studyPlan.create({
            data: {
              userId,
              mode: 'GROUP',
              purpose: 'NORMAL',
              status,
              generatedContent,
              generatedAt: createdAt,
              completedAt: status === 'COMPLETED' ? completedAt : null,
              items: {
                create: questions.map((question, index) => ({
                  bookWordId: bookWords[index].id,
                  source: 'NEW',
                  groupIndex: 0,
                  question,
                  completedAt: completedIndices.includes(index) ? completedAt : null,
                })),
              },
            },
            select: { id: true },
          });
        const [ownerPlan, partialPlan, legacyCompletedPlan] = await Promise.all([
          createPlan(users[0].id, 'ACTIVE', []),
          createPlan(users[1].id, 'ACTIVE', [0]),
          createPlan(users[0].id, 'COMPLETED', [0, 1]),
        ]);
        const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);
        type SerializedQuestion = { correctAnswers?: string[]; explanation?: string };
        type SerializedPlan = {
          id: string;
          content: { groups: Array<{ questions: SerializedQuestion[] }> };
          words: Array<{ question: SerializedQuestion }>;
        };

        const ownerPlans = (await service.listPlans(users[0].id)) as unknown as SerializedPlan[];
        const partialPlans = (await service.listPlans(users[1].id)) as unknown as SerializedPlan[];
        expect(ownerPlans.map((plan) => plan.id)).toContain(ownerPlan.id);
        expect(ownerPlans.map((plan) => plan.id)).not.toContain(partialPlan.id);
        expect(partialPlans.map((plan) => plan.id)).toEqual([partialPlan.id]);
        expect(partialPlans[0].content!.groups[0].questions[0]).not.toHaveProperty(
          'correctAnswers',
        );
        expect(partialPlans[0].words[0].question).not.toHaveProperty('correctAnswers');
        expect(partialPlans[0].content!.groups[0].questions[1]).not.toHaveProperty('explanation');

        await prisma.studyPlanItem.updateMany({
          where: { planId: partialPlan.id, groupIndex: 0 },
          data: { completedAt },
        });
        const completedPartial = (await service.listPlans(
          users[1].id,
        )) as unknown as SerializedPlan[];
        expect(completedPartial[0].content!.groups[0].questions[0].correctAnswers).toEqual([
          '明亮的',
        ]);
        expect(completedPartial[0].words[1].question.correctAnswers).toEqual(['帮助']);

        const history = await service.listCompletedPlans(users[0].id);
        const historyItems = history.items as unknown as SerializedPlan[];
        expect(historyItems.map((plan) => plan.id)).toContain(legacyCompletedPlan.id);
        const oldPlan = historyItems.find((plan) => plan.id === legacyCompletedPlan.id)!;
        expect(oldPlan.content!.groups[0].questions[0].correctAnswers).toEqual(['明亮的']);
        await expect(service.completeGroup(users[1].id, ownerPlan.id, 0, [])).rejects.toThrow(
          '学习分组不存在或计划尚未生成完毕',
        );
      } finally {
        if (users.length) {
          await prisma.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
        }
        if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
        if (words.length) {
          await prisma.vocabularyWord.deleteMany({
            where: { id: { in: words.map(({ id }) => id) }, bookWords: { none: {} } },
          });
        }
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
