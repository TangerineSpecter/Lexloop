import { StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  examQuestionType,
  generationPrompt,
  StudyService,
} from '../src/modules/study/study.service';

describe('exam study plans', () => {
  it('assigns an exam mix of rare-sense, collocation, synonym, and reading questions', () => {
    const types = Array.from({ length: 10 }, (_, index) => examQuestionType(index));
    expect(types.filter((type) => type === 'MEANING_RECOGNITION')).toHaveLength(4);
    expect(types.filter((type) => type === 'WORD_MATCHING')).toHaveLength(3);
    expect(types.filter((type) => type === 'SYNONYM_REPLACEMENT')).toHaveLength(2);
    expect(types.filter((type) => type === 'READING_COMPREHENSION')).toHaveLength(1);
    expect(types).not.toContain('WORD_MNEMONIC');
  });

  it('asks for original exam-style context instead of past-paper text', () => {
    const exam = generationPrompt(StudyPlanMode.EXAM, [], StudyPlanPurpose.NORMAL);
    expect(exam).toContain('应试语境');
    expect(exam).toContain('熟词僻义');
    expect(exam).toContain('固定搭配');
    expect(exam).toContain('禁止复述');
    expect(exam).toContain('题型以 targetQuestionTypes 为准');

    const group = generationPrompt(StudyPlanMode.GROUP, [], StudyPlanPurpose.NORMAL);
    expect(group).toContain('随机分组');
    expect(group).toContain('五种题型轮换使用');
    expect(group).not.toContain('应试语境补充规则');
  });

  it('uses known target-word levels without assigning a level to the learner', () => {
    const prompt = generationPrompt(StudyPlanMode.GROUP, [
      {
        index: 0,
        words: [
          { id: 'word-a', word: 'gentle', part: 'adj.', meaning: '温和的', cefrLevel: 'A2' },
          { id: 'word-b', word: 'steady', part: 'adj.', meaning: '稳定的', cefrLevel: null },
        ],
      },
    ]);

    expect(prompt).toContain('"cefrLevel":"A2"');
    expect(prompt).toContain('"cefrLevel":null');
    expect(prompt).toContain('周围词汇和句法');
    expect(prompt).toContain('级别未知，不要猜测或补造级别');
    expect(prompt).toContain('不要据此宣称或推断学习者的 CEFR 水平');
    expect(prompt).toContain('不要让最高级目标词抬高整篇材料的难度');
  });

  it('creates an exam plan with target question types instead of rejecting the mode', async () => {
    const tx = {
      $queryRaw: vi.fn(),
      studyPlan: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'plan-exam' }),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ defaultNewWordCount: 1 }) },
      userWordProgress: { findMany: vi.fn().mockResolvedValue([]) },
      userVocabularyBook: { findFirst: vi.fn().mockResolvedValue({ bookId: 'book-1' }) },
      vocabularyBookWord: { findMany: vi.fn().mockResolvedValue([{ id: 'bw-1' }, { id: 'bw-2' }]) },
      studyPlanItem: { createMany: vi.fn() },
    };
    const serialized = {
      id: 'plan-exam',
      mode: 'exam',
      words: [
        {
          id: 'bw-1',
          word: 'order',
          part: 'n.',
          meaning: 'n. 订单\nv. 命令',
          meanings: [
            { part: 'n.', text: '订单' },
            { part: 'v.', text: '命令' },
          ],
          ukPhonetic: 'ˈɔːdə',
          usPhonetic: 'ˈɔːrdər',
          cefrLevel: 'B1',
        },
      ],
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<string>) => callback(tx)),
      studyPlan: { findFirst: vi.fn() },
    };
    const service = new StudyService(
      prisma as never,
      {} as never,
      { selectedProvider: vi.fn().mockResolvedValue({ id: 'model' }) } as never,
      {} as never,
    );
    vi.spyOn(service as never, 'serializePlan' as never).mockResolvedValue(serialized as never);

    const plan = await service.createPlan('user-1', 2, 'exam', 0);
    expect(plan).toBe(serialized);
    const createdItems = tx.studyPlanItem.createMany.mock.calls[0][0].data as Array<{
      targetQuestionType: string;
      bookWordId: string;
    }>;
    expect(tx.studyPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mode: 'EXAM' }) }),
    );
    expect(createdItems.map((item) => item.targetQuestionType)).toEqual([
      'MEANING_RECOGNITION',
      'MEANING_RECOGNITION',
    ]);
    await expect(service.createPlan('user-1', 2, 'group', 0, 'book')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('selects mistake words for an individual plan instead of the daily queue', async () => {
    const tx = {
      $queryRaw: vi.fn(),
      studyPlan: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'plan-individual' }),
      },
      user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ defaultNewWordCount: 10 }) },
      weaknessSignal: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { bookWordId: 'mistake-1' },
            { bookWordId: 'mistake-1' },
            { bookWordId: 'mistake-2' },
          ]),
      },
      studyPlanItem: { createMany: vi.fn() },
      userWordProgress: { findMany: vi.fn() },
      userVocabularyBook: { findFirst: vi.fn() },
      vocabularyBookWord: { findMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<string>) => callback(tx)),
    };
    const service = new StudyService(
      prisma as never,
      {} as never,
      { selectedProvider: vi.fn().mockResolvedValue({ id: 'model' }) } as never,
      {} as never,
    );
    vi.spyOn(service as never, 'serializePlan' as never).mockResolvedValue({
      id: 'plan-individual',
    } as never);

    await service.createPlan('user-1', 10, 'individual', 0, 'mistakes');
    expect(tx.userWordProgress.findMany).not.toHaveBeenCalled();
    expect(tx.vocabularyBookWord.findMany).not.toHaveBeenCalled();
    const createdItems = tx.studyPlanItem.createMany.mock.calls[0][0].data as Array<{
      bookWordId: string;
      groupIndex: number;
      source: string;
      targetQuestionType?: string;
    }>;
    expect(createdItems.map((item) => item.bookWordId)).toEqual(['mistake-1', 'mistake-2']);
    expect(createdItems.every((item) => item.groupIndex === createdItems.indexOf(item))).toBe(true);
    expect(createdItems.every((item) => item.source === 'REVIEW')).toBe(true);
    expect(createdItems.every((item) => item.targetQuestionType === undefined)).toBe(true);
  });
});
