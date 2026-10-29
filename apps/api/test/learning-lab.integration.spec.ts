import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LabService } from '../src/modules/learning-lab/lab.service';
import { StudyService } from '../src/modules/study/study.service';
import { VocabularyService } from '../src/modules/vocabulary/vocabulary.service';
import { foundationGrammar } from '../src/modules/learning-lab/lab.rules';

// Opt-in only. Use a migrated disposable database; all records use fresh users.
describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)('notebook and lab database boundaries', () => {
  it('deduplicates concurrent captures, preserves original context/mastery, paginates, and avoids position reuse after deletion', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const user = await prisma.user.create({
      data: { email: `lab-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
    });
    const service = new VocabularyService(prisma as never);
    try {
      const item = {
        text: 'look forward to',
        type: 'PHRASE' as const,
        meaning: '期待',
        example: 'I look forward to our trip.',
        sourceType: 'TRAVEL',
        sourceScenario: '旅行场景',
      };
      const saved = await Promise.all(
        Array.from({ length: 8 }, () => service.savePersonalItem(user.id, item)),
      );
      const lab = new LabService(
        prisma as never,
        { selectedProvider: async () => ({ model: 'stub' }) } as never,
        { add: async () => ({}) } as never,
      );
      await expect(
        lab.create('other-user', 'READING', randomUUID(), [saved[0].id], 'B1'),
      ).rejects.toThrow();
      expect(new Set(saved.map((row) => row.id)).size).toBe(1);
      expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(1);
      const storyPhrase = await service.savePersonalItem(user.id, {
        text: 'miss the bus',
        type: 'PHRASE',
        meaning: '没赶上公交车',
        example: 'Tom misses the bus.',
        sourceType: 'READING',
        sourceScenario: '微故事 · 上班路上 · 第 1 段',
      });
      expect(storyPhrase).toMatchObject({
        text: 'miss the bus',
        meaning: '没赶上公交车',
        example: 'Tom misses the bus.',
        sourceScenario: '微故事 · 上班路上 · 第 1 段',
        addedToReview: true,
      });
      const savedStoryPhrase = await service.notebook(user.id, 1, 'miss the bus', 'READING');
      expect(savedStoryPhrase.items[0]).toMatchObject({
        text: 'miss the bus',
        meaning: '没赶上公交车',
        example: 'Tom misses the bus.',
        sourceType: 'READING',
        sourceScenario: '微故事 · 上班路上 · 第 1 段',
        state: 'REVIEWING',
      });
      expect(
        await prisma.userWordProgress.findUnique({
          where: { userId_bookWordId: { userId: user.id, bookWordId: storyPhrase.id } },
        }),
      ).toMatchObject({ state: 'REVIEWING' });
      await service.markMastered(user.id, saved[0].id);
      await service.savePersonalItem(user.id, {
        ...item,
        text: 'Look   forward to',
        sourceType: 'READING',
        example: 'Replacement context.',
      });
      const first = await service.notebook(user.id, 1, 'look forward to', undefined);
      expect(first.items[0]).toMatchObject({
        text: 'Look forward to',
        sourceType: 'TRAVEL',
        example: item.example,
        state: 'MASTERED',
      });
      for (const text of ['river', 'forest', 'station'])
        await service.savePersonalItem(user.id, {
          ...item,
          text,
          type: 'WORD',
          sourceType: 'MANUAL',
        });
      const river = (await service.notebook(user.id, 1, 'river')).items[0];
      const plan = await prisma.studyPlan.create({
        data: {
          userId: user.id,
          items: {
            create: { bookWordId: river.id, source: 'NEW', groupIndex: 0 },
          },
        },
      });
      await service.removePersonalItem(user.id, river.id);
      expect(await prisma.vocabularyBookWord.findUnique({ where: { id: river.id } })).toMatchObject(
        { isCollected: false },
      );
      expect(
        await prisma.userWordProgress.findUnique({
          where: { userId_bookWordId: { userId: user.id, bookWordId: river.id } },
        }),
      ).not.toBeNull();
      expect((await service.notebook(user.id, 1, 'river')).items).toEqual([]);
      expect(await prisma.studyPlanItem.count({ where: { planId: plan.id } })).toBe(1);
      await service.savePersonalItem(user.id, {
        ...item,
        text: 'ticket',
        type: 'WORD',
        sourceType: 'MANUAL',
      });
      expect((await service.notebook(user.id, 1, '', 'MANUAL')).total).toBe(3);
      const restored = await service.savePersonalItem(user.id, {
        ...item,
        text: 'river',
        type: 'WORD',
        sourceType: 'READING',
      });
      expect(restored.id).toBe(river.id);
      expect((await service.notebook(user.id, 1, 'river')).items[0]).toMatchObject({
        sourceType: 'MANUAL',
        state: 'REVIEWING',
      });
      await expect(service.removePersonalItem('other-user', saved[0].id)).rejects.toThrow();
      expect((await service.notebook('other-user', 1, '')).items).toEqual([]);
    } finally {
      const words = await prisma.vocabularyBookWord.findMany({
        where: { book: { ownerId: user.id } },
        select: { wordId: true },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.vocabularyWord.deleteMany({
        where: { id: { in: words.map((row) => row.wordId) }, bookWords: { none: {} } },
      });
      await prisma.$disconnect();
    }
  }, 30_000);

  it('imports personal vocabulary atomically, idempotently, and only within each account', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const user = await prisma.user.create({
      data: { email: `import-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
    });
    const otherUser = await prisma.user.create({
      data: { email: `import-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
    });
    const service = new VocabularyService(prisma as never);
    const suffix = randomUUID().replaceAll('-', '');
    const triggerName = `lexloop_import_fail_${suffix}`;
    const functionName = `lexloop_import_fail_fn_${suffix}`;
    let functionCreated = false;
    let triggerCreated = false;
    try {
      const first = await service.importPersonalItems(user.id, [
        { text: 'Look forward to', meaning: '期待', example: 'I look forward to Sunday.' },
        { text: 'notice', meaning: '注意到' },
        { text: 'look   forward   to', meaning: '期待', example: 'I look forward to Sunday.' },
      ]);
      expect(first).toEqual({ imported: 2, restored: 0, duplicates: 1 });
      const firstPage = await service.notebook(user.id, 1, 'look forward to');
      const phrase = firstPage.items[0];
      expect(phrase).toMatchObject({
        text: 'Look forward to',
        meaning: '期待',
        example: 'I look forward to Sunday.',
        sourceType: 'MANUAL',
        state: 'REVIEWING',
      });
      const importedNotice = (await service.notebook(user.id, 1, 'notice')).items[0];
      const dashboardAfterImport = await service.getDashboardWords(user.id);
      expect(dashboardAfterImport.reviewWords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: phrase.id, word: 'Look forward to', meaning: '期待' }),
          expect.objectContaining({ id: importedNotice.id, word: 'notice', meaning: '注意到' }),
        ]),
      );

      await expect(
        service.importPersonalItems(user.id, [
          { text: 'context phrase', meaning: '语境甲', example: 'We discussed it in class.' },
          { text: 'CONTEXT   PHRASE', meaning: '语境甲', example: 'We used it at work.' },
        ]),
      ).rejects.toThrow(/第 1、2 项.*释义或例句不同/);
      expect(
        await prisma.vocabularyWord.count({
          where: { normalized: `personal:${user.id}:context phrase` },
        }),
      ).toBe(0);
      await expect(
        service.importPersonalItems(user.id, [
          { text: 'sense collision', meaning: '注意到', example: 'I noticed the sign.' },
          { text: 'SENSE COLLISION', meaning: '通知', example: 'I noticed the sign.' },
        ]),
      ).rejects.toThrow(/第 1、2 项.*释义或例句不同/);
      expect(
        await prisma.vocabularyWord.count({
          where: { normalized: `personal:${user.id}:sense collision` },
        }),
      ).toBe(0);

      await service.markMastered(user.id, phrase.id);
      expect(
        await service.importPersonalItems(user.id, [
          { text: 'LOOK FORWARD TO', meaning: '不能覆盖原词义', example: 'Replacement.' },
        ]),
      ).toEqual({ imported: 0, restored: 0, duplicates: 1 });
      await service.removePersonalItem(user.id, phrase.id);
      expect(
        await service.importPersonalItems(user.id, [
          { text: 'look forward to', meaning: '重导入释义' },
        ]),
      ).toEqual({ imported: 0, restored: 1, duplicates: 0 });
      expect((await service.notebook(user.id, 1, 'look forward to')).items[0]).toMatchObject({
        meaning: '期待',
        example: 'I look forward to Sunday.',
        state: 'MASTERED',
      });
      const dashboardAfterRestore = await service.getDashboardWords(user.id);
      expect(dashboardAfterRestore.reviewWords).toEqual([
        expect.objectContaining({ id: importedNotice.id, word: 'notice', meaning: '注意到' }),
      ]);
      const reviewPlan = await new StudyService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
      ).createPlan(user.id, 0, 'group', 1);
      expect(reviewPlan.words).toEqual([
        expect.objectContaining({
          id: importedNotice.id,
          word: 'notice',
          meaning: '注意到',
          source: 'REVIEW',
        }),
      ]);

      const otherImport = await service.importPersonalItems(otherUser.id, [
        { text: 'look forward to', meaning: '另一个账号的释义' },
      ]);
      expect(otherImport.imported).toBe(1);
      const otherPhrase = (await service.notebook(otherUser.id, 1, 'look forward to')).items[0];
      expect(otherPhrase.id).not.toBe(phrase.id);
      expect(otherPhrase.meaning).toBe('另一个账号的释义');
      expect((await service.notebook(user.id, 1, 'look forward to')).items[0].meaning).toBe('期待');
      await expect(service.removePersonalItem(otherUser.id, phrase.id)).rejects.toThrow();

      await expect(
        service.importPersonalItems(user.id, [
          { text: 'valid before invalid', meaning: 'temporary' },
          { text: 'bad row', meaning: ' '.repeat(501) },
        ]),
      ).rejects.toThrow();
      expect((await service.notebook(user.id, 1, 'valid before invalid')).total).toBe(0);

      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION public."${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."contextMeaning" = '__test_force_failure__' THEN
            RAISE EXCEPTION 'intentional isolated import rollback test';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      functionCreated = true;
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "VocabularyBookWord"
        FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
      `);
      triggerCreated = true;
      await expect(
        service.importPersonalItems(user.id, [
          { text: 'rollback first row', meaning: 'must not remain' },
          { text: 'rollback second row', meaning: '__test_force_failure__' },
        ]),
      ).rejects.toThrow(/intentional isolated import rollback test/);
      expect((await service.notebook(user.id, 1, 'rollback first row')).total).toBe(0);
      expect(
        await prisma.vocabularyWord.count({
          where: { normalized: `personal:${user.id}:rollback first row` },
        }),
      ).toBe(0);
    } finally {
      if (triggerCreated) {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON "VocabularyBookWord"`,
        );
      }
      if (functionCreated) {
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
      }
      const words = await prisma.vocabularyBookWord.findMany({
        where: { book: { ownerId: { in: [user.id, otherUser.id] } } },
        select: { wordId: true },
      });
      await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
      await prisma.vocabularyWord.deleteMany({
        where: { id: { in: words.map((row) => row.wordId) }, bookWords: { none: {} } },
      });
      await prisma.$disconnect();
    }
  }, 30_000);

  it('serializes concurrent same-user batch imports and bounds a forty-row request', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const user = await prisma.user.create({
      data: { email: `import-batch-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
    });
    const service = new VocabularyService(prisma as never);
    try {
      const batch = Array.from({ length: 40 }, (_, index) => ({
        text: `bounded import word ${index + 1}`,
        meaning: `释义 ${index + 1}`,
      }));
      const startedAt = performance.now();
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => service.importPersonalItems(user.id, batch)),
      );
      const elapsedMs = performance.now() - startedAt;
      expect(responses.reduce((sum, result) => sum + result.imported, 0)).toBe(40);
      expect(responses.reduce((sum, result) => sum + result.duplicates, 0)).toBe(120);
      expect(await prisma.userWordProgress.count({ where: { userId: user.id } })).toBe(40);
      expect(elapsedMs).toBeLessThan(10_000);
      console.log(
        `isolated PostgreSQL: 4 concurrent imports of 40 rows settled in ${elapsedMs.toFixed(1)} ms`,
      );
    } finally {
      const words = await prisma.vocabularyBookWord.findMany({
        where: { book: { ownerId: user.id } },
        select: { wordId: true },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.vocabularyWord.deleteMany({
        where: { id: { in: words.map((row) => row.wordId) }, bookWords: { none: {} } },
      });
      await prisma.$disconnect();
    }
  }, 30_000);

  it('creates one lesson on request replay, grades once, persists weak evidence, and rejects cross-user or stale worker writes', async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
    });
    const user = await prisma.user.create({
      data: { email: `lab-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
    });
    const provider = {
      provider: 'OPENAI_COMPATIBLE',
      model: 'stub',
      baseUrl: 'http://127.0.0.1',
      apiKey: 'test-only',
    };
    const models = { selectedProvider: vi.fn().mockResolvedValue(provider) };
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const service = new LabService(prisma as never, models as never, queue as never);
    try {
      const idempotency = randomUUID();
      const foundations = await Promise.all(
        Array.from({ length: 6 }, () => service.create(user.id, 'GRAMMAR', idempotency, [], 'B1')),
      );
      expect(new Set(foundations.map((row) => row.id)).size).toBe(1);
      expect(queue.add).not.toHaveBeenCalled();
      const id = foundations[0].id;
      expect(foundations[0].content!.questions[0]).not.toHaveProperty('correctIndex');
      await expect(service.detail('other-user', id)).rejects.toThrow();
      const correct = foundationGrammar().questions.map((row) => row.correctIndex!);
      const answers = [0, ...correct.slice(1)];
      await Promise.all(Array.from({ length: 6 }, () => service.submit(user.id, id, answers)));
      expect(
        await prisma.learningEvent.count({ where: { userId: user.id, type: 'GRAMMAR_COMPLETED' } }),
      ).toBe(1);
      const result = await service.detail(user.id, id);
      expect(result.score).toBe(83);
      expect(result.content!.questions[0].correctIndex).toBe(1);
      await expect(service.submit(user.id, id, correct)).rejects.toThrow();
      const evidence = await service.grammarEvidence(user.id);
      expect(evidence[0]).toMatchObject({ id: `drill-${id}-q1`, corrected: 'met' });
      const next = await service.create(user.id, 'GRAMMAR', randomUUID(), [], 'B1');
      const token = queue.add.mock.calls[0][1].workerToken;
      expect(Object.keys(queue.add.mock.calls[0][1]).sort()).toEqual([
        'submissionId',
        'workerToken',
      ]);
      const claim = await service.claim(next.id, token);
      expect(claim.provider?.apiKey).toBe('test-only');
      const duplicate = await service.claim(next.id, token);
      expect(duplicate.waitUntil).toBeGreaterThan(Date.now());
      expect(duplicate).not.toHaveProperty('provider');
      await expect(
        service.complete(next.id, token, 'stale-lease', foundationGrammar()),
      ).rejects.toThrow();
      await service.complete(next.id, token, claim.leaseToken!, foundationGrammar());
      await service.complete(next.id, token, 'replayed', {});
      expect((await service.detail(user.id, next.id)).status).toBe('READY');
      const pending = await service.create(user.id, 'GRAMMAR', randomUUID(), [], 'B1');
      const pendingToken = queue.add.mock.calls[1][1].workerToken;
      const pendingClaim = await service.claim(pending.id, pendingToken);
      const cleared = await new VocabularyService(prisma as never).clearLearningRecords(user.id);
      expect(cleared.cleared.labLessons).toBe(3);
      expect(await prisma.labLesson.count({ where: { userId: user.id } })).toBe(0);
      await expect(
        service.complete(pending.id, pendingToken, pendingClaim.leaseToken!, foundationGrammar()),
      ).rejects.toThrow();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    }
  }, 30_000);
  it.each(['READING', 'GRAMMAR'] as const)(
    'rejects a %s snapshot captured before learning records are cleared',
    async (kind) => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      const user = await prisma.user.create({
        data: { email: `lab-clear-${randomUUID()}@example.invalid`, passwordHash: 'fixture' },
      });
      let release!: () => void;
      let entered!: () => void;
      const reachedProvider = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const providerGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const models = {
        selectedProvider: vi.fn(async () => {
          entered();
          await providerGate;
          return {
            provider: 'OPENAI_COMPATIBLE',
            model: 'stub',
            baseUrl: 'http://127.0.0.1',
            apiKey: 'test-only',
          };
        }),
      };
      const queue = { add: vi.fn().mockResolvedValue({}) };
      const service = new LabService(prisma as never, models as never, queue as never);
      const vocabulary = new VocabularyService(prisma as never);
      let pending: Promise<unknown> | undefined;
      try {
        let wordIds: string[] = [];
        if (kind === 'READING') {
          const word = await vocabulary.savePersonalItem(user.id, {
            text: 'forest',
            type: 'WORD',
            meaning: '森林',
            example: 'We walked through the forest.',
          });
          wordIds = [word.id];
        } else {
          const base = await service.create(user.id, 'GRAMMAR', randomUUID(), [], 'B1');
          const answers = foundationGrammar().questions.map((question) => question.correctIndex!);
          answers[0] = 0;
          await service.submit(user.id, base.id, answers);
        }
        // Pause after source snapshots have been read, before the creation transaction.
        pending = service.create(user.id, kind, randomUUID(), wordIds, 'B1');
        const rejected = expect(pending).rejects.toThrow('学习记录已清理');
        await reachedProvider;
        await vocabulary.clearLearningRecords(user.id);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).learningRecordsVersion,
        ).toBe(1);
        release();
        await rejected;
        expect(await prisma.labLesson.count({ where: { userId: user.id } })).toBe(0);
        expect((await service.grammarEvidence(user.id)).length).toBe(0);
        expect(queue.add).not.toHaveBeenCalled();
        // A new request after clearing remains usable.
        const fresh = await service.create(user.id, 'GRAMMAR', randomUUID(), [], 'B1');
        expect(fresh.status).toBe('READY');
        expect(fresh.evidence).toEqual([]);
      } finally {
        release();
        await pending?.catch(() => undefined);
        await prisma.user.delete({ where: { id: user.id } });
        await prisma.$disconnect();
      }
    },
    15_000,
  );
});
