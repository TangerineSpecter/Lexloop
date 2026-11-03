import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudyCompletionRepair } from '../src/modules/study/study-completion-repair';
import { StudyService } from '../src/modules/study/study.service';
import { MistakesService } from '../src/modules/mistakes/mistakes.service';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'controlled historical completion repair on PostgreSQL',
  () => {
    it.each(['NORMAL', 'PROGRESSIVE'] as const)(
      'previews and repairs %s metadata once without altering attempts, weaknesses or SRS',
      async (purpose) => {
        const f = await fixture(purpose);
        try {
          const before = await f.evidence();
          const original = await f.db.studyPlan.findUnique({ where: { id: f.plan.id } });
          const preview = await f.repair.preview(f.plan.id);
          expect(preview.classification).toBe('ELIGIBLE');
          expect(JSON.stringify(preview)).not.toContain('Fixture private answer');
          expect(await f.evidence()).toEqual(before);
          expect(await f.db.studyPlan.findUnique({ where: { id: f.plan.id } })).toEqual(original);
          const results = await Promise.all([
            f.repair.apply(preview),
            new StudyCompletionRepair(f.other).apply(preview),
          ]);
          expect(results.map((result) => result.status).sort()).toEqual([
            'ALREADY_APPLIED',
            'APPLIED',
          ]);
          expect(await f.db.studyPlanCompletionRepair.count({ where: { planId: f.plan.id } })).toBe(
            1,
          );
          expect(await f.evidence()).toEqual(before);
          expect(await f.db.studyPlan.findUnique({ where: { id: f.plan.id } })).toMatchObject({
            status: 'COMPLETED',
            completedAt: new Date(preview.proposed!.completedAt),
          });
          expect((await f.repair.apply(preview)).status).toBe('ALREADY_APPLIED');
          if (purpose === 'PROGRESSIVE')
            expect(
              await f.db.progressivePracticeProgress.findFirst({ where: { userId: f.user.id } }),
            ).toMatchObject({ highestUnlockedStage: 'CONTEXT' });
          expect((await f.repair.preview(f.plan.id)).classification).toBe('NOT_APPLICABLE');
        } finally {
          await f.cleanup();
        }
      },
    );

    it.each([
      'partial',
      'duplicate',
      'foreign-attempt',
      'missing-attempt',
      'deleted-item',
      'missing-progress',
      'empty-material',
      'future-time',
      'old-stage',
      'wrong-type',
      'outside-options',
    ] as const)('leaves %s evidence for continued study or manual review', async (mode) => {
      const f = await fixture(mode === 'old-stage' ? 'PROGRESSIVE' : 'NORMAL');
      try {
        const first = f.items[0];
        if (mode === 'partial')
          await f.db.studyPlanItem.update({ where: { id: first.id }, data: { completedAt: null } });
        if (mode === 'duplicate')
          await f.db.wordReviewAttempt.create({
            data: {
              userId: f.user.id,
              bookWordId: first.bookWordId,
              planItemId: first.id,
              isCorrect: true,
              selectedAnswer: ['Fixture private answer'],
            },
          });
        if (mode === 'foreign-attempt')
          await f.db.wordReviewAttempt.updateMany({
            where: { planItemId: first.id },
            data: { userId: 'different-fixture-user' },
          });
        if (mode === 'missing-attempt')
          await f.db.wordReviewAttempt.deleteMany({ where: { planItemId: first.id } });
        if (mode === 'deleted-item') await f.db.studyPlanItem.delete({ where: { id: first.id } });
        if (mode === 'missing-progress')
          await f.db.userWordProgress.deleteMany({ where: { userId: f.user.id } });
        if (mode === 'empty-material')
          await f.db.studyPlan.update({
            where: { id: f.plan.id },
            data: { generatedContent: { groups: [null, null] } },
          });
        if (mode === 'future-time')
          await f.db.studyPlanItem.update({
            where: { id: first.id },
            data: { completedAt: new Date(Date.now() + 60_000) },
          });
        if (mode === 'wrong-type')
          await f.db.wordReviewAttempt.updateMany({
            where: { planItemId: first.id },
            data: { questionType: 'WORD_MATCHING' },
          });
        if (mode === 'outside-options')
          await f.db.wordReviewAttempt.updateMany({
            where: { planItemId: first.id },
            data: { selectedAnswer: ['not an option'] },
          });
        if (mode === 'old-stage')
          await f.db.studyPlan.update({
            where: { id: f.plan.id },
            data: { progressiveVersion: 0 },
          });
        const before = await f.evidence();
        const preview = await f.repair.preview(f.plan.id);
        expect(preview.classification).toBe(
          mode === 'partial' ? 'NOT_APPLICABLE' : 'MANUAL_REVIEW',
        );
        await expect(f.repair.apply(preview)).rejects.toThrow('eligible preview');
        expect(await f.evidence()).toEqual(before);
        expect(await f.db.studyPlanCompletionRepair.count({ where: { planId: f.plan.id } })).toBe(
          0,
        );
        expect(await f.db.studyPlan.findUnique({ where: { id: f.plan.id } })).toMatchObject({
          status: 'ACTIVE',
        });
      } finally {
        await f.cleanup();
      }
    });

    it('accepts transaction-start attempt timestamps without regrading an incorrect answer', async () => {
      const f = await fixture('NORMAL');
      try {
        // PostgreSQL-default timestamps may precede the application completion
        // timestamp within the same transaction; neither is a grading signal.
        await f.db.wordReviewAttempt.updateMany({
          where: { planItemId: { in: f.items.map((item) => item.id) } },
          data: { createdAt: new Date(f.plan.generatedAt!.getTime() + 1000) },
        });
        const preview = await f.repair.preview(f.plan.id);
        expect(preview.classification).toBe('ELIGIBLE');
        const before = await f.evidence();
        await f.repair.apply(preview);
        expect(await f.evidence()).toEqual(before);
        expect(before.attempts.every((attempt) => !attempt.isCorrect)).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it('runs the explicit preview/apply CLI against the isolated database and protects its manifest', async () => {
      execFileSync('./node_modules/.bin/nest', ['build'], { stdio: 'pipe' });
      const f = await fixture('NORMAL');
      const directory = mkdtempSync(join(tmpdir(), 'study-repair-cli-'));
      const manifest = join(directory, 'preview.json');
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          [resolve('../../scripts/repair-study-completion.mjs'), ...args],
          {
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              LAB_TEST_DATABASE_URL: process.env.LAB_TEST_DATABASE_URL,
            },
          },
        );
      try {
        const before = await f.evidence();
        const preview = run([
          'preview',
          '--database-url-env',
          'LAB_TEST_DATABASE_URL',
          '--plan-id',
          f.plan.id,
          '--out',
          manifest,
        ]);
        expect(preview.status).toBe(0);
        expect(JSON.parse(readFileSync(manifest, 'utf8')).classification).toBe('ELIGIBLE');
        expect(statSync(manifest).mode & 0o777).toBe(0o600);
        expect(
          run([
            'preview',
            '--database-url-env',
            'LAB_TEST_DATABASE_URL',
            '--plan-id',
            f.plan.id,
            '--out',
            manifest,
          ]).status,
        ).toBe(1);
        expect(
          run(['apply', '--database-url-env', 'LAB_TEST_DATABASE_URL', '--manifest', manifest])
            .status,
        ).toBe(1);
        const args = [
          'apply',
          '--database-url-env',
          'LAB_TEST_DATABASE_URL',
          '--manifest',
          manifest,
          '--confirm',
          'REPAIR_COMPLETION_METADATA',
        ];
        expect(JSON.parse(run(args).stdout).status).toBe('APPLIED');
        expect(JSON.parse(run(args).stdout).status).toBe('ALREADY_APPLIED');
        expect(await f.evidence()).toEqual(before);
      } finally {
        rmSync(directory, { recursive: true, force: true });
        await f.cleanup();
      }
    }, 30_000);

    it('rejects a stale preview after a concurrent edit wins the plan lock', async () => {
      const f = await fixture('NORMAL');
      const held = gate(),
        release = gate();
      let writer: Promise<unknown> | undefined;
      try {
        const preview = await f.repair.preview(f.plan.id);
        writer = f.other.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "StudyPlan" WHERE "id" = ${f.plan.id} FOR UPDATE`;
          await tx.studyPlanItem.update({
            where: { id: f.items[0].id },
            data: { completedAt: null },
          });
          held.resolve();
          await release.promise;
        });
        await held.promise;
        const pending = f.repair.apply(preview);
        const assertion = expect(pending).rejects.toThrow('stale');
        release.resolve();
        await writer;
        await assertion;
        expect(await f.db.studyPlanCompletionRepair.count({ where: { planId: f.plan.id } })).toBe(
          0,
        );
      } finally {
        release.resolve();
        await writer;
        await f.cleanup();
      }
    });

    it('rolls back plan and path changes when the durable receipt fails, then safely retries', async () => {
      const f = await fixture('PROGRESSIVE');
      const name = `completion_fault_${randomUUID().replaceAll('-', '')}`;
      try {
        const preview = await f.repair.preview(f.plan.id);
        const before = await f.evidence();
        await f.db.$executeRawUnsafe(
          `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."planId" = '${f.plan.id}' THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$`,
        );
        await f.db.$executeRawUnsafe(
          `CREATE TRIGGER "${name}" BEFORE INSERT ON "StudyPlanCompletionRepair" FOR EACH ROW EXECUTE FUNCTION "${name}"()`,
        );
        await expect(f.repair.apply(preview)).rejects.toThrow();
        expect(await f.db.studyPlan.findUnique({ where: { id: f.plan.id } })).toMatchObject({
          status: 'ACTIVE',
          completedAt: null,
        });
        expect(
          await f.db.progressivePracticeProgress.findFirst({ where: { userId: f.user.id } }),
        ).toMatchObject({ highestUnlockedStage: 'FOUNDATION' });
        expect(await f.evidence()).toEqual(before);
        await f.db.$executeRawUnsafe(`DROP TRIGGER "${name}" ON "StudyPlanCompletionRepair"`);
        expect((await f.repair.apply(preview)).status).toBe('APPLIED');
      } finally {
        await f.db.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS "${name}" ON "StudyPlanCompletionRepair"`,
        );
        await f.db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
        await f.cleanup();
      }
    });
  },
);

async function fixture(purpose: 'NORMAL' | 'PROGRESSIVE') {
  const db = new PrismaClient({ datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } } });
  const other = new PrismaClient({
    datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
  });
  const id = randomUUID();
  const user = await db.user.create({
    data: { email: `completion-${id}@example.invalid`, passwordHash: 'fixture' },
  });
  const book = await db.vocabularyBook.create({
    data: {
      ownerId: user.id,
      kind: 'PERSONAL',
      sourceKey: id,
      title: 'Completion fixture',
      sourcePath: 'fixture',
      category: 'GENERAL',
    },
  });
  const wordIds: string[] = [],
    bookIds: string[] = [];
  for (const [position, text] of ['help', 'repair'].entries()) {
    const word = await db.vocabularyWord.create({
      data: { normalized: `${id}-${text}`, text, meaning: 'v. 帮助' },
    });
    wordIds.push(word.id);
    const bw = await db.vocabularyBookWord.create({
      data: { bookId: book.id, wordId: word.id, position },
    });
    bookIds.push(bw.id);
    await db.userWordProgress.create({
      data: {
        userId: user.id,
        bookWordId: bw.id,
        totalAttempts: 0,
        state: 'REVIEWING',
        nextReviewAt: new Date('2030-01-01'),
      },
    });
  }
  if (purpose === 'PROGRESSIVE')
    await db.progressivePracticeProgress.create({
      data: { userId: user.id, trackVersion: 1, highestUnlockedStage: 'FOUNDATION' },
    });
  const generatedAt = new Date(Date.now() - 10000),
    startedAt = new Date(Date.now() - 8000);
  const questions = bookIds.map((bookWordId) => ({
    bookWordId,
    type: 'MEANING_RECOGNITION',
    prompt: 'Fixture question',
    options: ['Fixture private answer', 'other'],
    correctAnswers: ['other'],
  }));
  const plan = await db.studyPlan.create({
    data: {
      userId: user.id,
      purpose,
      ...(purpose === 'PROGRESSIVE'
        ? { progressiveVersion: 1, progressiveStage: 'FOUNDATION' }
        : {}),
      status: 'ACTIVE',
      generatedAt,
      startedAt,
      generatedContent: { groups: questions.map((q, index) => ({ index, questions: [q] })) },
      items: {
        create: questions.map((q, index) => ({
          bookWordId: q.bookWordId,
          source: 'REVIEW',
          groupIndex: index,
          question: q,
          completedAt: null,
        })),
      },
    },
    include: { items: { orderBy: { groupIndex: 'asc' } } },
  });
  const study = new StudyService(
    db as never,
    {} as never,
    {} as never,
    new MistakesService({} as never),
  );
  for (const item of plan.items)
    await study.completeGroup(user.id, plan.id, item.groupIndex, [
      { bookWordId: item.bookWordId, selectedAnswer: ['Fixture private answer'] },
    ]);
  // Emulate only the historical lost-finalization metadata after real submit/SRS writes.
  await db.studyPlan.update({
    where: { id: plan.id },
    data: { status: 'ACTIVE', completedAt: null },
  });
  if (purpose === 'PROGRESSIVE')
    await db.progressivePracticeProgress.updateMany({
      where: { userId: user.id },
      data: { highestUnlockedStage: 'FOUNDATION' },
    });
  return {
    db,
    other,
    user,
    plan,
    items: plan.items,
    repair: new StudyCompletionRepair(db),
    evidence: async () => ({
      attempts: await db.wordReviewAttempt.findMany({
        where: { planItemId: { in: plan.items.map((i) => i.id) } },
        orderBy: { id: 'asc' },
      }),
      progress: await db.userWordProgress.findMany({
        where: { userId: user.id },
        orderBy: { id: 'asc' },
      }),
      weaknesses: await db.weaknessSignal.findMany({
        where: { userId: user.id },
        orderBy: { id: 'asc' },
      }),
    }),
    cleanup: async () => {
      await db.user.delete({ where: { id: user.id } });
      await db.vocabularyWord.deleteMany({ where: { id: { in: wordIds } } });
      await Promise.all([db.$disconnect(), other.$disconnect()]);
    },
  };
}
