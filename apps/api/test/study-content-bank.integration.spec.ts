import { NotFoundException } from '@nestjs/common';
import {
  PrismaClient,
  StudyPlanMode,
  StudyPlanPurpose,
  StudyContentFeedbackRating,
  StudyContentFeedbackReason,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StudyContentBankController } from '../src/modules/admin/study-content-bank.controller';
import { StudyContentBankService } from '../src/modules/admin/study-content-bank.service';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';
import { studyQuestionFingerprint } from '../src/modules/study/study-content-bank';
import { contentSignature, StudyService } from '../src/modules/study/study.service';
import { lexicalFields } from '../src/modules/vocabulary/lexical';
import targetWordWhitespaceFixture from './fixtures/study-content-bank-target-word.json';

const generatedQuestion = (bookWordId: string) => ({
  bookWordId,
  type: 'MEANING_RECOGNITION',
  prompt: 'What does the word mean in this sentence?',
  options: ['稳定的', '急促的', '沉重的', '柔软的'],
  correctAnswers: ['稳定的'],
  explanation: '结合句中稳定的光线理解这个词。',
});

const generatedGroup = (bookWordId: string, word: string) => ({
  index: 0,
  title: `A lesson about ${word}`,
  wordOccurrences: { [word]: 1 },
  sentences: [
    {
      english: `The ${word} light guided us home.`,
      chinese: '稳定的光线引导我们回家。',
      simplified: '稳定的光线引导我们回家。',
      grammar: '形容词修饰名词。',
    },
  ],
  questions: [generatedQuestion(bookWordId)],
});

const generatedResponse = (prompt: string) => {
  const line = prompt.match(/^输入分组：(.*)$/m)?.[1];
  if (!line) throw new Error('fixture did not receive group input');
  const groups = JSON.parse(line) as Array<{
    index: number;
    words: Array<{ id: string; word: string }>;
  }>;
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            groups: groups.map((group) => ({
              ...generatedGroup(group.words[0].id, group.words[0].word),
              index: group.index,
            })),
          }),
        },
      },
    ],
  };
};

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('public study material bank boundaries', () => {
  it('keeps personal vocabulary material in the learner plan without adding it to the public pool', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    let userId: string | undefined;
    let bookId: string | undefined;
    let signature: string | undefined;
    try {
      const user = await prisma.user.create({
        data: {
          email: `study-private-cache-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      userId = user.id;
      const book = await prisma.vocabularyBook.create({
        data: {
          kind: 'PERSONAL',
          ownerId: user.id,
          sourceKey: `study-private-cache-${fixtureId}`,
          title: 'Private vocabulary fixture',
          sourcePath: 'isolated-test',
          category: 'GENERAL',
          bookWords: {
            create: {
              position: 0,
              contextMeaning: '私人的',
              sourceExample: 'A private note.',
              word: {
                create: {
                  normalized: `study-private-cache-${fixtureId}`,
                  text: 'private',
                  meaning: 'adj. 私人的',
                },
              },
            },
          },
        },
        select: { id: true },
      });
      bookId = book.id;
      await prisma.userVocabularyBook.create({
        data: { userId: user.id, bookId: book.id, isDefault: true },
      });
      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => generatedResponse(prompt)),
      };
      const logEvents: unknown[] = [];
      const service = new StudyService(
        prisma as never,
        ai as never,
        { selectedProvider: async () => ({ id: 'isolated-fixture-model' }) } as never,
        {} as never,
        { record: async (event: unknown) => void logEvents.push(event) } as never,
      );
      const plan = await service.createPlan(user.id, 1, 'individual', 0, 'book');
      const generated = await service.generatePlan(user.id, plan.id);
      const item = await prisma.studyPlanItem.findFirstOrThrow({
        where: { planId: plan.id },
        include: { bookWord: { include: { word: true } } },
      });
      const meaning = item.bookWord.contextMeaning ?? item.bookWord.word.meaning ?? '';
      const lexical = lexicalFields(meaning);
      signature = contentSignature(
        StudyPlanMode.INDIVIDUAL,
        [
          {
            id: item.bookWordId,
            word: item.bookWord.word.text,
            part: lexical.part,
            meaning: lexical.meaning,
          },
        ],
        StudyPlanPurpose.NORMAL,
      );

      expect(generated.status).toBe('ACTIVE');
      expect(ai.generateForUser).toHaveBeenCalledTimes(1);
      expect(item.contentCacheId).toBeNull();
      expect(item.question).toMatchObject({ bookWordId: item.bookWordId });
      expect(await prisma.studyContentCache.count({ where: { signature } })).toBe(0);
      expect(await prisma.studyContentGenerationClaim.count({ where: { signature } })).toBe(0);
      expect(logEvents).toEqual([]);
      expect(
        await prisma.userWordProgress.count({
          where: { userId: user.id, bookWordId: item.bookWordId },
        }),
      ).toBe(1);
    } finally {
      if (signature) await prisma.studyContentCache.deleteMany({ where: { signature } });
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
      await prisma.$disconnect();
    }
  }, 60_000);

  it('filters exact target words across book entries, legacy snapshots, feedback, and pages', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const bookIds: string[] = [];
    const cacheIds: string[] = [];
    let voterId: string | undefined;

    try {
      const voter = await prisma.user.create({
        data: {
          email: `study-bank-word-filter-${fixtureId}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      voterId = voter.id;

      const entries: Array<{
        key: string;
        text: string;
        publicTarget?: string;
        emptyMap?: boolean;
        materialMention?: string;
        isActive: boolean;
      }> = [
        { key: 'active', text: 'pencil box', publicTarget: 'pencil box', isActive: true },
        { key: 'disabled', text: 'pencil box', publicTarget: 'Pencil   Box', isActive: false },
        { key: 'legacy', text: 'pencil box', publicTarget: undefined, isActive: true },
        { key: 'nbsp', text: 'pencil box', publicTarget: 'pencil\u00a0box', isActive: true },
        {
          key: 'ideographic-space',
          text: 'pencil box',
          publicTarget: 'pencil\u3000box',
          isActive: true,
        },
        { key: 'conflict', text: 'dim', publicTarget: 'bright', isActive: true },
        {
          key: 'empty-map',
          text: 'empty map relation',
          publicTarget: 'ignored map value',
          emptyMap: true,
          isActive: true,
        },
        {
          key: 'partial',
          text: 'pencil case',
          publicTarget: 'pencil case',
          materialMention: 'This lesson compares a pencil box with a pencil case.',
          isActive: true,
        },
      ];
      const caches: Array<{ id: string; isActive: boolean; bookWordId: string }> = [];

      for (const [index, entry] of entries.entries()) {
        const book = await prisma.vocabularyBook.create({
          data: {
            kind: 'SYSTEM',
            sourceKey: `study-bank-word-filter-${fixtureId}-${entry.key}`,
            title: `Exact target fixture ${entry.key}`,
            sourcePath: 'isolated-test',
            category: 'GENERAL',
            bookWords: {
              create: {
                position: 0,
                word: {
                  create: {
                    normalized: `study-bank-word-filter-${fixtureId}-${entry.key}`,
                    text: entry.text,
                    meaning: '学习用品',
                  },
                },
              },
            },
          },
          include: { bookWords: true },
        });
        bookIds.push(book.id);
        const bookWordId = book.bookWords[0].id;
        const question = generatedQuestion(bookWordId);
        const material = {
          ...(entry.publicTarget === undefined
            ? {
                index: 0,
                title: `Legacy exact target fixture ${fixtureId}`,
                sentences: [],
                questions: [question],
              }
            : {
                ...generatedGroup(bookWordId, entry.publicTarget),
                title: `Exact target fixture ${fixtureId} ${entry.key}`,
                ...(entry.materialMention
                  ? { sentences: [{ english: entry.materialMention, chinese: '隔离测试材料。' }] }
                  : {}),
              }),
          ...(entry.emptyMap ? { wordOccurrences: {} } : {}),
        };
        const cache = await prisma.studyContentCache.create({
          data: {
            signature: `study-bank-word-filter-${fixtureId}-${entry.key}`,
            mode: StudyPlanMode.INDIVIDUAL,
            material,
            isPublic: true,
            isActive: entry.isActive,
            createdAt: new Date(Date.UTC(2026, 10, 1, index)),
          },
          select: { id: true },
        });
        cacheIds.push(cache.id);
        caches.push({ id: cache.id, isActive: entry.isActive, bookWordId });
      }
      const nonObjectFallbackBook = await prisma.vocabularyBook.create({
        data: {
          kind: 'SYSTEM',
          sourceKey: `study-bank-word-filter-${fixtureId}-non-object-fallback`,
          title: 'Malformed map fallback fixture',
          sourcePath: 'isolated-test',
          category: 'GENERAL',
          bookWords: {
            create: {
              position: 0,
              word: {
                create: {
                  normalized: `study-bank-word-filter-${fixtureId}-non-object-fallback`,
                  text: 'non-object relation',
                  meaning: '异常映射回退测试',
                },
              },
            },
          },
        },
        include: { bookWords: true },
      });
      bookIds.push(nonObjectFallbackBook.id);
      const malformedCache = await prisma.studyContentCache.create({
        data: {
          signature: `study-bank-word-filter-${fixtureId}-malformed`,
          mode: StudyPlanMode.INDIVIDUAL,
          material: {
            title: `Malformed target fixture ${fixtureId}`,
            wordOccurrences: ['pencil box'],
            questions: [generatedQuestion(nonObjectFallbackBook.bookWords[0].id)],
          },
          isPublic: true,
        },
        select: { id: true },
      });
      cacheIds.push(malformedCache.id);

      const privateBook = await prisma.vocabularyBook.create({
        data: {
          kind: 'PERSONAL',
          ownerId: voter.id,
          sourceKey: `study-bank-word-filter-${fixtureId}-private`,
          title: 'Private vocabulary fixture',
          sourcePath: 'isolated-test',
          category: 'GENERAL',
          bookWords: {
            create: {
              position: 0,
              word: {
                create: {
                  normalized: `study-bank-word-filter-${fixtureId}-private-word`,
                  text: 'private pencil box',
                  meaning: '私人词条',
                },
              },
            },
          },
        },
        include: { bookWords: true },
      });
      bookIds.push(privateBook.id);
      const malformedPublicCache = await prisma.studyContentCache.create({
        data: {
          signature: `study-bank-word-filter-${fixtureId}-private-reference`,
          mode: StudyPlanMode.INDIVIDUAL,
          material: {
            title: `Malformed private-reference fixture ${fixtureId}`,
            questions: [generatedQuestion(privateBook.bookWords[0].id)],
          },
          isPublic: true,
        },
        select: { id: true },
      });
      cacheIds.push(malformedPublicCache.id);

      const addNegativeVote = async (cacheId: string, bookWordId: string) => {
        const question = generatedQuestion(bookWordId);
        await prisma.studyContentQuestionFeedback.create({
          data: {
            userId: voter.id,
            contentCacheId: cacheId,
            questionFingerprint: studyQuestionFingerprint(question),
            questionSnapshot: question,
            rating: StudyContentFeedbackRating.DOWN,
            reason: StudyContentFeedbackReason.QUESTION_UNCLEAR,
          },
        });
      };
      await addNegativeVote(caches[0].id, caches[0].bookWordId);
      await addNegativeVote(caches[1].id, caches[1].bookWordId);

      const bank = new StudyContentBankService(prisma as never);
      const firstPage = await bank.list({
        targetWord: targetWordWhitespaceFixture.rawInput,
        status: 'all',
        mode: StudyPlanMode.INDIVIDUAL,
        pageSize: 2,
        page: 1,
      });
      const secondPage = await bank.list({
        targetWord: 'pencil box',
        status: 'all',
        mode: StudyPlanMode.INDIVIDUAL,
        pageSize: 2,
        page: 2,
      });
      const thirdPage = await bank.list({
        targetWord: 'pencil box',
        status: 'all',
        mode: StudyPlanMode.INDIVIDUAL,
        pageSize: 2,
        page: 3,
      });
      expect(firstPage.total).toBe(5);
      expect(firstPage.items).toHaveLength(2);
      expect(secondPage.total).toBe(5);
      expect(secondPage.items).toHaveLength(2);
      expect(thirdPage.total).toBe(5);
      expect(thirdPage.items).toHaveLength(1);
      expect(
        new Set([...firstPage.items, ...secondPage.items, ...thirdPage.items].map(({ id }) => id)),
      ).toEqual(new Set(caches.slice(0, 5).map(({ id }) => id)));
      expect(
        await bank.list({
          targetWord: 'PENCIL\u00a0BOX',
          status: 'all',
          mode: StudyPlanMode.INDIVIDUAL,
        }),
      ).toMatchObject({ total: 5 });
      expect(
        await bank.list({
          targetWord: 'PENCIL\u3000BOX',
          status: 'all',
          mode: StudyPlanMode.INDIVIDUAL,
        }),
      ).toMatchObject({ total: 5 });
      expect(
        await bank.list({ targetWord: 'dim', status: 'all', mode: StudyPlanMode.INDIVIDUAL }),
      ).toMatchObject({ total: 0, items: [] });
      expect(
        await bank.list({ targetWord: 'bright', status: 'all', mode: StudyPlanMode.INDIVIDUAL }),
      ).toMatchObject({ total: 1, items: [{ id: caches[5].id }] });
      expect(
        await bank.list({
          targetWord: 'empty map relation',
          status: 'all',
          mode: StudyPlanMode.INDIVIDUAL,
        }),
      ).toMatchObject({ total: 0, items: [] });
      expect(
        await bank.list({
          targetWord: 'non-object relation',
          status: 'all',
          mode: StudyPlanMode.INDIVIDUAL,
        }),
      ).toMatchObject({ total: 1, items: [{ id: malformedCache.id }] });
      expect(
        await bank.list({ targetWord: 'pencil', status: 'all', mode: StudyPlanMode.INDIVIDUAL }),
      ).toMatchObject({ total: 0, items: [] });
      expect(
        await bank.list({ targetWord: 'box', status: 'all', mode: StudyPlanMode.INDIVIDUAL }),
      ).toMatchObject({ total: 0, items: [] });
      expect(
        await bank.list({
          targetWord: 'private pencil box',
          status: 'all',
          mode: StudyPlanMode.INDIVIDUAL,
        }),
      ).toMatchObject({ total: 0, items: [] });

      expect(
        await bank.list({
          targetWord: 'PENCIL BOX',
          search: fixtureId,
          status: 'active',
          mode: StudyPlanMode.INDIVIDUAL,
          feedback: 'negative',
        }),
      ).toMatchObject({ total: 1, items: [{ id: caches[0].id }] });
      expect(
        await bank.list({
          targetWord: 'pencil box',
          status: 'disabled',
          mode: StudyPlanMode.INDIVIDUAL,
          feedback: 'negative',
        }),
      ).toMatchObject({ total: 1, items: [{ id: caches[1].id }] });
    } finally {
      if (cacheIds.length)
        await prisma.studyContentCache.deleteMany({ where: { id: { in: cacheIds } } });
      if (voterId) await prisma.user.deleteMany({ where: { id: voterId } });
      if (bookIds.length)
        await prisma.vocabularyBook.deleteMany({ where: { id: { in: bookIds } } });
      await prisma.$disconnect();
    }
  }, 60_000);

  it('lets a learner change one vote on their completed snapshot and exposes only current-version aggregates to admins', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    const userIds: string[] = [];
    let bookId: string | undefined;
    let cacheId: string | undefined;
    const planIds: string[] = [];
    try {
      const users = await Promise.all(
        ['voter', 'other', 'admin'].map((suffix) =>
          prisma.user.create({
            data: {
              email: `study-bank-${fixtureId}-${suffix}@example.invalid`,
              passwordHash: 'isolated-test-fixture',
              ...(suffix === 'admin' ? { role: 'ADMIN' as const } : {}),
            },
            select: { id: true },
          }),
        ),
      );
      userIds.push(...users.map((user) => user.id));
      const book = await prisma.vocabularyBook.create({
        data: {
          kind: 'SYSTEM',
          sourceKey: `study-bank-${fixtureId}`,
          title: 'Public bank fixture',
          sourcePath: 'isolated-test',
          category: 'GENERAL',
          bookWords: {
            create: {
              position: 0,
              word: {
                create: {
                  normalized: `study-bank-${fixtureId}`,
                  text: 'steady',
                  meaning: '稳定的',
                },
              },
            },
          },
        },
        include: { bookWords: true },
      });
      bookId = book.id;
      const bookWordId = book.bookWords[0].id;
      const question = generatedQuestion(bookWordId);
      const material = generatedGroup(bookWordId, 'steady');
      const cache = await prisma.studyContentCache.create({
        data: {
          signature: `study-bank-${fixtureId}`,
          mode: StudyPlanMode.INDIVIDUAL,
          isPublic: true,
          material,
        },
        select: { id: true },
      });
      cacheId = cache.id;
      const completedAt = new Date();
      const plans = await Promise.all(
        users.slice(0, 2).map((user, index) =>
          prisma.studyPlan.create({
            data: {
              userId: user.id,
              mode: StudyPlanMode.INDIVIDUAL,
              purpose: StudyPlanPurpose.NORMAL,
              status: 'COMPLETED',
              generatedAt: completedAt,
              completedAt,
              generatedContent: { groups: [material] },
              items: {
                create: {
                  bookWordId,
                  contentCacheId: cache.id,
                  source: 'NEW',
                  groupIndex: 0,
                  question,
                  completedAt: index === 0 ? completedAt : null,
                },
              },
            },
            include: { items: true },
          }),
        ),
      );
      planIds.push(...plans.map((plan) => plan.id));
      await prisma.wordReviewAttempt.create({
        data: {
          userId: users[0].id,
          bookWordId,
          planItemId: plans[0].items[0].id,
          isCorrect: false,
          questionType: 'MEANING_RECOGNITION',
          selectedAnswer: ['急促的'],
        },
      });
      await prisma.userWordProgress.create({
        data: {
          userId: users[0].id,
          bookWordId,
          state: 'REVIEWING',
          familiarity: 31,
          reviewCount: 2,
          totalAttempts: 3,
          correctAttempts: 1,
          consecutiveCorrect: 0,
          lastIntervalDays: 1,
          postponedCount: 0,
          nextReviewAt: new Date('2026-11-05T12:00:00.000Z'),
        },
      });
      const study = new StudyService(prisma as never, {} as never, {} as never, {} as never);
      const beforeProgress = await prisma.userWordProgress.findUniqueOrThrow({
        where: { userId_bookWordId: { userId: users[0].id, bookWordId } },
      });
      const firstVote = await study.ratePublicQuestion(
        users[0].id,
        plans[0].id,
        bookWordId,
        StudyContentFeedbackRating.DOWN,
        StudyContentFeedbackReason.QUESTION_UNCLEAR,
      );
      expect(firstVote).toMatchObject({ rating: 'DOWN', reason: 'QUESTION_UNCLEAR' });
      const previousSnapshotQuestion = {
        ...question,
        prompt: 'Earlier wording for the same public question.',
      };
      await prisma.studyContentQuestionFeedback.create({
        data: {
          userId: users[1].id,
          contentCacheId: cache.id,
          questionFingerprint: studyQuestionFingerprint(previousSnapshotQuestion),
          questionSnapshot: previousSnapshotQuestion,
          rating: StudyContentFeedbackRating.DOWN,
          reason: StudyContentFeedbackReason.ANSWER_INCORRECT,
        },
      });
      const bank = new StudyContentBankService(prisma as never);
      const initiallyNegative = await bank.list({
        status: 'active',
        pageSize: 10,
        search: fixtureId,
        feedback: 'negative',
      });
      expect(initiallyNegative).toMatchObject({ total: 1, items: [{ id: cache.id }] });
      expect(initiallyNegative.items[0].feedbackSummary).toEqual({
        current: { up: 0, down: 1 },
        older: { up: 0, down: 1 },
      });
      expect(initiallyNegative.items[0].historicalNegativeQuestionCount).toBe(1);
      expect(initiallyNegative.items[0].historicalNegativeQuestions).toMatchObject([
        {
          question: { prompt: 'Earlier wording for the same public question.' },
          feedback: {
            up: 0,
            down: 1,
            reasonCounts: { ANSWER_INCORRECT: 1 },
          },
        },
      ]);
      await expect(
        study.ratePublicQuestion(
          users[1].id,
          plans[0].id,
          bookWordId,
          StudyContentFeedbackRating.UP,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        study.withdrawPublicQuestionFeedback(users[1].id, plans[0].id, bookWordId),
      ).rejects.toBeInstanceOf(NotFoundException);
      const otherPlanItem = plans[1].items[0];
      await prisma.studyPlanItem.update({
        where: { id: otherPlanItem.id },
        data: { completedAt },
      });
      await prisma.wordReviewAttempt.create({
        data: {
          userId: users[1].id,
          bookWordId,
          planItemId: otherPlanItem.id,
          isCorrect: true,
          questionType: 'MEANING_RECOGNITION',
          selectedAnswer: ['稳定的'],
        },
      });
      const otherPlan = await study.getPlan(users[1].id, plans[1].id);
      expect(otherPlan.words[0]).toMatchObject({
        publicBankMaterial: true,
        questionFeedback: null,
      });

      const changedVote = await study.ratePublicQuestion(
        users[0].id,
        plans[0].id,
        bookWordId,
        StudyContentFeedbackRating.UP,
      );
      expect(changedVote).toMatchObject({ rating: 'UP', reason: null });
      const ownerFeedback = await prisma.studyContentQuestionFeedback.findUniqueOrThrow({
        where: {
          userId_contentCacheId_questionFingerprint: {
            userId: users[0].id,
            contentCacheId: cache.id,
            questionFingerprint: studyQuestionFingerprint(question),
          },
        },
      });
      const [withdrawalOne, withdrawalRetry] = await Promise.all([
        study.withdrawPublicQuestionFeedback(users[0].id, plans[0].id, bookWordId),
        study.withdrawPublicQuestionFeedback(users[0].id, plans[0].id, bookWordId),
      ]);
      expect(withdrawalOne).toEqual({ withdrawn: true });
      expect(withdrawalRetry).toEqual({ withdrawn: true });
      const withdrawnFeedback = await prisma.studyContentQuestionFeedback.findUniqueOrThrow({
        where: { id: ownerFeedback.id },
      });
      expect(withdrawnFeedback).toMatchObject({
        id: ownerFeedback.id,
        rating: StudyContentFeedbackRating.UP,
        questionFingerprint: studyQuestionFingerprint(question),
        questionSnapshot: question,
      });
      expect(withdrawnFeedback.withdrawnAt).toBeInstanceOf(Date);
      expect((await study.getPlan(users[0].id, plans[0].id)).words[0].questionFeedback).toBeNull();
      const afterWithdrawal = await bank.list({
        status: 'active',
        search: fixtureId,
        feedback: 'negative',
      });
      expect(afterWithdrawal).toMatchObject({ total: 1, items: [{ id: cache.id }] });
      expect(afterWithdrawal.items[0].questions[0].feedback).toEqual({
        up: 0,
        down: 0,
        reasonCounts: {},
      });
      expect(afterWithdrawal.items[0].feedbackSummary).toEqual({
        current: { up: 0, down: 0 },
        older: { up: 0, down: 1 },
      });

      // A completed same-version question can be rated again after withdrawal;
      // the unique row is reactivated rather than duplicated.
      const restoredVote = await study.ratePublicQuestion(
        users[0].id,
        plans[0].id,
        bookWordId,
        StudyContentFeedbackRating.UP,
      );
      expect(restoredVote).toMatchObject({ rating: 'UP', reason: null });
      expect(
        await prisma.studyContentQuestionFeedback.count({
          where: { userId: users[0].id, contentCacheId: cache.id },
        }),
      ).toBe(1);
      expect(
        await prisma.studyContentQuestionFeedback.findUniqueOrThrow({
          where: { id: ownerFeedback.id },
        }),
      ).toMatchObject({ id: ownerFeedback.id, withdrawnAt: null, rating: 'UP' });
      await Promise.all([
        study.ratePublicQuestion(
          users[0].id,
          plans[0].id,
          bookWordId,
          StudyContentFeedbackRating.DOWN,
          StudyContentFeedbackReason.EXPLANATION_UNCLEAR,
        ),
        study.withdrawPublicQuestionFeedback(users[0].id, plans[0].id, bookWordId),
      ]);
      const afterRace = await prisma.studyContentQuestionFeedback.findUniqueOrThrow({
        where: { id: ownerFeedback.id },
      });
      expect(
        await prisma.studyContentQuestionFeedback.count({
          where: {
            userId: users[0].id,
            contentCacheId: cache.id,
            questionFingerprint: studyQuestionFingerprint(question),
          },
        }),
      ).toBe(1);
      const planAfterRace = await study.getPlan(users[0].id, plans[0].id);
      expect(Boolean(planAfterRace.words[0].questionFeedback)).toBe(afterRace.withdrawnAt === null);
      const bankAfterRace = await bank.list({ status: 'active', search: fixtureId });
      expect(bankAfterRace.items[0].questions[0].feedback).toEqual(
        afterRace.withdrawnAt === null
          ? { up: 0, down: 1, reasonCounts: { EXPLANATION_UNCLEAR: 1 } }
          : { up: 0, down: 0, reasonCounts: {} },
      );
      await study.ratePublicQuestion(
        users[0].id,
        plans[0].id,
        bookWordId,
        StudyContentFeedbackRating.UP,
      );
      expect(
        await prisma.studyContentQuestionFeedback.count({
          where: { userId: users[0].id, contentCacheId: cache.id },
        }),
      ).toBe(1);
      const afterProgress = await prisma.userWordProgress.findUniqueOrThrow({
        where: { userId_bookWordId: { userId: users[0].id, bookWordId } },
      });
      expect(afterProgress).toEqual(beforeProgress);
      expect(await prisma.wordReviewAttempt.count({ where: { userId: users[0].id } })).toBe(1);

      const listed = await bank.list({ status: 'active', pageSize: 10, search: fixtureId });
      expect(listed.items[0].questions[0].feedback).toEqual({ up: 1, down: 0, reasonCounts: {} });
      expect(listed.items[0].feedbackSummary).toEqual({
        current: { up: 1, down: 0 },
        older: { up: 0, down: 1 },
      });
      expect(listed.items[0].questions[0].feedback.reasonCounts).toEqual({});
      expect(listed.items[0].historicalNegativeQuestions).toMatchObject([
        {
          question: { prompt: 'Earlier wording for the same public question.' },
          feedback: { down: 1, reasonCounts: { ANSWER_INCORRECT: 1 } },
        },
      ]);
      expect(
        await bank.list({ status: 'active', search: fixtureId, feedback: 'negative' }),
      ).toMatchObject({ total: 1, items: [{ id: cache.id }] });
      await bank.setActive(cache.id, false, '题目反馈核查中', users[2].id);
      expect(await bank.list({ status: 'active', search: fixtureId })).toMatchObject({
        total: 0,
        items: [],
      });
      const disabled = await bank.list({ status: 'disabled', search: fixtureId });
      expect(disabled.items[0]).toMatchObject({
        isActive: false,
        disabledReason: '题目反馈核查中',
      });
      expect(disabled.items[0].questions[0].feedback.up).toBe(1);
      const oldPlanAfterDisable = await study.getPlan(users[0].id, plans[0].id);
      expect(oldPlanAfterDisable.words[0]).toMatchObject({
        publicBankMaterial: true,
        questionFeedback: { rating: 'UP', reason: null },
      });
      await bank.setActive(cache.id, true, undefined, users[2].id);
      expect(
        await prisma.studyContentCache.findUniqueOrThrow({ where: { id: cache.id } }),
      ).toMatchObject({
        isPublic: true,
        isActive: true,
        material,
      });
    } finally {
      if (cacheId) await prisma.studyContentCache.deleteMany({ where: { id: cacheId } });
      if (planIds.length) await prisma.studyPlan.deleteMany({ where: { id: { in: planIds } } });
      if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (bookId) await prisma.vocabularyBook.deleteMany({ where: { id: bookId } });
      await prisma.$disconnect();
    }
  }, 60_000);

  it('uses the admin guard metadata for all public-bank management routes', () => {
    expect(Reflect.getMetadata(ROLES_KEY, StudyContentBankController)).toEqual(['ADMIN']);
  });

  it('keeps the actual migration classification rule conservative for historical cache sources', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const fixtureId = randomUUID();
    try {
      const migration = await readFile(
        resolve(
          process.cwd(),
          'prisma/migrations/20261102190000_public_study_content_bank/migration.sql',
        ),
        'utf8',
      );
      const statements = migration
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      const classification = statements.find((statement) =>
        statement.startsWith('UPDATE "StudyContentCache" AS cache'),
      );
      const quarantine = statements.find((statement) =>
        statement.startsWith('UPDATE "StudyContentCache"\nSET "isActive" = false,'),
      );
      if (!classification || !quarantine)
        throw new Error('public cache migration classification SQL missing');
      // Preserve the migration predicates but limit these two data updates to
      // this test's random signatures. Applying the historical backfill to the
      // entire shared test database deadlocks with other parallel cache tests.
      const fixtureSignature = `%-${fixtureId}`;
      const scopedClassification = `${classification}\nWHERE cache."signature" LIKE '${fixtureSignature}'`;
      const scopedQuarantine = `${quarantine}\n  AND "signature" LIKE '${fixtureSignature}'`;
      const rollback = new Error('rollback migration fixture transaction');
      try {
        await prisma.$transaction(
          async (tx) => {
            const user = await tx.user.create({
              data: {
                email: `study-bank-migration-${fixtureId}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            });
            const systemBook = await tx.vocabularyBook.create({
              data: {
                kind: 'SYSTEM',
                sourceKey: `study-bank-migration-system-${fixtureId}`,
                title: 'System migration fixture',
                sourcePath: 'isolated-test',
                category: 'GENERAL',
                bookWords: {
                  create: {
                    position: 0,
                    word: {
                      create: {
                        normalized: `study-bank-mig-sys-${fixtureId}`,
                        text: 'public',
                        meaning: '公开的',
                      },
                    },
                  },
                },
              },
              include: { bookWords: true },
            });
            const personalBook = await tx.vocabularyBook.create({
              data: {
                kind: 'PERSONAL',
                ownerId: user.id,
                sourceKey: `study-bank-migration-personal-${fixtureId}`,
                title: 'Private migration fixture',
                sourcePath: 'isolated-test',
                category: 'GENERAL',
                bookWords: {
                  create: {
                    position: 0,
                    word: {
                      create: {
                        normalized: `study-bank-mig-prv-${fixtureId}`,
                        text: 'personal',
                        meaning: '个人的',
                      },
                    },
                  },
                },
              },
              include: { bookWords: true },
            });
            const planFixtures = await Promise.all(
              [systemBook.bookWords[0].id, personalBook.bookWords[0].id].map((bookWordId, index) =>
                tx.studyPlan.create({
                  data: {
                    userId: user.id,
                    mode: StudyPlanMode.INDIVIDUAL,
                    purpose: StudyPlanPurpose.NORMAL,
                    status: 'ACTIVE',
                    generatedContent: { groups: [{ title: `legacy snapshot ${index}` }] },
                    items: {
                      create: {
                        bookWordId,
                        source: 'NEW',
                        groupIndex: 0,
                        question: {
                          bookWordId,
                          type: 'MEANING_RECOGNITION',
                          prompt: `legacy question ${index}`,
                          correctAnswers: [`legacy answer ${index}`],
                        },
                        completedAt: new Date('2026-10-31T12:00:00.000Z'),
                      },
                    },
                  },
                  include: { items: true },
                }),
              ),
            );
            const caches = await Promise.all(
              ['legacy-system', 'legacy-personal', 'legacy-orphan'].map((name) =>
                tx.studyContentCache.create({
                  data: {
                    signature: `${name}-${fixtureId}`,
                    mode: StudyPlanMode.INDIVIDUAL,
                    material: { title: name },
                    isPublic: false,
                  },
                }),
              ),
            );
            await tx.studyPlanItem.update({
              where: { id: planFixtures[0].items[0].id },
              data: { contentCacheId: caches[0].id },
            });
            await tx.studyPlanItem.update({
              where: { id: planFixtures[1].items[0].id },
              data: { contentCacheId: caches[1].id },
            });
            await tx.wordReviewAttempt.createMany({
              data: planFixtures.map((plan, index) => ({
                userId: user.id,
                bookWordId: plan.items[0].bookWordId,
                planItemId: plan.items[0].id,
                isCorrect: index === 0,
                questionType: 'MEANING_RECOGNITION',
                selectedAnswer: [`legacy selected ${index}`],
              })),
            });
            await tx.$executeRawUnsafe(`${scopedClassification};`);
            await tx.$executeRawUnsafe(`${scopedQuarantine};`);

            const migrated = await tx.studyContentCache.findMany({
              where: { id: { in: caches.map((cache) => cache.id) } },
              select: {
                id: true,
                isPublic: true,
                isActive: true,
                disabledReason: true,
                material: true,
              },
            });
            const system = migrated.find((cache) => cache.id === caches[0].id);
            const personal = migrated.find((cache) => cache.id === caches[1].id);
            const orphan = migrated.find((cache) => cache.id === caches[2].id);
            expect(system).toMatchObject({
              isPublic: true,
              isActive: true,
              material: { title: 'legacy-system' },
            });
            expect(personal).toMatchObject({
              isPublic: false,
              isActive: false,
              disabledReason: '来源无法确认公共词书',
              material: { title: 'legacy-personal' },
            });
            expect(orphan).toMatchObject({
              isPublic: false,
              isActive: false,
              disabledReason: '来源无法确认公共词书',
              material: { title: 'legacy-orphan' },
            });
            expect(
              await tx.studyPlanItem.count({
                where: {
                  id: { in: planFixtures.flatMap((plan) => plan.items.map((item) => item.id)) },
                },
              }),
            ).toBe(2);
            expect(
              await tx.wordReviewAttempt.count({
                where: {
                  planItemId: {
                    in: planFixtures.flatMap((plan) => plan.items.map((item) => item.id)),
                  },
                },
              }),
            ).toBe(2);
            const preservedSnapshots = await tx.studyPlanItem.findMany({
              where: {
                id: { in: planFixtures.flatMap((plan) => plan.items.map((item) => item.id)) },
              },
              select: { contentCacheId: true, question: true, completedAt: true },
            });
            expect(preservedSnapshots).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  contentCacheId: caches[0].id,
                  question: expect.objectContaining({ prompt: 'legacy question 0' }),
                  completedAt: new Date('2026-10-31T12:00:00.000Z'),
                }),
                expect.objectContaining({
                  contentCacheId: caches[1].id,
                  question: expect.objectContaining({ prompt: 'legacy question 1' }),
                  completedAt: new Date('2026-10-31T12:00:00.000Z'),
                }),
              ]),
            );
            expect(
              await tx.studyPlan.findMany({
                where: { id: { in: planFixtures.map((plan) => plan.id) } },
                select: { generatedContent: true },
              }),
            ).toEqual(
              expect.arrayContaining([
                { generatedContent: { groups: [{ title: 'legacy snapshot 0' }] } },
                { generatedContent: { groups: [{ title: 'legacy snapshot 1' }] } },
              ]),
            );
            throw rollback;
          },
          { timeout: 60_000 },
        );
      } catch (error) {
        if (error !== rollback) throw error;
      }
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);
});
