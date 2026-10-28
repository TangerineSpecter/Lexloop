import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { StudyService } from '../src/modules/study/study.service';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'saved vocabulary context in study feedback',
  () => {
    it('reveals the saved source sentence after an answer and scopes it to the plan owner', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const normalized = `personal:${fixtureId}:miss the bus`;
      const sourceKey = `study-saved-context-${fixtureId}`;
      const userIds: string[] = [];
      let planId: string | undefined;
      try {
        const owner = await prisma.user.create({
          data: {
            email: `study-saved-context-${fixtureId}-owner@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        const other = await prisma.user.create({
          data: {
            email: `study-saved-context-${fixtureId}-other@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userIds.push(owner.id, other.id);
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: owner.id,
            kind: 'PERSONAL',
            sourceKey,
            title: 'Saved context fixture',
            sourcePath: 'test',
            category: 'GENERAL',
          },
        });
        const word = await prisma.vocabularyWord.create({
          data: {
            normalized,
            text: 'miss the bus',
            meaning: '没赶上公交车',
            itemType: 'PHRASE',
          },
        });
        const bookWord = await prisma.vocabularyBookWord.create({
          data: {
            bookId: book.id,
            wordId: word.id,
            position: 1,
            contextMeaning: '没赶上公交车；不是“想念公交车”',
            sourceScenario: '微故事 · 上班路上 · 第 1 段',
            sourceExample: 'Maya missed the bus, so she called a taxi.',
            sourceType: 'READING',
          },
        });
        await prisma.userWordProgress.create({
          data: {
            userId: owner.id,
            bookWordId: bookWord.id,
            state: 'REVIEWING',
            nextReviewAt: new Date(Date.now() - 60_000),
          },
        });
        const question = {
          bookWordId: bookWord.id,
          type: 'MEANING_RECOGNITION',
          prompt: 'Choose the meaning of “miss the bus”.',
          options: ['没赶上公交车', '想念公交车'],
          correctAnswers: ['没赶上公交车'],
          explanation: 'miss the bus 表示没有赶上公交车。',
        };
        const plan = await prisma.studyPlan.create({
          data: {
            userId: owner.id,
            mode: 'GROUP',
            purpose: 'NORMAL',
            status: 'ACTIVE',
            generatedContent: {
              groups: [
                {
                  index: 0,
                  title: 'A rushed morning',
                  wordOccurrences: { 'miss the bus': 1 },
                  sentences: [],
                  questions: [question],
                },
              ],
            },
            items: {
              create: {
                bookWordId: bookWord.id,
                source: 'REVIEW',
                groupIndex: 0,
                question,
              },
            },
          },
          select: { id: true },
        });
        planId = plan.id;
        const mistakes = new MistakesService(prisma as never);
        const service = new StudyService(prisma as never, {} as never, {} as never, mistakes);

        const beforeAnswer = (await service.listPlans(owner.id)).find(
          (entry) => entry.id === plan.id,
        )!;
        expect(beforeAnswer.words[0].completed).toBe(false);
        expect(beforeAnswer.words[0]).not.toHaveProperty('savedContext');
        expect(beforeAnswer.words[0].question).not.toHaveProperty('correctAnswers');
        const beforeAnswerContent = beforeAnswer.content as {
          groups: Array<{ questions: Array<Record<string, unknown>> }>;
        };
        expect(beforeAnswerContent.groups[0].questions[0]).not.toHaveProperty('correctAnswers');

        const submitted = await service.completeGroup(owner.id, plan.id, 0, [
          { bookWordId: bookWord.id, selectedAnswer: ['没赶上公交车'], responseTimeMs: 1_200 },
        ]);
        expect(submitted.words[0]).toMatchObject({
          completed: true,
          result: true,
          savedContext: {
            scenario: '微故事 · 上班路上 · 第 1 段',
            example: 'Maya missed the bus, so she called a taxi.',
          },
        });

        const historyReview = await service.getCompletedPlanReview(owner.id, plan.id);
        expect(historyReview.words[0].savedContext).toEqual(submitted.words[0].savedContext);
        await expect(service.getCompletedPlanReview(other.id, plan.id)).rejects.toThrow(
          '已完成学习记录不存在',
        );
        const attemptsBeforeReads = await prisma.wordReviewAttempt.count({
          where: { userId: owner.id },
        });
        await service.getCompletedPlanReview(owner.id, plan.id);
        await service.getCompletedPlanReview(owner.id, plan.id);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: owner.id } })).toBe(
          attemptsBeforeReads,
        );
      } finally {
        if (planId) await prisma.studyPlan.delete({ where: { id: planId } }).catch(() => undefined);
        await prisma.vocabularyBook.deleteMany({ where: { sourceKey } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized } });
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    });
  },
);
