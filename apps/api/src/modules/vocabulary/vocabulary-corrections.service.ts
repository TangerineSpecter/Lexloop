import { DAILY_ENRICHMENT_BATCH, DAILY_ENRICHMENTS } from './daily-enrichment';
import { USAGE_CLARITY_BATCH, USAGE_CLARITY_CORRECTIONS } from './usage-clarity-corrections';
import { VERB_SENSE_BATCH, VERB_SENSE_CORRECTIONS } from './verb-sense-corrections';
import { EXISTING_POS_BATCH, EXISTING_POS_CORRECTIONS } from './existing-pos-corrections';
import { SUPPLEMENT_MEANINGS, SUPPLEMENT_MEANING_BATCH } from './supplement-meanings';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient, VocabularyWord } from '@prisma/client';
import {
  VOCABULARY_CORRECTION_BATCH as batchId,
  VOCABULARY_CORRECTION_SOURCE as sourceKey,
  VOCABULARY_CORRECTIONS as corrections,
} from './vocabulary-corrections.batch';

const fields = ['meaning', 'ukPhonetic', 'usPhonetic'] as const;
type Field = (typeof fields)[number];
type Snapshot = { id: string; normalized: string; text: string; updatedAt: string } & Record<
  Field,
  string | null
>;
const snapshot = (word: VocabularyWord): Snapshot => ({
  id: word.id,
  normalized: word.normalized,
  text: word.text,
  updatedAt: word.updatedAt.toISOString(),
  meaning: word.meaning,
  ukPhonetic: word.ukPhonetic,
  usPhonetic: word.usPhonetic,
});
type Action = {
  word: string;
  wordId?: string;
  reason: string;
  changes: Partial<Record<Field, string | null>>;
  current?: Snapshot;
  auditId?: string;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Correction = {
  word: string;
  meaning?: string;
  expectedMeaning?: string;
  ukPhonetic?: string;
  usPhonetic?: string;
  sourceKeys?: readonly string[];
};
export type CorrectionBatch = {
  batchId: string;
  sourceKey: string;
  corrections: readonly Correction[];
};
export const DEFAULT_CORRECTION_BATCH: CorrectionBatch = { batchId, sourceKey, corrections };
export const SUPPLEMENT_CORRECTION_BATCH: CorrectionBatch = {
  batchId: SUPPLEMENT_MEANING_BATCH,
  sourceKey,
  corrections: SUPPLEMENT_MEANINGS,
};
export const EXISTING_POS_CORRECTION_BATCH: CorrectionBatch = {
  batchId: EXISTING_POS_BATCH,
  sourceKey,
  corrections: EXISTING_POS_CORRECTIONS,
};
export const VERB_SENSE_CORRECTION_BATCH: CorrectionBatch = {
  batchId: VERB_SENSE_BATCH,
  sourceKey,
  corrections: VERB_SENSE_CORRECTIONS,
};
export const USAGE_CLARITY_CORRECTION_BATCH: CorrectionBatch = {
  batchId: USAGE_CLARITY_BATCH,
  sourceKey,
  corrections: USAGE_CLARITY_CORRECTIONS,
};
export const DAILY_ENRICHMENT_CORRECTION_BATCH: CorrectionBatch = {
  batchId: DAILY_ENRICHMENT_BATCH,
  sourceKey,
  corrections: DAILY_ENRICHMENTS,
};
export function correctionBatch(id?: string): CorrectionBatch {
  if (!id || id === DEFAULT_CORRECTION_BATCH.batchId) return DEFAULT_CORRECTION_BATCH;
  if (id === SUPPLEMENT_CORRECTION_BATCH.batchId) return SUPPLEMENT_CORRECTION_BATCH;
  if (id === EXISTING_POS_BATCH) return EXISTING_POS_CORRECTION_BATCH;
  if (id === VERB_SENSE_BATCH) return VERB_SENSE_CORRECTION_BATCH;
  if (id === USAGE_CLARITY_BATCH) return USAGE_CLARITY_CORRECTION_BATCH;
  if (id === DAILY_ENRICHMENT_BATCH) return DAILY_ENRICHMENT_CORRECTION_BATCH;
  throw new Error('Unknown vocabulary correction batch');
}

/** Operator-only, bounded source correction. Never runs during application bootstrap. */
export class VocabularyCorrectionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly batch: CorrectionBatch = DEFAULT_CORRECTION_BATCH,
  ) {}

  private async plan(tx: Prisma.TransactionClient, mode: 'apply' | 'restore') {
    const { batchId, sourceKey, corrections } = this.batch;
    const sourceKeys = [...new Set(corrections.flatMap((c) => c.sourceKeys ?? [sourceKey]))];
    const words = await tx.vocabularyWord.findMany({
      where: { normalized: { in: corrections.map((c) => c.word) } },
      include: {
        bookWords: {
          where: { book: { sourceKey: { in: sourceKeys }, kind: 'SYSTEM', ownerId: null } },
          select: { id: true, book: { select: { sourceKey: true } } },
        },
      },
    });
    const audits = await tx.vocabularyCorrectionAudit.findMany({
      where: { batchId },
      orderBy: { wordId: 'asc' },
    });
    const actions: Action[] = corrections.map((correction) => {
      const word = words.find((w) => w.normalized === correction.word);
      const base: Action = {
        word: correction.word,
        wordId: word?.id,
        changes: {},
        reason: 'missing-word',
        current: word ? snapshot(word) : undefined,
      };
      if (!word) return base;
      const audit = audits.find((a) => a.wordId === word.id);
      if (mode === 'restore') {
        if (!audit) return { ...base, reason: 'not-applied' };
        if (audit.state !== 'APPLIED')
          return { ...base, reason: 'already-restored', auditId: audit.id };
        const after = audit.after as unknown as Snapshot;
        // Compare only the audited columns in a fixed order; JSONB does not retain key order.
        if (
          !equal(snapshot(word), {
            id: after.id,
            normalized: after.normalized,
            text: after.text,
            updatedAt: after.updatedAt,
            meaning: after.meaning,
            ukPhonetic: after.ukPhonetic,
            usPhonetic: after.usPhonetic,
          })
        )
          return { ...base, reason: 'edited-after-apply', auditId: audit.id };
        const before = audit.before as unknown as Snapshot;
        const changes: Action['changes'] = {};
        for (const field of fields)
          if (before[field] !== after[field]) changes[field] = before[field];
        return { ...base, reason: 'ready', changes, auditId: audit.id };
      }
      if (audit)
        return {
          ...base,
          reason: audit.state === 'RESTORED' ? 'restored-do-not-reapply' : 'already-applied',
          auditId: audit.id,
        };
      if (
        word.text !== correction.word ||
        word.itemType !== 'WORD' ||
        !word.bookWords.some((link) =>
          (correction.sourceKeys ?? [sourceKey]).includes(link.book.sourceKey),
        )
      )
        return { ...base, reason: 'source-mismatch' };
      // No historical edit ledger exists. Any timestamp difference is conservatively protected,
      // including intentional clearing. Non-null placeholders are never treated as writable.
      if (word.createdAt.getTime() !== word.updatedAt.getTime())
        return { ...base, reason: 'edited-word' };
      const changes: Action['changes'] = {};
      if (correction.expectedMeaning !== undefined) {
        // Exact source replacement is opt-in per entry. Never broaden null-only batches.
        if (word.meaning !== correction.expectedMeaning)
          return { ...base, reason: 'original-meaning-mismatch' };
        if (correction.meaning !== undefined && correction.meaning !== word.meaning)
          changes.meaning = correction.meaning;
      } else {
        for (const field of fields)
          if (field in correction && word[field] === null) changes[field] = correction[field];
      }
      return {
        ...base,
        reason: Object.keys(changes).length ? 'ready' : 'no-empty-fields',
        changes,
      };
    });
    const evidence = {
      batchId,
      sourceKey,
      mode,
      actions,
      audits: audits.map((a) => ({
        id: a.id,
        wordId: a.wordId,
        state: a.state,
        before: a.before,
        after: a.after,
      })),
    };
    const token = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    return {
      batchId,
      sourceKey,
      mode,
      sourceKeys,
      token,
      actions,
      wordsToChange: actions.filter((a) => a.reason === 'ready').length,
      fieldsToChange: actions.reduce((n, a) => n + Object.keys(a.changes).length, 0),
    };
  }

  preview(mode: 'apply' | 'restore' = 'apply') {
    return this.prisma.$transaction((tx) => this.plan(tx, mode), {
      isolationLevel: 'RepeatableRead',
    });
  }

  async execute(mode: 'apply' | 'restore', token: string) {
    const { batchId, corrections } = this.batch;
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid preview token');
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${batchId}))`;
        // Lock existing target words before the final preview. Same-row editors wait or
        // cause a serialization failure. Membership rows are not locked: an unlink
        // after this snapshot can serialize after backfill, with both commits valid.
        await tx.$queryRaw`SELECT "id" FROM "VocabularyWord" WHERE "normalized" IN (${Prisma.join(corrections.map((c) => c.word))}) ORDER BY "id" FOR UPDATE`;
        const plan = await this.plan(tx, mode);
        if (plan.token !== token)
          throw new Error('Preview is stale; preview again before applying');
        let changedWords = 0,
          changedFields = 0;
        for (const action of plan.actions) {
          if (action.reason !== 'ready' || !action.wordId || !action.current) continue;
          const word = await tx.vocabularyWord.update({
            where: { id: action.wordId },
            data: action.changes,
          });
          if (mode === 'apply')
            await tx.vocabularyCorrectionAudit.create({
              data: { batchId, wordId: word.id, before: action.current, after: snapshot(word) },
            });
          else
            await tx.vocabularyCorrectionAudit.update({
              where: { id: action.auditId! },
              data: { state: 'RESTORED', restoredAt: new Date() },
            });
          changedWords++;
          changedFields += Object.keys(action.changes).length;
        }
        return { batchId, mode, changedWords, changedFields };
      },
      { isolationLevel: 'Serializable', timeout: 15000 },
    );
  }
}
