import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient, StudyPlanStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { StudyController } from '../src/modules/study/study.controller';
import { StudyService } from '../src/modules/study/study.service';

function fixtureResponse(
  groups: Array<{ index: number; words: Array<{ id: string; word: string; meaning: string }> }>,
) {
  const englishFor = (word: string) => {
    if (word === 'available') return ['The chair is available now.', 'Please take a seat.'];
    if (word === 'quiet') return ['The library is quiet now.', 'Please read here.'];
    return [`They ${word} the radio today.`, 'Call the shop tomorrow.'];
  };
  const translationFor = (word: string) => {
    if (word === 'available') return ['这把椅子现在可以使用。', '请坐。'];
    if (word === 'quiet') return ['图书馆现在很安静。', '请在这里阅读。'];
    return ['他们今天修理收音机。', '请明天给商店打电话。'];
  };
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            groups: groups.map((group) => {
              const word = group.words[0];
              const sentences = englishFor(word.word);
              const translations = translationFor(word.word);
              return {
                index: group.index,
                title: `Practice ${word.word}`,
                wordOccurrences: { [word.word]: 1 },
                sentences: sentences.map((english, index) => ({
                  english,
                  chinese: translations[index],
                  simplified: translations[index],
                  grammar: '该句用简单语序表达一个清楚的事实。',
                })),
                questions: [
                  {
                    bookWordId: word.id,
                    type: 'MEANING_RECOGNITION',
                    prompt: `What does ${word.word} mean in the sentence?`,
                    options: [word.meaning, '损坏的', '遥远的', '昂贵的'],
                    correctAnswers: [word.meaning],
                    explanation: '句子中的上下文支持这个词义。',
                  },
                ],
              };
            }),
          }),
        },
      },
    ],
  };
}

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'progressive practice lifecycle in an isolated database',
  () => {
    it('locks stages per account, resumes idempotently, and advances without changing SRS semantics', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const users: string[] = [];
      const bookIds: string[] = [];
      const wordIds: string[] = [];
      let app: NestFastifyApplication | undefined;
      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
          const line = prompt.match(/^输入分组：(.*)$/m)?.[1];
          if (!line) throw new Error('generation fixture did not receive input groups');
          return fixtureResponse(JSON.parse(line));
        }),
      };
      const service = new StudyService(
        prisma as never,
        ai as never,
        { selectedProvider: vi.fn(async () => ({ id: 'isolated-fixture-model' })) } as never,
        new MistakesService(prisma as never),
      );
      try {
        const learners = await Promise.all(
          ['owner', 'other', 'empty'].map((suffix) =>
            prisma.user.create({
              data: {
                email: `progressive-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true },
            }),
          ),
        );
        users.push(...learners.map(({ id }) => id));
        const [owner, other, empty] = learners;
        const book = await prisma.vocabularyBook.create({
          data: {
            ownerId: owner.id,
            kind: 'PERSONAL',
            sourceKey: `progressive-${fixtureId}`,
            title: 'Progressive practice test book',
            sourcePath: 'test',
            category: 'GENERAL',
            bookWords: {
              create: [
                { text: 'available', meaning: '可用的' },
                { text: 'quiet', meaning: '安静的' },
                { text: 'repair', meaning: '修理' },
              ].map((word, position) => ({
                position,
                word: {
                  create: {
                    normalized: `progressive-${fixtureId}-${word.text}`,
                    text: word.text,
                    meaning: word.meaning,
                  },
                },
              })),
            },
          },
          select: {
            id: true,
            bookWords: { include: { word: true }, orderBy: { position: 'asc' } },
          },
        });
        bookIds.push(book.id);
        wordIds.push(...book.bookWords.map(({ wordId }) => wordId));
        await prisma.userVocabularyBook.create({
          data: { userId: owner.id, bookId: book.id, isDefault: true },
        });

        const jwtSecret = `progressive-practice-${fixtureId}-secret`;
        const moduleRef = await Test.createTestingModule({
          imports: [JwtModule.register({})],
          controllers: [StudyController],
          providers: [
            JwtAuthGuard,
            { provide: ConfigService, useValue: { getOrThrow: () => jwtSecret } },
            { provide: StudyService, useValue: service },
          ],
        }).compile();
        app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
        app.setGlobalPrefix('api/v1');
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.init();
        const fastify = app.getHttpAdapter().getInstance();
        await fastify.ready();
        const jwt = new JwtService({ secret: jwtSecret });
        const ownerToken = await jwt.signAsync({ sub: owner.id }, { expiresIn: '5m' });
        const otherToken = await jwt.signAsync({ sub: other.id }, { expiresIn: '5m' });
        const route = '/api/v1/study/progressive-path';
        expect((await fastify.inject({ method: 'GET', url: route })).statusCode).toBe(401);
        const ownerPath = await fastify.inject({
          method: 'GET',
          url: route,
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        const otherPath = await fastify.inject({
          method: 'GET',
          url: route,
          headers: { authorization: `Bearer ${otherToken}` },
        });
        expect(ownerPath.statusCode).toBe(200);
        expect(ownerPath.json()).toMatchObject({
          highestUnlockedStage: 'foundation',
          currentPlan: null,
        });
        expect(otherPath.statusCode).toBe(200);
        expect(otherPath.json()).toMatchObject({
          highestUnlockedStage: 'foundation',
          currentPlan: null,
        });

        expect(await service.getProgressivePath(owner.id)).toMatchObject({
          highestUnlockedStage: 'foundation',
          currentPlan: null,
        });
        const lockedStage = await fastify.inject({
          method: 'POST',
          url: `${route}/plans`,
          headers: { authorization: `Bearer ${ownerToken}` },
          payload: { stage: 'transfer' },
        });
        expect(lockedStage.statusCode).toBe(400);
        expect(lockedStage.body).toContain('该练习阶段尚未解锁');
        expect(await prisma.studyPlan.count({ where: { userId: owner.id } })).toBe(0);
        await expect(service.createProgressivePlan(empty.id)).rejects.toThrow('没有带可用释义');
        expect(await prisma.studyPlan.count({ where: { userId: empty.id } })).toBe(0);

        const [created, retry] = await Promise.all([
          service.createProgressivePlan(owner.id),
          service.createProgressivePlan(owner.id),
        ]);
        expect(retry.id).toBe(created.id);
        expect(created).toMatchObject({
          purpose: 'progressive',
          progressiveStage: 'foundation',
          progressiveVersion: 1,
          status: 'GENERATING',
        });
        expect(created.wordCount).toBe(2);
        await expect(service.createProgressivePlan(owner.id, 'context')).rejects.toThrow(
          '当前已有未完成的其他阶段练习',
        );
        expect(await prisma.studyPlan.count({ where: { userId: owner.id } })).toBe(1);
        expect(
          created.words.every(
            (word: { targetQuestionType?: string | null }) =>
              word.targetQuestionType === 'MEANING_RECOGNITION',
          ),
        ).toBe(true);
        await expect(service.createPlan(owner.id, 1)).rejects.toThrow('当前渐进练习');
        expect((await service.getProgressivePath(other.id)).currentPlan).toBeNull();
        await expect(service.getPlan(other.id, created.id)).rejects.toThrow('学习计划不存在');

        const active = await service.generatePlan(owner.id, created.id);
        expect(active).toMatchObject({
          status: StudyPlanStatus.ACTIVE,
          blocksNewPlanCreation: true,
        });
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        const firstWord = active.words[0];
        const wrongAnswer = ['错误选项'];
        const afterWrong = await service.completeGroup(owner.id, created.id, firstWord.groupIndex, [
          { bookWordId: firstWord.id, selectedAnswer: wrongAnswer },
        ]);
        expect(
          afterWrong.words.find((word: { id: string }) => word.id === firstWord.id)?.result,
        ).toBe(false);
        const duplicateSubmit = await service.completeGroup(
          owner.id,
          created.id,
          firstWord.groupIndex,
          [{ bookWordId: firstWord.id, selectedAnswer: wrongAnswer }],
        );
        expect(duplicateSubmit.completed).toBe(1);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: owner.id } })).toBe(1);
        expect(await service.getProgressivePath(owner.id)).toMatchObject({
          highestUnlockedStage: 'foundation',
          currentPlan: expect.objectContaining({ id: created.id }),
        });

        const secondWord = active.words[1];
        await service.completeGroup(owner.id, created.id, secondWord.groupIndex, [
          { bookWordId: secondWord.id, selectedAnswer: ['错误选项'] },
        ]);
        expect(await prisma.wordReviewAttempt.count({ where: { userId: owner.id } })).toBe(2);
        expect(await service.getProgressivePath(owner.id)).toMatchObject({
          highestUnlockedStage: 'context',
          currentPlan: null,
        });
        expect(await prisma.userWordProgress.count({ where: { userId: owner.id } })).toBe(2);

        const replay = await service.createProgressivePlan(owner.id, 'foundation');
        expect(replay).toMatchObject({ purpose: 'progressive', progressiveStage: 'foundation' });
        const replayActive = await service.generatePlan(owner.id, replay.id);
        const replayWord = replayActive.words[0];
        await service.completeGroup(owner.id, replay.id, replayWord.groupIndex, [
          { bookWordId: replayWord.id, selectedAnswer: [replayWord.meaning] },
        ]);
        expect(await service.getProgressivePath(owner.id)).toMatchObject({
          highestUnlockedStage: 'context',
          currentPlan: null,
        });
        expect(await prisma.wordReviewAttempt.count({ where: { userId: owner.id } })).toBe(3);
      } finally {
        await app?.close();
        await prisma.studyPlan.deleteMany({ where: { userId: { in: users } } });
        await prisma.userVocabularyBook.deleteMany({ where: { userId: { in: users } } });
        await prisma.progressivePracticeProgress.deleteMany({ where: { userId: { in: users } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        if (bookIds.length)
          await prisma.vocabularyBook.deleteMany({ where: { id: { in: bookIds } } });
        if (wordIds.length)
          await prisma.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
