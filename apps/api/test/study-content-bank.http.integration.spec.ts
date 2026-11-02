import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Reflector } from '@nestjs/core';
import { PrismaClient, Role, StudyPlanMode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudyContentBankController } from '../src/modules/admin/study-content-bank.controller';
import { StudyContentBankService } from '../src/modules/admin/study-content-bank.service';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { studyQuestionFingerprint } from '../src/modules/study/study-content-bank';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'public study material bank HTTP authorization in an isolated database',
  () => {
    it('rejects anonymous and regular-user reads and writes, then permits an admin to manage a material', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const jwtSecret = `isolated-study-bank-${fixtureId}-secret`;
      let userIds: string[] = [];
      let cacheId: string | undefined;
      let app: NestFastifyApplication | undefined;

      try {
        const users = await Promise.all(
          [Role.USER, Role.ADMIN].map((role) =>
            prisma.user.create({
              data: {
                email: `study-bank-http-${fixtureId}-${role.toLowerCase()}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
                role,
              },
              select: { id: true },
            }),
          ),
        );
        userIds = users.map((user) => user.id);
        const [user, admin] = users;
        const cache = await prisma.studyContentCache.create({
          data: {
            signature: fixtureId.replaceAll('-', ''),
            mode: StudyPlanMode.INDIVIDUAL,
            material: {
              index: 0,
              title: 'HTTP authorization fixture',
              wordOccurrences: { steady: 1 },
              sentences: [],
              questions: [
                {
                  bookWordId: `word-${fixtureId}`,
                  type: 'MEANING_RECOGNITION',
                  prompt: 'What does steady mean?',
                  options: ['平稳的', '急促的'],
                  correctAnswers: ['平稳的'],
                  explanation: '隔离 HTTP 测试题目。',
                },
              ],
            },
            isPublic: true,
          },
          select: { id: true },
        });
        cacheId = cache.id;
        const question = {
          bookWordId: `word-${fixtureId}`,
          type: 'MEANING_RECOGNITION',
          prompt: 'What does steady mean?',
          options: ['平稳的', '急促的'],
          correctAnswers: ['平稳的'],
          explanation: '隔离 HTTP 测试题目。',
        };
        await prisma.studyContentQuestionFeedback.create({
          data: {
            userId: user.id,
            contentCacheId: cache.id,
            questionFingerprint: studyQuestionFingerprint(question),
            questionSnapshot: question,
            rating: 'DOWN',
            reason: 'QUESTION_UNCLEAR',
          },
        });

        const jwt = new JwtService({ secret: jwtSecret });
        const moduleRef = await Test.createTestingModule({
          imports: [JwtModule.register({})],
          controllers: [StudyContentBankController],
          providers: [
            {
              provide: StudyContentBankService,
              useValue: new StudyContentBankService(prisma as never),
            },
            JwtAuthGuard,
            RolesGuard,
            Reflector,
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
        const userToken = await jwt.signAsync(
          { sub: user.id, role: Role.USER },
          { secret: jwtSecret, expiresIn: '5m' },
        );
        const adminToken = await jwt.signAsync(
          { sub: admin.id, role: Role.ADMIN },
          { secret: jwtSecret, expiresIn: '5m' },
        );
        const route = '/api/v1/admin/study-content-bank';

        const anonymousRead = await fastify.inject({ method: 'GET', url: route });
        const userRead = await fastify.inject({
          method: 'GET',
          url: `${route}?feedback=negative`,
          headers: { authorization: `Bearer ${userToken}` },
        });
        const anonymousWrite = await fastify.inject({
          method: 'PATCH',
          url: `${route}/${cache.id}/status`,
          payload: { isActive: false, reason: 'should not be applied' },
        });
        const userWrite = await fastify.inject({
          method: 'PATCH',
          url: `${route}/${cache.id}/status`,
          headers: { authorization: `Bearer ${userToken}` },
          payload: { isActive: false, reason: 'should not be applied' },
        });

        expect(anonymousRead.statusCode).toBe(401);
        expect(userRead.statusCode, userRead.body).toBe(403);
        expect(anonymousWrite.statusCode).toBe(401);
        expect(userWrite.statusCode, userWrite.body).toBe(403);
        expect(
          await prisma.studyContentCache.findUniqueOrThrow({
            where: { id: cache.id },
            select: { isActive: true, disabledAt: true, disabledReason: true },
          }),
        ).toEqual({ isActive: true, disabledAt: null, disabledReason: null });

        const adminRead = await fastify.inject({
          method: 'GET',
          url: `${route}?feedback=negative`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(adminRead.statusCode).toBe(200);
        expect(adminRead.json().items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: cache.id,
              isActive: true,
              feedbackSummary: { up: 0, down: 1 },
            }),
          ]),
        );

        const adminWrite = await fastify.inject({
          method: 'PATCH',
          url: `${route}/${cache.id}/status`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { isActive: false, reason: '隔离 HTTP 管理验证' },
        });
        expect(adminWrite.statusCode).toBe(200);
        expect(adminWrite.json()).toMatchObject({
          id: cache.id,
          isPublic: true,
          isActive: false,
          disabledReason: '隔离 HTTP 管理验证',
        });
        expect(
          await prisma.studyContentCache.findUniqueOrThrow({
            where: { id: cache.id },
            select: { isActive: true, disabledReason: true, disabledByUserId: true },
          }),
        ).toEqual({
          isActive: false,
          disabledReason: '隔离 HTTP 管理验证',
          disabledByUserId: admin.id,
        });
      } finally {
        await app?.close();
        if (cacheId) await prisma.studyContentCache.deleteMany({ where: { id: cacheId } });
        if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
