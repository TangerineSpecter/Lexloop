import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { VocabularyController } from '../src/modules/vocabulary/vocabulary.controller';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';

const HISTORY_SIZE = 5_000;
const PAGE_SIZE = 50;

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'personal notebook word history in an isolated database',
  () => {
    it('returns only the owner’s exact collected word history with stable snapshot-backed pages', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const prefix = `notebook-word-history-${fixtureId}`;
      const normalized = `${prefix}-normalized`;
      const jwtSecret = `${prefix}-jwt-secret`;
      const users: Array<{ id: string }> = [];
      let app: NestFastifyApplication | undefined;

      try {
        users.push(
          ...(await Promise.all(
            ['owner', 'other'].map((suffix) =>
              prisma.user.create({
                data: {
                  email: `${prefix}-${suffix}@example.invalid`,
                  passwordHash: 'isolated-test-fixture',
                },
                select: { id: true },
              }),
            ),
          )),
        );
        const [owner, other] = users;
        // The automatic-plan sweep scans all users. Mark these fixtures as already processed
        // for its fixed integration-test date so it cannot race fixture cleanup.
        await prisma.automaticStudyPlanRun.createMany({
          data: users.map(({ id }) => ({
            userId: id,
            dateKey: '2026-11-02',
            status: 'GENERATED',
          })),
        });
        const word = await prisma.vocabularyWord.create({
          data: { normalized, text: 'river bank', meaning: '河岸' },
          select: { id: true },
        });
        const books = await Promise.all(
          [owner.id, owner.id, owner.id, owner.id, other.id].map((ownerId, index) =>
            prisma.vocabularyBook.create({
              data: {
                ownerId,
                kind: 'PERSONAL',
                sourceKey: `${prefix}-book-${index}`,
                category: 'GENERAL',
                title: `History fixture ${index}`,
                sourcePath: 'isolated-test',
              },
              select: { id: true },
            }),
          ),
        );
        const bookWords = await Promise.all(
          [0, 1, 2, 3, 4].map((index) =>
            prisma.vocabularyBookWord.create({
              data: {
                bookId: books[index].id,
                wordId: word.id,
                position: 0,
                isCollected: index !== 3,
              },
              select: { id: true },
            }),
          ),
        );
        const plan = await prisma.studyPlan.create({
          data: { userId: owner.id, status: 'ACTIVE' },
          select: { id: true },
        });
        const snapshotQuestion = {
          prompt: 'Choose the meaning shown in this saved question.',
          options: ['河岸', '山顶'],
          correctAnswers: ['河岸'],
          explanation: 'This is the saved historical explanation.',
        };
        const planItem = await prisma.studyPlanItem.create({
          data: {
            planId: plan.id,
            bookWordId: bookWords[0].id,
            source: 'REVIEW',
            groupIndex: 0,
            question: snapshotQuestion,
          },
          select: { id: true },
        });
        const tiedAt = new Date('2026-10-31T12:30:00.000Z');
        const oldRows = Array.from({ length: HISTORY_SIZE }, (_, index) => ({
          id: `${prefix}-attempt-${String(index).padStart(5, '0')}`,
          userId: owner.id,
          bookWordId: bookWords[0].id,
          isCorrect: index % 2 === 0,
          questionType: 'MEANING_RECOGNITION',
          selectedAnswer: index === 0 ? { answer: '旧答案' } : { answer: '河岸' },
          createdAt: tiedAt,
        }));
        for (let offset = 0; offset < oldRows.length; offset += 500) {
          await prisma.wordReviewAttempt.createMany({ data: oldRows.slice(offset, offset + 500) });
        }
        await prisma.wordReviewAttempt.create({
          data: {
            id: `${prefix}-plan-attempt`,
            userId: owner.id,
            bookWordId: bookWords[0].id,
            planItemId: planItem.id,
            isCorrect: true,
            questionType: 'CONTEXT_CHOICE',
            selectedAnswer: { answer: '河岸' },
            createdAt: new Date('2026-11-01T09:00:00.000Z'),
          },
        });
        await prisma.wordReviewAttempt.createMany({
          data: [
            {
              id: `${prefix}-other-account-attempt`,
              userId: other.id,
              bookWordId: bookWords[0].id,
              isCorrect: false,
              questionType: 'SHOULD_NOT_LEAK',
              createdAt: new Date('2026-11-02T09:00:00.000Z'),
            },
            {
              id: `${prefix}-other-book-attempt`,
              userId: owner.id,
              bookWordId: bookWords[1].id,
              isCorrect: false,
              questionType: 'SPELLING',
              selectedAnswer: { answer: 'bank' },
              createdAt: new Date('2026-11-02T08:00:00.000Z'),
            },
            {
              id: `${prefix}-other-owner-attempt`,
              userId: other.id,
              bookWordId: bookWords[4].id,
              isCorrect: true,
              questionType: 'SPELLING',
              createdAt: new Date('2026-11-02T08:00:00.000Z'),
            },
          ],
        });

        const service = new VocabularyService(prisma as never);
        const firstPage = await service.notebookWordHistory(owner.id, bookWords[0].id, {
          pageSize: PAGE_SIZE,
        });
        expect(firstPage.items).toHaveLength(PAGE_SIZE);
        expect(firstPage.items[0]).toMatchObject({
          id: `${prefix}-plan-attempt`,
          isCorrect: true,
          questionType: 'CONTEXT_CHOICE',
          source: 'STUDY_PLAN',
          selectedAnswer: '河岸',
          questionSnapshot: snapshotQuestion,
        });
        expect(firstPage.items.some((item) => item.id === `${prefix}-other-account-attempt`)).toBe(
          false,
        );
        expect(firstPage.hasMore).toBe(true);
        expect(firstPage.nextCursor).toBeTruthy();

        const allIds = firstPage.items.map((item) => item.id);
        const cursors = new Set([firstPage.nextCursor]);
        let page = firstPage;
        while (page.nextCursor) {
          page = await service.notebookWordHistory(owner.id, bookWords[0].id, {
            pageSize: PAGE_SIZE,
            cursor: page.nextCursor,
          });
          expect(page.items.length).toBeGreaterThan(0);
          allIds.push(...page.items.map((item) => item.id));
          if (page.nextCursor) {
            expect(cursors.has(page.nextCursor)).toBe(false);
            cursors.add(page.nextCursor);
          }
        }
        expect(allIds).toHaveLength(HISTORY_SIZE + 1);
        expect(new Set(allIds).size).toBe(HISTORY_SIZE + 1);
        expect(allIds.slice(1, 8)).toEqual(
          Array.from(
            { length: 7 },
            (_, index) => `${prefix}-attempt-${String(HISTORY_SIZE - index - 1).padStart(5, '0')}`,
          ),
        );
        const oldAttempt = page.items.at(-1);
        expect(oldAttempt).toMatchObject({
          id: `${prefix}-attempt-00000`,
          selectedAnswer: '旧答案',
          questionSnapshot: null,
        });

        const sameWordDifferentBook = await service.notebookWordHistory(owner.id, bookWords[1].id, {
          pageSize: PAGE_SIZE,
        });
        expect(sameWordDifferentBook.items.map((item) => item.id)).toEqual([
          `${prefix}-other-book-attempt`,
        ]);
        const empty = await service.notebookWordHistory(owner.id, bookWords[2].id, {
          pageSize: PAGE_SIZE,
        });
        expect(empty).toMatchObject({ items: [], hasMore: false, nextCursor: null });
        await expect(
          service.notebookWordHistory(owner.id, bookWords[1].id, {
            pageSize: PAGE_SIZE,
            cursor: firstPage.nextCursor!,
          }),
        ).rejects.toThrow('学习记录游标无效');
        await expect(
          service.notebookWordHistory(other.id, bookWords[0].id, { pageSize: PAGE_SIZE }),
        ).rejects.toThrow('生词本词条不存在');
        await expect(
          service.notebookWordHistory(other.id, bookWords[4].id, {
            pageSize: PAGE_SIZE,
            cursor: firstPage.nextCursor!,
          }),
        ).rejects.toThrow('学习记录游标无效');
        await expect(
          service.notebookWordHistory(owner.id, bookWords[3].id, { pageSize: PAGE_SIZE }),
        ).rejects.toThrow('生词本词条不存在');

        const moduleRef = await Test.createTestingModule({
          imports: [JwtModule.register({})],
          controllers: [VocabularyController],
          providers: [
            { provide: VocabularyService, useValue: service },
            JwtAuthGuard,
            {
              provide: ConfigService,
              useValue: { getOrThrow: () => jwtSecret },
            },
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
        const route = `/api/v1/vocabulary/personal/items/${bookWords[0].id}/history?pageSize=1`;
        const anonymous = await fastify.inject({ method: 'GET', url: route });
        const unauthorized = await fastify.inject({
          method: 'GET',
          url: route,
          headers: { authorization: `Bearer ${otherToken}` },
        });
        const authorized = await fastify.inject({
          method: 'GET',
          url: route,
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        expect(anonymous.statusCode).toBe(401);
        expect(unauthorized.statusCode).toBe(404);
        expect(authorized.statusCode, authorized.body).toBe(200);
        expect(authorized.json().items).toMatchObject([
          { id: `${prefix}-plan-attempt`, questionSnapshot: snapshotQuestion },
        ]);
        expect(authorized.json().hasMore).toBe(true);
      } finally {
        if (app) await app.close();
        await prisma.wordReviewAttempt.deleteMany({ where: { id: { startsWith: `${prefix}-` } } });
        if (users.length)
          await prisma.user.deleteMany({ where: { id: { in: users.map((item) => item.id) } } });
        await prisma.vocabularyWord.deleteMany({ where: { normalized } });
        await prisma.$disconnect();
      }
    }, 120_000);
  },
);
