import { Prisma, PrismaClient, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StudyContentBankService } from '../src/modules/admin/study-content-bank.service';
import {
  STUDY_GENERATION_TOTAL_TIMEOUT_MS,
  StudyService,
  contentSignature,
} from '../src/modules/study/study.service';
import { lexicalFields } from '../src/modules/vocabulary/lexical';

type FixtureGroup = {
  wordId: string;
  bookWordId: string;
  signature: string;
  cacheId: string;
  word: string;
};

type Fixture = {
  userId: string;
  adminId: string;
  bookId: string;
  wordId: string;
  bookWordId: string;
  signature: string;
  cacheId: string;
  planId: string;
  groups: FixtureGroup[];
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => (resolve = complete));
  return { promise, resolve };
}

function materialFor(bookWordId: string, word: string, title: string) {
  return {
    index: 0,
    title,
    wordOccurrences: { [word]: 1 },
    sentences: [
      {
        english: `The ${word} light guided us home.`,
        chinese: '稳定的光线引导我们回家。',
        simplified: '稳定的光线引导我们回家。',
        grammar: '形容词修饰名词。',
      },
    ],
    questions: [
      {
        bookWordId,
        type: 'MEANING_RECOGNITION',
        prompt: `What does ${word} mean in this sentence?`,
        options: ['稳定的', '急促的', '沉重的', '柔软的'],
        correctAnswers: ['稳定的'],
        explanation: '结合句中稳定的光线理解这个词。',
      },
    ],
  };
}

async function seedFixture(
  prisma: PrismaClient,
  fixtureId: string,
  groupCount = 1,
): Promise<Fixture> {
  const [user, admin] = await Promise.all(
    ['learner', 'admin'].map((kind) =>
      prisma.user.create({
        data: {
          email: `study-cache-disable-race-${fixtureId}-${kind}@example.invalid`,
          passwordHash: 'isolated-test-fixture',
          ...(kind === 'admin' ? { role: 'ADMIN' as const } : {}),
        },
        select: { id: true },
      }),
    ),
  );
  // The isolated API suite shares one database across integration files. Keep
  // the automatic-plan sweep fixture from selecting and racing cleanup of
  // these temporary users.
  await prisma.automaticStudyPlanRun.createMany({
    data: [user.id, admin.id].map((userId) => ({ userId, dateKey: '2026-11-02' })),
  });
  const book = await prisma.vocabularyBook.create({
    data: {
      kind: 'SYSTEM',
      sourceKey: `study-cache-disable-race-${fixtureId}`,
      title: 'Public cache disable race fixture',
      sourcePath: 'isolated-test',
      category: 'GENERAL',
      bookWords: {
        create: Array.from({ length: groupCount }, (_, position) => ({
          position,
          word: {
            create: {
              normalized: `study-cache-disable-race-${fixtureId}-${position}`,
              text: position === 0 ? 'steady' : `gentle${position}`,
              meaning: 'adj. 稳定的',
            },
          },
        })),
      },
    },
    include: { bookWords: { include: { word: true } } },
  });
  const groups = await Promise.all(
    book.bookWords.map(async (bookWord) => {
      const lexical = lexicalFields(bookWord.contextMeaning ?? bookWord.word.meaning);
      const signature = contentSignature(
        StudyPlanMode.INDIVIDUAL,
        [
          {
            id: bookWord.id,
            word: bookWord.word.text,
            part: lexical.part,
            meaning: lexical.meaning,
          },
        ],
        StudyPlanPurpose.NORMAL,
      );
      const cache = await prisma.studyContentCache.create({
        data: {
          signature,
          mode: StudyPlanMode.INDIVIDUAL,
          isPublic: true,
          material: materialFor(bookWord.id, bookWord.word.text, '共享材料快照'),
        },
        select: { id: true },
      });
      return {
        wordId: bookWord.wordId,
        bookWordId: bookWord.id,
        signature,
        cacheId: cache.id,
        word: bookWord.word.text,
      };
    }),
  );
  const firstGroup = groups[0];
  const plan = await prisma.studyPlan.create({
    data: {
      userId: user.id,
      mode: StudyPlanMode.INDIVIDUAL,
      purpose: StudyPlanPurpose.NORMAL,
      status: 'GENERATING',
      items: {
        create: groups.map((group, groupIndex) => ({
          bookWordId: group.bookWordId,
          source: 'NEW',
          groupIndex,
        })),
      },
    },
    select: { id: true },
  });
  return {
    userId: user.id,
    adminId: admin.id,
    bookId: book.id,
    wordId: firstGroup.wordId,
    bookWordId: firstGroup.bookWordId,
    signature: firstGroup.signature,
    cacheId: firstGroup.cacheId,
    planId: plan.id,
    groups,
  };
}

async function cleanFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.studyPlan.deleteMany({ where: { userId: fixture.userId } });
  await prisma.studyContentGenerationClaim.deleteMany({
    where: { signature: { in: fixture.groups.map((group) => group.signature) } },
  });
  await prisma.studyContentCache.deleteMany({
    where: { signature: { in: fixture.groups.map((group) => group.signature) } },
  });
  await prisma.user.deleteMany({ where: { id: { in: [fixture.userId, fixture.adminId] } } });
  await prisma.vocabularyBook.deleteMany({ where: { id: fixture.bookId } });
  await prisma.vocabularyWord.deleteMany({
    where: { id: { in: fixture.groups.map((group) => group.wordId) }, bookWords: { none: {} } },
  });
}

function pauseAfterCandidateRead(prisma: PrismaClient, cacheId: string) {
  const candidateSelected = deferred();
  const candidateCanContinue = deferred();
  let intercepted = false;
  const client = new Proxy(prisma, {
    get(target, property) {
      if (property === '$queryRaw') {
        const query = Reflect.get(target, property, target) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const rows = await query.apply(target, args);
          if (
            !intercepted &&
            Array.isArray(rows) &&
            rows.some((row) => row && typeof row === 'object' && 'id' in row && row.id === cacheId)
          ) {
            intercepted = true;
            candidateSelected.resolve();
            await candidateCanContinue.promise;
          }
          return rows;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    client,
    candidateSelected: candidateSelected.promise,
    resume: candidateCanContinue.resolve,
  };
}

function interceptCacheTransactionUpdate(prisma: PrismaClient, pauseOnCacheId?: string) {
  const updateReached = deferred();
  const resumeUpdate = deferred();
  const observedCacheIds: string[] = [];
  let paused = false;
  const client = new Proxy(prisma, {
    get(target, property) {
      if (property !== '$transaction') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const transaction = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') {
          return transaction.call(target, callback, ...options);
        }
        return transaction.call(
          target,
          (tx: Prisma.TransactionClient) => {
            const proxiedTx = new Proxy(tx, {
              get(txTarget, txProperty) {
                const delegate = Reflect.get(txTarget, txProperty, txTarget);
                if (txProperty !== 'studyContentCache') {
                  return typeof delegate === 'function' ? delegate.bind(txTarget) : delegate;
                }
                return new Proxy(delegate as object, {
                  get(delegateTarget, method) {
                    const operation = Reflect.get(delegateTarget, method, delegateTarget);
                    if (method !== 'updateMany' || typeof operation !== 'function') {
                      return typeof operation === 'function'
                        ? operation.bind(delegateTarget)
                        : operation;
                    }
                    return async (args: { where?: { id?: string } }) => {
                      const cacheId = args.where?.id;
                      if (cacheId) {
                        observedCacheIds.push(cacheId);
                      }
                      const shouldPause =
                        !paused && cacheId && (pauseOnCacheId ? cacheId === pauseOnCacheId : true);
                      if (shouldPause) {
                        paused = true;
                        updateReached.resolve();
                        await resumeUpdate.promise;
                      }
                      return operation.call(delegateTarget, args);
                    };
                  },
                });
              },
            });
            return (callback as (transactionClient: Prisma.TransactionClient) => unknown)(
              proxiedTx,
            );
          },
          ...options,
        );
      };
    },
  });
  return {
    client,
    updateReached: updateReached.promise,
    resume: resumeUpdate.resolve,
    observedCacheIds,
  };
}

function generatedModel(title: string) {
  return {
    generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
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
                groups: groups.map(({ index, words }) => ({
                  ...materialFor(words[0].id, words[0].word, title),
                  index,
                })),
              }),
            },
          },
        ],
      };
    }),
  };
}

function createStudyService(
  prisma: PrismaClient,
  ai: ReturnType<typeof generatedModel>,
  onSelectProvider?: () => void,
) {
  return new StudyService(
    prisma as never,
    ai as never,
    {
      selectedProvider: async () => {
        onSelectProvider?.();
        return { id: 'isolated-fixture-model' };
      },
    } as never,
    {} as never,
  );
}

function shortenClaimWait(service: StudyService, waitMs: number) {
  Object.defineProperty(service, 'cacheClaimWaitTimeoutMs', { value: waitMs });
}

async function createPlanForGroups(
  prisma: PrismaClient,
  userId: string,
  groups: FixtureGroup[],
  status: 'GENERATING' | 'ACTIVE' = 'GENERATING',
) {
  return prisma.studyPlan.create({
    data: {
      userId,
      mode: StudyPlanMode.INDIVIDUAL,
      purpose: StudyPlanPurpose.NORMAL,
      status,
      items: {
        create: groups.map((group, groupIndex) => ({
          bookWordId: group.bookWordId,
          source: 'NEW',
          groupIndex,
        })),
      },
    },
    select: { id: true },
  });
}

async function recordCorrectCacheAttempt(
  prisma: PrismaClient,
  userId: string,
  group: FixtureGroup,
) {
  const question = materialFor(group.bookWordId, group.word, '共享材料快照').questions[0];
  const plan = await prisma.studyPlan.create({
    data: {
      userId,
      mode: StudyPlanMode.INDIVIDUAL,
      purpose: StudyPlanPurpose.NORMAL,
      status: 'ACTIVE',
      generatedContent: { groups: [materialFor(group.bookWordId, group.word, '共享材料快照')] },
      items: {
        create: {
          bookWordId: group.bookWordId,
          contentCacheId: group.cacheId,
          source: 'NEW',
          groupIndex: 0,
          question: question as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      },
    },
    include: { items: { select: { id: true } } },
  });
  await prisma.wordReviewAttempt.create({
    data: {
      userId,
      bookWordId: group.bookWordId,
      planItemId: plan.items[0].id,
      isCorrect: true,
      questionType: 'MEANING_RECOGNITION',
      selectedAnswer: ['稳定的'],
    },
  });
  return plan.id;
}

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'public material deactivation during plan generation in an isolated database',
  () => {
    it('replaces a disabled candidate after its selection and de-duplicates the same plan request', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID());
      const barrier = pauseAfterCandidateRead(prisma, fixture.cacheId);
      const ai = generatedModel('新生成的替代材料');
      const service = createStudyService(barrier.client, ai);
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.candidateSelected;
        const repeatedRequest = await service.generatePlan(fixture.userId, fixture.planId);
        expect(repeatedRequest.status).toBe('GENERATING');
        expect(ai.generateForUser).not.toHaveBeenCalled();

        await bank.setActive(fixture.cacheId, false, '并发停用测试', fixture.adminId);
        barrier.resume();
        const result = await generation;

        expect(result.status).toBe('ACTIVE');
        expect(result.content).toMatchObject({ groups: [{ title: '新生成的替代材料' }] });
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        const [savedItem, disabledCache] = await Promise.all([
          prisma.studyPlanItem.findFirstOrThrow({
            where: { planId: fixture.planId },
            select: { contentCacheId: true, question: true },
          }),
          prisma.studyContentCache.findUniqueOrThrow({
            where: { id: fixture.cacheId },
            select: { isActive: true, hitCount: true, material: true },
          }),
        ]);
        expect(savedItem.contentCacheId).not.toBe(fixture.cacheId);
        expect(savedItem.question).toMatchObject({ bookWordId: fixture.bookWordId });
        expect(disabledCache).toMatchObject({ isActive: false, hitCount: 0 });
        expect(disabledCache.material).toMatchObject({ title: '共享材料快照' });
        expect(
          await prisma.studyContentCache.count({
            where: { id: { not: fixture.cacheId }, signature: fixture.signature, isActive: true },
          }),
        ).toBe(1);
      } finally {
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('reclaims every signature when a cached candidate is disabled during the initial read', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID(), 2);
      const previouslyCached = fixture.groups[1];
      const barrier = pauseAfterCandidateRead(prisma, previouslyCached.cacheId);
      const ai = generatedModel('已持有租约的全新材料');
      const service = createStudyService(barrier.client, ai);
      const bank = new StudyContentBankService(prisma as never);
      try {
        // The first signature is already familiar to this user, while the
        // second is reusable when the initial cache query begins.
        await recordCorrectCacheAttempt(prisma, fixture.userId, fixture.groups[0]);
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.candidateSelected;
        await bank.setActive(previouslyCached.cacheId, false, '初始查询期间停用', fixture.adminId);
        barrier.resume();

        const result = await generation;
        expect(result.status).toBe('ACTIVE');
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);

        const [items, cacheRows, claims] = await Promise.all([
          prisma.studyPlanItem.findMany({
            where: { planId: fixture.planId },
            orderBy: { groupIndex: 'asc' },
            select: { bookWordId: true, contentCacheId: true },
          }),
          prisma.studyContentCache.findMany({
            where: { signature: { in: fixture.groups.map((group) => group.signature) } },
            orderBy: [{ signature: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, signature: true, isActive: true, hitCount: true, material: true },
          }),
          prisma.studyContentGenerationClaim.findMany({
            where: { signature: { in: fixture.groups.map((group) => group.signature) } },
            select: { signature: true, ownerToken: true },
          }),
        ]);
        expect(items).toHaveLength(2);
        expect(cacheRows).toHaveLength(4);
        for (const group of fixture.groups) {
          const rows = cacheRows.filter((cache) => cache.signature === group.signature);
          expect(rows).toHaveLength(2);
          const original = rows.find((cache) => cache.id === group.cacheId)!;
          expect(original.hitCount).toBe(0);
          expect(original.isActive).toBe(group.bookWordId === fixture.groups[0].bookWordId);
          const replacements = rows.filter((cache) => cache.id !== group.cacheId);
          expect(replacements).toHaveLength(1);
          const replacement = replacements[0];
          expect(replacement.isActive).toBe(true);
          expect(replacement.id).not.toBe(group.cacheId);
          expect(replacement.hitCount).toBe(0);
          expect(replacement.material).toMatchObject({ title: '已持有租约的全新材料' });
          const savedItem = items.find((item) => item.bookWordId === group.bookWordId);
          expect(savedItem?.contentCacheId).toBe(replacement.id);
        }
        expect(claims).toEqual([]);
      } finally {
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('preserves a plan snapshot when its cache is disabled after assignment commits', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID());
      const ai = generatedModel('不应生成的替代材料');
      const service = createStudyService(prisma, ai);
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generated = await service.generatePlan(fixture.userId, fixture.planId);
        expect(generated.content).toMatchObject({ groups: [{ title: '共享材料快照' }] });
        await bank.setActive(fixture.cacheId, false, '已分配后停用', fixture.adminId);

        const [reopened, item, cache] = await Promise.all([
          service.getPlan(fixture.userId, fixture.planId),
          prisma.studyPlanItem.findFirstOrThrow({
            where: { planId: fixture.planId },
            select: { contentCacheId: true, question: true },
          }),
          prisma.studyContentCache.findUniqueOrThrow({
            where: { id: fixture.cacheId },
            select: { isActive: true, hitCount: true },
          }),
        ]);
        expect(reopened.content).toMatchObject({ groups: [{ title: '共享材料快照' }] });
        expect(item).toMatchObject({
          contentCacheId: fixture.cacheId,
          question: { bookWordId: fixture.bookWordId },
        });
        expect(cache).toEqual({ isActive: false, hitCount: 1 });
        expect(ai.generateForUser).not.toHaveBeenCalled();
      } finally {
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('uses an active cache when it is restored before the save transaction wins the row lock', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID());
      const barrier = pauseAfterCandidateRead(prisma, fixture.cacheId);
      const ai = generatedModel('不应生成的替代材料');
      const service = createStudyService(barrier.client, ai);
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.candidateSelected;
        await bank.setActive(fixture.cacheId, false, '暂时停用后恢复', fixture.adminId);
        await bank.setActive(fixture.cacheId, true, undefined, fixture.adminId);
        barrier.resume();
        const result = await generation;

        expect(result.status).toBe('ACTIVE');
        expect(result.content).toMatchObject({ groups: [{ title: '共享材料快照' }] });
        expect(ai.generateForUser).not.toHaveBeenCalled();
        expect(
          await prisma.studyContentCache.findUniqueOrThrow({
            where: { id: fixture.cacheId },
            select: { isActive: true, disabledAt: true, hitCount: true },
          }),
        ).toEqual({ isActive: true, disabledAt: null, hitCount: 1 });
      } finally {
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('rolls back cache hit counts and plan snapshots when replacement generation fails', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID());
      const barrier = pauseAfterCandidateRead(prisma, fixture.cacheId);
      const ai = {
        generateForUser: vi.fn().mockRejectedValue(new Error('isolated replacement failure')),
      };
      const service = createStudyService(barrier.client, ai as never);
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.candidateSelected;
        await bank.setActive(fixture.cacheId, false, '失败回滚测试', fixture.adminId);
        barrier.resume();
        await expect(generation).rejects.toThrow('学习计划生成失败');

        const [plan, item, cache, activeCount, progressCount] = await Promise.all([
          prisma.studyPlan.findUniqueOrThrow({
            where: { id: fixture.planId },
            select: { status: true, generatedContent: true },
          }),
          prisma.studyPlanItem.findFirstOrThrow({
            where: { planId: fixture.planId },
            select: { contentCacheId: true, question: true },
          }),
          prisma.studyContentCache.findUniqueOrThrow({
            where: { id: fixture.cacheId },
            select: { isActive: true, hitCount: true },
          }),
          prisma.studyContentCache.count({
            where: { id: { not: fixture.cacheId }, signature: fixture.signature, isActive: true },
          }),
          prisma.userWordProgress.count({
            where: { userId: fixture.userId, bookWordId: fixture.bookWordId },
          }),
        ]);
        expect(plan).toEqual({ status: 'FAILED', generatedContent: null });
        expect(item).toEqual({ contentCacheId: null, question: null });
        expect(cache).toEqual({ isActive: false, hitCount: 0 });
        expect(activeCount).toBe(0);
        expect(progressCount).toBe(0);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
      } finally {
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('rolls back an earlier cache hit when a later group is disabled before its conditional update', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID(), 2);
      const second = fixture.groups[1];
      const barrier = interceptCacheTransactionUpdate(prisma, second.cacheId);
      const ai = generatedModel('第二组替代材料');
      const service = createStudyService(barrier.client, ai);
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.updateReached;
        expect(barrier.observedCacheIds).toEqual([fixture.groups[0].cacheId, second.cacheId]);
        await bank.setActive(second.cacheId, false, '第二组保存前停用', fixture.adminId);
        barrier.resume();

        const result = await generation;
        expect(result.status).toBe('ACTIVE');
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
        const [firstCache, disabledCache, items] = await Promise.all([
          prisma.studyContentCache.findUniqueOrThrow({
            where: { id: fixture.groups[0].cacheId },
            select: { isActive: true, hitCount: true },
          }),
          prisma.studyContentCache.findUniqueOrThrow({
            where: { id: second.cacheId },
            select: { isActive: true, hitCount: true },
          }),
          prisma.studyPlanItem.findMany({
            where: { planId: fixture.planId },
            orderBy: { groupIndex: 'asc' },
            select: { contentCacheId: true },
          }),
        ]);
        expect(firstCache).toEqual({ isActive: true, hitCount: 1 });
        expect(disabledCache).toEqual({ isActive: false, hitCount: 0 });
        expect(items[0].contentCacheId).toBe(fixture.groups[0].cacheId);
        expect(items[1].contentCacheId).not.toBe(second.cacheId);
        expect(barrier.observedCacheIds).toEqual([
          fixture.groups[0].cacheId,
          second.cacheId,
          fixture.groups[0].cacheId,
        ]);
      } finally {
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('releases partial claims before waiting when two plans need each other’s signatures', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID(), 2);
      const secondUser = await prisma.user.create({
        data: {
          email: `study-cache-disable-race-${randomUUID()}-second@example.invalid`,
          passwordHash: 'isolated-test-fixture',
        },
        select: { id: true },
      });
      await prisma.automaticStudyPlanRun.create({
        data: { userId: secondUser.id, dateKey: '2026-11-02' },
      });
      const planB = await createPlanForGroups(prisma, secondUser.id, fixture.groups);
      const cacheX = fixture.groups[0];
      const cacheY = fixture.groups[1];
      const barrierA = pauseAfterCandidateRead(prisma, cacheY.cacheId);
      const barrierB = pauseAfterCandidateRead(prisma, cacheX.cacheId);
      const txA = interceptCacheTransactionUpdate(barrierA.client as PrismaClient);
      const txB = interceptCacheTransactionUpdate(barrierB.client as PrismaClient);
      const aiA = generatedModel('计划A局部生成材料');
      const aiB = generatedModel('计划B局部生成材料');
      const serviceA = createStudyService(txA.client, aiA);
      const serviceB = createStudyService(txB.client, aiB);
      shortenClaimWait(serviceA, 1_500);
      shortenClaimWait(serviceB, 1_500);
      const bank = new StudyContentBankService(prisma as never);
      try {
        await recordCorrectCacheAttempt(prisma, fixture.userId, cacheX);
        await recordCorrectCacheAttempt(prisma, secondUser.id, cacheY);
        const [generationA, generationB] = [
          serviceA.generatePlan(fixture.userId, fixture.planId),
          serviceB.generatePlan(secondUser.id, planB.id),
        ];
        await Promise.all([barrierA.candidateSelected, barrierB.candidateSelected]);
        barrierA.resume();
        barrierB.resume();
        await Promise.all([txA.updateReached, txB.updateReached]);

        const claimRows = await prisma.studyContentGenerationClaim.findMany({
          where: { signature: { in: [cacheX.signature, cacheY.signature] } },
          select: { signature: true, ownerToken: true },
        });
        expect(claimRows).toHaveLength(2);
        expect(claimRows.every((claim) => claim.ownerToken)).toBe(true);
        expect(new Set(claimRows.map((claim) => claim.ownerToken)).size).toBe(2);
        await Promise.all([
          bank.setActive(cacheX.cacheId, false, '并发锁环复现', fixture.adminId),
          bank.setActive(cacheY.cacheId, false, '并发锁环复现', fixture.adminId),
        ]);
        txA.resume();
        txB.resume();

        const [resultA, resultB] = await Promise.all([generationA, generationB]);
        expect(resultA.status).toBe('ACTIVE');
        expect(resultB.status).toBe('ACTIVE');
        expect(
          [aiA.generateForUser.mock.calls.length, aiB.generateForUser.mock.calls.length].sort(),
        ).toEqual([1, 2]);
        const [planAItems, planBItems, cachesAfter, claimsAfter] = await Promise.all([
          prisma.studyPlanItem.findMany({
            where: { planId: fixture.planId },
            select: { bookWordId: true, contentCacheId: true },
          }),
          prisma.studyPlanItem.findMany({
            where: { planId: planB.id },
            select: { bookWordId: true, contentCacheId: true },
          }),
          prisma.studyContentCache.findMany({
            where: { signature: { in: [cacheX.signature, cacheY.signature] } },
            orderBy: [{ signature: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, signature: true, isActive: true },
          }),
          prisma.studyContentGenerationClaim.findMany({
            where: { signature: { in: [cacheX.signature, cacheY.signature] } },
            select: { ownerToken: true },
          }),
        ]);
        for (const group of [cacheX, cacheY]) {
          const rows = cachesAfter.filter((cache) => cache.signature === group.signature);
          expect(rows).toHaveLength(2);
          expect(rows.filter((cache) => cache.isActive)).toHaveLength(1);
          expect(rows.filter((cache) => !cache.isActive)).toEqual([
            expect.objectContaining({ id: group.cacheId }),
          ]);
          const activeCacheId = rows.find((cache) => cache.isActive)!.id;
          expect(
            planAItems.find((item) => item.bookWordId === group.bookWordId)?.contentCacheId,
          ).toBe(activeCacheId);
          expect(
            planBItems.find((item) => item.bookWordId === group.bookWordId)?.contentCacheId,
          ).toBe(activeCacheId);
        }
        expect(claimsAfter).toHaveLength(0);
      } finally {
        barrierA.resume();
        barrierB.resume();
        txA.resume();
        txB.resume();
        await prisma.studyPlan.deleteMany({
          where: { userId: { in: [fixture.userId, secondUser.id] } },
        });
        await prisma.user.delete({ where: { id: secondUser.id } });
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('stops before plan persistence if a replacement claim loses its owner token', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID());
      const barrier = pauseAfterCandidateRead(prisma, fixture.cacheId);
      const providerStarted = deferred();
      const providerCanFinish = deferred();
      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
          providerStarted.resolve();
          await providerCanFinish.promise;
          return generatedModel('不得保存的替代材料').generateForUser({ prompt });
        }),
      };
      const service = createStudyService(barrier.client, ai as never);
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.candidateSelected;
        await bank.setActive(fixture.cacheId, false, '替代租约失效测试', fixture.adminId);
        barrier.resume();
        await providerStarted.promise;

        const claim = await prisma.studyContentGenerationClaim.findUniqueOrThrow({
          where: { signature: fixture.signature },
        });
        expect(claim.ownerToken).toBeTruthy();
        await prisma.studyContentGenerationClaim.update({
          where: { signature: fixture.signature },
          data: {
            ownerToken: 'successor-owner-token',
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        providerCanFinish.resolve();
        await expect(generation).rejects.toThrow('学习计划生成失败');

        const [plan, item, cache, successorClaim, replacementCount] = await Promise.all([
          prisma.studyPlan.findUniqueOrThrow({
            where: { id: fixture.planId },
            select: { status: true, generatedContent: true },
          }),
          prisma.studyPlanItem.findFirstOrThrow({
            where: { planId: fixture.planId },
            select: { contentCacheId: true, question: true },
          }),
          prisma.studyContentCache.findUniqueOrThrow({
            where: { id: fixture.cacheId },
            select: { isActive: true, hitCount: true },
          }),
          prisma.studyContentGenerationClaim.findUniqueOrThrow({
            where: { signature: fixture.signature },
            select: { ownerToken: true },
          }),
          prisma.studyContentCache.count({
            where: { id: { not: fixture.cacheId }, signature: fixture.signature },
          }),
        ]);
        expect(plan).toEqual({ status: 'FAILED', generatedContent: null });
        expect(item).toEqual({ contentCacheId: null, question: null });
        expect(cache).toEqual({ isActive: false, hitCount: 0 });
        expect(successorClaim.ownerToken).toBe('successor-owner-token');
        expect(replacementCount).toBe(0);
        expect(ai.generateForUser).toHaveBeenCalledTimes(1);
      } finally {
        barrier.resume();
        providerCanFinish.resolve();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('keeps the original six-minute total deadline when a replacement is needed', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID());
      const barrier = pauseAfterCandidateRead(prisma, fixture.cacheId);
      const ai = generatedModel('不应请求的替代材料');
      const actualNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');
      const service = createStudyService(barrier.client, ai, () => {
        nowSpy.mockReturnValue(actualNow + STUDY_GENERATION_TOTAL_TIMEOUT_MS + 60_000);
      });
      const bank = new StudyContentBankService(prisma as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.candidateSelected;
        await bank.setActive(fixture.cacheId, false, '全局预算边界测试', fixture.adminId);
        barrier.resume();
        await expect(generation).rejects.toThrow('学习计划生成失败');
        expect(ai.generateForUser).not.toHaveBeenCalled();
        expect(
          await prisma.studyContentGenerationClaim.count({
            where: { signature: fixture.signature },
          }),
        ).toBe(0);
      } finally {
        nowSpy.mockRestore();
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('keeps earlier local question repairs in the budget for replacement generation', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID(), 2);
      const reusedGroup = fixture.groups[1];
      const barrier = interceptCacheTransactionUpdate(prisma, reusedGroup.cacheId);
      const contentCalls: string[] = [];
      const repairOrdinals: number[] = [];
      const ai = {
        generateForUser: vi.fn(async ({ prompt, purpose }: { prompt: string; purpose: string }) => {
          if (purpose === 'study-plan-question-repair') {
            const ordinal = Number(prompt.match(/本次计划第 (\d+) 次局部修复/)?.[1]);
            repairOrdinals.push(ordinal);
            const wordId = prompt.match(/bookWordId=([^\s，]+)/)?.[1];
            const question = materialFor(wordId ?? '', 'steady', 'question fixture').questions[0];
            const isInvalidRepair = repairOrdinals.length > 1;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      questions: [
                        {
                          ...question,
                          bookWordId: wordId,
                          options: isInvalidRepair
                            ? ['稳定的', '稳定的', '沉重的', '柔软的']
                            : ['稳定的', '急促的', '沉重的', '柔软的'],
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }

          contentCalls.push(purpose);
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
                    groups: groups.map(({ index, words }) => {
                      const group = materialFor(words[0].id, words[0].word, '预算测试材料');
                      group.index = index;
                      group.questions[0].options = ['稳定的', '稳定的', '沉重的', '柔软的'];
                      return group;
                    }),
                  }),
                },
              },
            ],
          };
        }),
      };
      const service = createStudyService(barrier.client as PrismaClient, ai as never);
      const bank = new StudyContentBankService(prisma as never);
      try {
        await recordCorrectCacheAttempt(prisma, fixture.userId, fixture.groups[0]);
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await barrier.updateReached;
        await bank.setActive(reusedGroup.cacheId, false, '修复预算延续测试', fixture.adminId);
        barrier.resume();

        await expect(generation).rejects.toThrow('学习计划生成失败');
        expect(contentCalls).toEqual(['study-plan', 'study-plan']);
        expect(repairOrdinals).toEqual([1, 2, 3]);
        expect(ai.generateForUser).toHaveBeenCalledTimes(5);
        const [plan, cacheRows, items] = await Promise.all([
          prisma.studyPlan.findUniqueOrThrow({
            where: { id: fixture.planId },
            select: { status: true, generatedContent: true },
          }),
          prisma.studyContentCache.findMany({
            where: { signature: { in: fixture.groups.map((group) => group.signature) } },
            select: { isActive: true, hitCount: true },
          }),
          prisma.studyPlanItem.findMany({
            where: { planId: fixture.planId },
            select: { contentCacheId: true, question: true },
          }),
        ]);
        expect(plan).toEqual({ status: 'FAILED', generatedContent: null });
        expect(cacheRows.every((cache) => cache.hitCount === 0)).toBe(true);
        expect(items.every((item) => item.contentCacheId === null && item.question === null)).toBe(
          true,
        );
      } finally {
        barrier.resume();
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);

    it('caps replacement requests across repeated disabled-group conflicts', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const fixture = await seedFixture(prisma, randomUUID(), 4);
      const firstCandidate = pauseAfterCandidateRead(prisma, fixture.groups[0].cacheId);
      const providerStarted = Array.from({ length: 3 }, () => deferred());
      const providerCanFinish = Array.from({ length: 3 }, () => deferred());
      let providerCalls = 0;
      const ai = {
        generateForUser: vi.fn(async ({ prompt }: { prompt: string }) => {
          const callIndex = providerCalls++;
          if (callIndex < providerStarted.length) {
            providerStarted[callIndex].resolve();
            await providerCanFinish[callIndex].promise;
          }
          return generatedModel('有限替代材料').generateForUser({ prompt });
        }),
      };
      const bank = new StudyContentBankService(prisma as never);
      const service = createStudyService(firstCandidate.client, ai as never);
      try {
        const generation = service.generatePlan(fixture.userId, fixture.planId);
        await firstCandidate.candidateSelected;
        await bank.setActive(fixture.groups[0].cacheId, false, '累计替代预算测试', fixture.adminId);
        firstCandidate.resume();
        for (let index = 0; index < providerStarted.length; index += 1) {
          await providerStarted[index].promise;
          await bank.setActive(
            fixture.groups[index + 1].cacheId,
            false,
            '累计替代预算测试',
            fixture.adminId,
          );
          providerCanFinish[index].resolve();
        }
        await expect(generation).rejects.toThrow('公共材料在本次生成期间多次被停用');
        expect(ai.generateForUser).toHaveBeenCalledTimes(3);
        const [plan, caches, items] = await Promise.all([
          prisma.studyPlan.findUniqueOrThrow({
            where: { id: fixture.planId },
            select: { status: true, generatedContent: true },
          }),
          prisma.studyContentCache.findMany({
            where: { signature: { in: fixture.groups.map((group) => group.signature) } },
            select: { isActive: true, hitCount: true },
          }),
          prisma.studyPlanItem.findMany({
            where: { planId: fixture.planId },
            select: { contentCacheId: true, question: true },
          }),
        ]);
        expect(plan).toEqual({ status: 'FAILED', generatedContent: null });
        expect(caches.every((cache) => !cache.isActive && cache.hitCount === 0)).toBe(true);
        expect(items.every((item) => item.contentCacheId === null && item.question === null)).toBe(
          true,
        );
      } finally {
        firstCandidate.resume();
        providerCanFinish.forEach((gate) => gate.resolve());
        await cleanFixture(prisma, fixture);
        await prisma.$disconnect();
      }
    }, 60_000);
  },
);
