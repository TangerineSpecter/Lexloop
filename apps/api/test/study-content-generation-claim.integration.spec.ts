import { PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readSystemLogDiagnostic } from '../src/common/system-log-diagnostic';
import { StudyService, contentSignature } from '../src/modules/study/study.service';
import {
  getStudyContentClaimStatus,
  releaseStudyContentClaims,
  renewStudyContentClaims,
  tryClaimStudyContentSignature,
  tryClaimStudyContentSignatures,
} from '../src/modules/study/study-content-generation-claim';

function makeResponse(prompt: string) {
  const match = prompt.match(/^输入分组：(.*)$/m);
  if (!match) throw new Error('fixture did not receive group input');
  const groups = JSON.parse(match[1]) as Array<{
    index: number;
    words: Array<{ id: string; word: string }>;
  }>;
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            groups: groups.map((group) => {
              const word = group.words[0].word;
              return {
                index: group.index,
                title: `A clear path with ${word}`,
                wordOccurrences: { [word]: 1 },
                sentences: [
                  {
                    english: `The ${word} path led to a quiet village.`,
                    chinese: '这条平稳的小路通向安静的村庄。',
                    simplified: '平稳的小路通向安静的村庄。',
                    grammar: `${word} 在句中作形容词。`,
                  },
                ],
                questions: [
                  {
                    bookWordId: group.words[0].id,
                    type: 'MEANING_RECOGNITION',
                    prompt: `What does ${word} describe in the sentence?`,
                    options: ['平稳的', '突然的', '狭窄的', '遥远的'],
                    correctAnswers: ['平稳的'],
                    explanation: '结合句中道路通向村庄的语境判断词义。',
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
  'public study content generation single-flight in an isolated database',
  () => {
    it('shares one generation across accounts, rechecks the cache, and logs only safe info observations', async () => {
      const fixtureId = randomUUID();
      const queryClients: PrismaClient[] = [];
      const admin = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const serviceClients = [
        new PrismaClient({
          datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
          log: [{ emit: 'event', level: 'query' }],
        }),
        new PrismaClient({
          datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
          log: [{ emit: 'event', level: 'query' }],
        }),
      ];
      queryClients.push(admin, ...serviceClients);
      const userIds: string[] = [];
      let bookId: string | undefined;
      let bookWordId: string | undefined;
      let wordId: string | undefined;
      let signature: string | undefined;
      let planIds: string[] = [];
      const logEvents: Array<Record<string, unknown>> = [];
      let resolveGeneration!: (value: unknown) => void;
      const generationGate = new Promise<unknown>((resolve) => {
        resolveGeneration = resolve;
      });
      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
          await generationGate;
          return makeResponse(prompt);
        }),
      };
      const modelConfigs = { selectedProvider: vi.fn(async () => ({ id: 'offline-fixture' })) };
      const services = serviceClients.map((client) => {
        const service = new StudyService(
          client as never,
          ai as never,
          modelConfigs as never,
          {} as never,
          { record: async (entry: Record<string, unknown>) => void logEvents.push(entry) } as never,
        );
        Object.defineProperty(service, 'cacheClaimPollIntervalMs', { value: 5 });
        return service;
      });
      let claimInsertCount = 0;
      for (const client of serviceClients) {
        client.$on('query', (event) => {
          if (event.query.includes('INSERT INTO "public"."StudyContentGenerationClaim"')) {
            claimInsertCount += 1;
          }
        });
      }

      try {
        const users = await Promise.all(
          ['first', 'second'].map((suffix) =>
            admin.user.create({
              data: {
                email: `study-single-flight-${fixtureId}-${suffix}@example.invalid`,
                passwordHash: 'isolated-test-fixture',
              },
              select: { id: true, email: true },
            }),
          ),
        );
        userIds.push(...users.map((user) => user.id));
        const book = await admin.vocabularyBook.create({
          data: {
            kind: 'SYSTEM',
            sourceKey: `study-single-flight-${fixtureId}`,
            title: 'Single flight test vocabulary',
            sourcePath: 'isolated-test',
            category: 'GENERAL',
            bookWords: {
              create: {
                position: 0,
                word: {
                  create: {
                    normalized: `study-single-flight-${fixtureId}`,
                    text: 'steady',
                    meaning: 'adj. 平稳的',
                  },
                },
              },
            },
          },
          select: { id: true, bookWords: { select: { id: true, wordId: true } } },
        });
        bookId = book.id;
        bookWordId = book.bookWords[0].id;
        wordId = book.bookWords[0].wordId;
        signature = contentSignature(StudyPlanMode.GROUP, [
          { id: bookWordId, word: 'steady', part: 'adj.', meaning: '平稳的' },
        ]);
        const plans = await Promise.all(
          users.map((user) =>
            admin.studyPlan.create({
              data: {
                userId: user.id,
                mode: StudyPlanMode.GROUP,
                purpose: StudyPlanPurpose.NORMAL,
                status: 'GENERATING',
                items: {
                  create: { bookWordId: bookWordId!, source: 'NEW', groupIndex: 0 },
                },
              },
              select: { id: true },
            }),
          ),
        );
        planIds = plans.map((plan) => plan.id);

        const firstGeneration = services[0].generatePlan(userIds[0], planIds[0]);
        await vi.waitFor(() => expect(ai.generateForUser).toHaveBeenCalledTimes(1));
        const secondGeneration = services[1].generatePlan(userIds[1], planIds[1]);
        await vi.waitFor(() => expect(claimInsertCount).toBeGreaterThanOrEqual(2), {
          timeout: 10_000,
          interval: 5,
        });
        resolveGeneration({});

        const [first, second] = await Promise.all([firstGeneration, secondGeneration]);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        expect(first.status).toBe('ACTIVE');
        expect(second.status).toBe('ACTIVE');
        const items = await admin.studyPlanItem.findMany({
          where: { planId: { in: planIds } },
          orderBy: { planId: 'asc' },
          select: { planId: true, contentCacheId: true, question: true },
        });
        expect(items).toHaveLength(2);
        expect(items[0].planId).not.toBe(items[1].planId);
        expect(items[0].contentCacheId).toBeTruthy();
        expect(items[0].contentCacheId).toBe(items[1].contentCacheId);
        expect(items.every((item) => item.question !== null)).toBe(true);
        expect(await admin.studyContentCache.count({ where: { signature, isPublic: true } })).toBe(
          1,
        );
        expect(
          await admin.studyContentCache.findFirstOrThrow({
            where: { signature },
            select: { hitCount: true },
          }),
        ).toEqual({ hitCount: 1 });
        expect(await admin.studyContentGenerationClaim.count({ where: { signature } })).toBe(0);
        expect(
          await admin.userWordProgress.count({ where: { userId: { in: userIds }, bookWordId } }),
        ).toBe(2);

        expect(logEvents.map((entry) => entry.severity)).toEqual(['info', 'info']);
        expect(logEvents.map((entry) => entry.code).sort()).toEqual([
          'STUDY_CACHE_MISS_NO_PUBLIC',
          'STUDY_CACHE_REUSED',
        ]);
        const serializedLogs = JSON.stringify(logEvents);
        expect(serializedLogs).not.toContain(signature);
        expect(serializedLogs).not.toContain('steady');
        expect(serializedLogs).not.toContain(fixtureId);
        expect(serializedLogs).not.toContain(users[0].email);
      } finally {
        resolveGeneration({});
        if (signature) {
          await admin.studyContentGenerationClaim.deleteMany({ where: { signature } });
          await admin.studyContentCache.deleteMany({ where: { signature } });
        }
        if (planIds.length) await admin.studyPlan.deleteMany({ where: { id: { in: planIds } } });
        if (userIds.length) await admin.user.deleteMany({ where: { id: { in: userIds } } });
        if (bookId) await admin.vocabularyBook.delete({ where: { id: bookId } });
        if (wordId) await admin.vocabularyWord.deleteMany({ where: { id: wordId } });
        await Promise.all(queryClients.map((client) => client.$disconnect()));
      }
    }, 60_000);

    it('takes over expired leases, fences stale owners, cools down failures, and frees unrelated signatures', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      const signature = createHash('sha256').update(`${fixtureId}-stale`).digest('hex');
      const otherSignature = createHash('sha256').update(`${fixtureId}-other`).digest('hex');
      try {
        expect(await tryClaimStudyContentSignature(prisma as never, signature, 'old-owner')).toBe(
          true,
        );
        await prisma.studyContentGenerationClaim.update({
          where: { signature },
          data: { leaseExpiresAt: new Date(Date.now() - 1) },
        });
        expect(await tryClaimStudyContentSignature(prisma as never, signature, 'new-owner')).toBe(
          true,
        );
        expect(await renewStudyContentClaims(prisma as never, [signature], 'old-owner')).toBe(
          false,
        );
        await releaseStudyContentClaims(prisma as never, [signature], 'old-owner');
        expect(await getStudyContentClaimStatus(prisma as never, signature)).toBe('BUSY');

        expect(
          await tryClaimStudyContentSignatures(
            prisma as never,
            [signature, otherSignature],
            'partial-owner',
          ),
        ).toBe(false);
        expect(
          await prisma.studyContentGenerationClaim.findUnique({
            where: { signature: otherSignature },
          }),
        ).toBeNull();
        expect(
          await tryClaimStudyContentSignature(prisma as never, otherSignature, 'other-owner'),
        ).toBe(true);

        const alreadyWaitingStartedAt = new Date(Date.now() - 10);
        await releaseStudyContentClaims(
          prisma as never,
          [signature],
          'new-owner',
          'STUDY_CACHE_PROVIDER_FAILED',
        );
        expect(await getStudyContentClaimStatus(prisma as never, signature)).toBe('COOLDOWN');
        expect(
          await tryClaimStudyContentSignature(
            prisma as never,
            signature,
            'already-waiting-owner',
            new Date(),
            alreadyWaitingStartedAt,
          ),
        ).toBe(false);
        expect(await tryClaimStudyContentSignature(prisma as never, signature, 'retry-owner')).toBe(
          true,
        );
      } finally {
        await prisma.studyContentGenerationClaim.deleteMany({
          where: { signature: { in: [signature, otherSignature] } },
        });
        await prisma.$disconnect();
      }
    }, 30_000);

    it('bounds waiting on another account and makes no provider request on timeout', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixtureId = randomUUID();
      let userId: string | undefined;
      let bookId: string | undefined;
      let bookWordId: string | undefined;
      let wordId: string | undefined;
      let planId: string | undefined;
      let signature: string | undefined;
      try {
        const user = await prisma.user.create({
          data: {
            email: `study-claim-timeout-${fixtureId}@example.invalid`,
            passwordHash: 'isolated-test-fixture',
          },
          select: { id: true },
        });
        userId = user.id;
        const book = await prisma.vocabularyBook.create({
          data: {
            kind: 'SYSTEM',
            sourceKey: `study-claim-timeout-${fixtureId}`,
            title: 'Claim timeout vocabulary',
            sourcePath: 'isolated-test',
            category: 'GENERAL',
            bookWords: {
              create: {
                position: 0,
                word: {
                  create: {
                    normalized: `study-claim-timeout-${fixtureId}`,
                    text: 'steady',
                    meaning: 'adj. 平稳的',
                  },
                },
              },
            },
          },
          select: { id: true, bookWords: { select: { id: true, wordId: true } } },
        });
        bookId = book.id;
        bookWordId = book.bookWords[0].id;
        wordId = book.bookWords[0].wordId;
        signature = contentSignature(StudyPlanMode.GROUP, [
          { id: bookWordId, word: 'steady', part: 'adj.', meaning: '平稳的' },
        ]);
        const plan = await prisma.studyPlan.create({
          data: {
            userId,
            mode: StudyPlanMode.GROUP,
            purpose: StudyPlanPurpose.NORMAL,
            status: 'GENERATING',
            items: {
              create: { bookWordId, source: 'NEW', groupIndex: 0 },
            },
          },
          select: { id: true },
        });
        planId = plan.id;
        expect(
          await tryClaimStudyContentSignature(prisma as never, signature, 'active-owner'),
        ).toBe(true);
        const ai = { generateForUser: vi.fn() };
        const logRecords: Array<Record<string, unknown>> = [];
        const service = new StudyService(
          prisma as never,
          ai as never,
          { selectedProvider: vi.fn(async () => ({ id: 'offline-fixture' })) } as never,
          {} as never,
          {
            record: async (entry: Record<string, unknown>) => void logRecords.push(entry),
          } as never,
        );
        Object.defineProperty(service, 'cacheClaimWaitTimeoutMs', { value: 25 });
        Object.defineProperty(service, 'cacheClaimPollIntervalMs', { value: 5 });

        const failure = await service.generatePlan(userId, planId).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('等待相同公共学习材料超过时限');
        expect(readSystemLogDiagnostic(failure)).toMatchObject({
          code: 'STUDY_CACHE_GENERATION_WAIT_TIMEOUT',
          phase: 'internal',
          fieldPath: 'public_material_claim',
          reason: '等待同一公共材料超过时限；已停止发起重复模型请求。',
        });
        expect(ai.generateForUser).not.toHaveBeenCalled();
        expect(
          await prisma.studyPlan.findUniqueOrThrow({
            where: { id: planId },
            select: { status: true, generationError: true },
          }),
        ).toMatchObject({
          status: 'FAILED',
          generationError: expect.stringContaining('没有重复发起模型请求'),
        });
        expect(logRecords).toEqual([]);
      } finally {
        if (signature) {
          await prisma.studyContentGenerationClaim.deleteMany({ where: { signature } });
          await prisma.studyContentCache.deleteMany({ where: { signature } });
        }
        if (planId) await prisma.studyPlan.deleteMany({ where: { id: planId } });
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        if (bookId) await prisma.vocabularyBook.delete({ where: { id: bookId } });
        if (wordId) await prisma.vocabularyWord.deleteMany({ where: { id: wordId } });
        await prisma.$disconnect();
      }
    }, 30_000);
  },
);
