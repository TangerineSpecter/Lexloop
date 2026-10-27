import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { StudyService } from '../src/modules/study/study.service';
import { publicStudyContent, publicStudyQuestion } from '../src/modules/study/study-content';

const matchingQuestion = {
  bookWordId: 'word1',
  type: 'WORD_MATCHING',
  prompt: 'Match each phrase with its meaning.',
  options: [],
  correctAnswers: [],
  explanation: '解析保留到交卷后。',
  pairs: [
    { left: 'help people', right: '服务大众', tip: '强调服务对象。' },
    { left: 'help oneself', right: '自助', tip: '强调行动由谁完成。' },
    { left: 'help to improve', right: '促进改善', tip: '强调结果变好。' },
    { left: "can't help doing", right: '情不自禁', tip: '强调难以克制。' },
  ],
};

describe('study answer visibility', () => {
  it('withholds answer keys, explanations, option notes, and matching relationships before submission', () => {
    const singleChoice = publicStudyQuestion(
      {
        type: 'MEANING_RECOGNITION',
        prompt: 'Choose the meaning.',
        options: ['A', 'B'],
        correctAnswers: ['B'],
        explanation: '答案解析。',
        optionNotes: ['提示 A', '提示 B'],
      },
      false,
    ) as Record<string, unknown>;
    expect(singleChoice).toMatchObject({ prompt: 'Choose the meaning.', options: ['A', 'B'] });
    expect(singleChoice).not.toHaveProperty('correctAnswers');
    expect(singleChoice).not.toHaveProperty('explanation');
    expect(singleChoice).not.toHaveProperty('optionNotes');

    const publicMatching = publicStudyQuestion(matchingQuestion, false) as typeof matchingQuestion;
    expect(publicMatching.pairs.map(({ left }) => left)).toEqual(
      matchingQuestion.pairs.map(({ left }) => left),
    );
    expect(publicMatching.pairs.map(({ right }) => right).sort()).toEqual(
      matchingQuestion.pairs.map(({ right }) => right).sort(),
    );
    expect(
      publicMatching.pairs.every(
        (pair, index) => pair.right !== matchingQuestion.pairs[index].right,
      ),
    ).toBe(true);
    expect(publicMatching.pairs.map(({ tip }) => tip)).toEqual([
      '强调行动由谁完成。',
      '强调结果变好。',
      '强调难以克制。',
      '强调服务对象。',
    ]);
    expect(publicMatching).not.toHaveProperty('explanation');
    expect(publicMatching).not.toHaveProperty('correctAnswers');
    expect(matchingQuestion.pairs[0]).toEqual({
      left: 'help people',
      right: '服务大众',
      tip: '强调服务对象。',
    });
  });

  it('reveals answers only for submitted groups in both content and per-word copies', () => {
    const content = {
      groups: [
        { index: 0, questions: [matchingQuestion] },
        { index: 1, questions: [{ ...matchingQuestion, bookWordId: 'word2' }] },
      ],
    };
    const visible = publicStudyContent(content, new Set([1])) as typeof content;
    expect(visible.groups[0].questions[0]).not.toHaveProperty('correctAnswers');
    expect(visible.groups[0].questions[0].pairs?.[0].right).toBe('自助');
    expect(visible.groups[1].questions[0]).toEqual(content.groups[1].questions[0]);
    expect(publicStudyQuestion(matchingQuestion, true)).toEqual(matchingQuestion);
  });

  it('serializes stored plans through the answer boundary and keeps reads scoped to the account', async () => {
    const row = {
      id: 'plan1',
      userId: 'owner',
      mode: 'GROUP',
      purpose: 'NORMAL',
      status: 'ACTIVE',
      generationError: null,
      generatedAt: new Date('2026-10-27T00:00:00.000Z'),
      createdAt: new Date('2026-10-27T00:00:00.000Z'),
      completedAt: null,
      generatedContent: { groups: [{ index: 0, questions: [matchingQuestion] }] },
      items: [
        {
          id: 'item1',
          bookWordId: 'word1',
          bookWord: { contextMeaning: null, word: { text: 'help', meaning: 'vt. 帮助' } },
          source: 'NEW',
          groupIndex: 0,
          question: matchingQuestion,
          targetQuestionType: null,
          completedAt: null,
          attempts: [],
        },
      ],
    };
    const prisma = {
      studyPlan: {
        findMany: vi.fn().mockResolvedValue([{ id: 'plan1' }]),
        findFirst: vi.fn().mockResolvedValue(row),
      },
    };
    const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);

    const [plan] = await service.listPlans('owner');
    const returned = plan as unknown as {
      content: { groups: Array<{ questions: unknown[] }> };
      words: Array<{ question: unknown }>;
    };
    expect(prisma.studyPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan1', userId: 'owner' } }),
    );
    expect(returned.content.groups[0].questions[0]).not.toHaveProperty('correctAnswers');
    expect(returned.words[0].question).not.toHaveProperty('correctAnswers');
    expect(
      (returned.content.groups[0].questions[0] as typeof matchingQuestion).pairs[0].right,
    ).toBe('自助');
  });

  it('does not advance or return feedback for an incomplete submission', async () => {
    const prisma = {
      studyPlanItem: { findMany: vi.fn().mockResolvedValue([{ id: 'item1', completedAt: null }]) },
      studyPlan: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    };
    const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.completeGroup('owner', 'plan1', 0, [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.studyPlan.findFirst).not.toHaveBeenCalled();
  });

  it('keeps duplicate completion idempotent and reveals feedback only for the completed group', async () => {
    const completedAt = new Date('2026-10-27T00:00:00.000Z');
    const completedRow = {
      id: 'plan1',
      userId: 'owner',
      mode: 'GROUP',
      purpose: 'NORMAL',
      status: 'COMPLETED',
      generationError: null,
      generatedAt: completedAt,
      createdAt: completedAt,
      completedAt,
      generatedContent: { groups: [{ index: 0, questions: [matchingQuestion] }] },
      items: [
        {
          id: 'item1',
          bookWordId: 'word1',
          bookWord: {
            contextMeaning: null,
            word: { text: 'help', meaning: 'vt. 帮助' },
            progress: [{ nextReviewAt: new Date('2026-10-28T00:00:00.000Z') }],
            weaknesses: [],
          },
          source: 'NEW',
          groupIndex: 0,
          question: matchingQuestion,
          targetQuestionType: null,
          completedAt,
          attempts: [{ isCorrect: false, questionType: 'WORD_MATCHING', responseTimeMs: 4 }],
        },
      ],
    };
    const prisma = {
      studyPlanItem: { findMany: vi.fn().mockResolvedValue([{ id: 'item1', completedAt }]) },
      studyPlan: { findFirst: vi.fn().mockResolvedValue(completedRow) },
      $transaction: vi.fn(),
    };
    const service = new StudyService(prisma as never, {} as never, {} as never, {} as never);

    const result = await service.completeGroup('owner', 'plan1', 0, []);
    const returned = result as unknown as { content: { groups: Array<{ questions: unknown[] }> } };
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(returned.content.groups[0].questions[0]).toEqual(matchingQuestion);
  });
});
