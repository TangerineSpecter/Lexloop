import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

export const STUDY_CONTENT_CLAIM_LEASE_MS = 45_000;
export const STUDY_CONTENT_CLAIM_HEARTBEAT_MS = 15_000;
export const STUDY_CONTENT_CLAIM_WAIT_MS = 100_000;
export const STUDY_CONTENT_CLAIM_POLL_MS = 500;
export const STUDY_CONTENT_CLAIM_FAILURE_COOLDOWN_MS = 15_000;

const STALE_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;
const SAFE_FAILURE_CODES = new Set([
  'STUDY_CACHE_PROVIDER_FAILED',
  'STUDY_CACHE_VALIDATION_FAILED',
  'STUDY_CACHE_PROVIDER_TIMEOUT',
  'STUDY_CACHE_CLAIM_LOST',
]);

export type StudyContentClaimStatus = 'READY' | 'BUSY' | 'COOLDOWN' | 'EXPIRED';

let lastPruneAttemptAt = 0;

export function studyContentClaimWaitDeadline(
  generationDeadline: number,
  now: number,
  maxWaitMs = STUDY_CONTENT_CLAIM_WAIT_MS,
) {
  return Math.min(generationDeadline, now + maxWaitMs);
}

export async function tryClaimStudyContentSignature(
  prisma: PrismaService,
  signature: string,
  ownerToken: string,
  now = new Date(),
  requestStartedAt = now,
) {
  return tryClaimStudyContentSignatures(prisma, [signature], ownerToken, now, requestStartedAt);
}

/**
 * Acquire a sorted set as one unit so a plan cannot hold-and-wait on cache keys.
 * A post-failure explicit retry may proceed; requests already waiting when the
 * failure was recorded remain in the short cooldown to avoid a retry wave.
 */
export async function tryClaimStudyContentSignatures(
  prisma: PrismaService,
  signatures: string[],
  ownerToken: string,
  now = new Date(),
  requestStartedAt = now,
) {
  const orderedSignatures = [...new Set(signatures)].sort();
  if (!orderedSignatures.length) return true;
  await pruneExpiredStudyContentClaims(prisma, now);
  const leaseExpiresAt = new Date(now.getTime() + STUDY_CONTENT_CLAIM_LEASE_MS);
  return prisma.$transaction(
    async (tx) => {
      const values = orderedSignatures.map(
        (signature) =>
          Prisma.sql`(${signature}, ${ownerToken}, ${leaseExpiresAt}, NULL, NULL, ${now}, ${now})`,
      );
      const claimed = await tx.$queryRaw<Array<{ signature: string }>>(Prisma.sql`
      INSERT INTO "public"."StudyContentGenerationClaim"
        ("signature", "ownerToken", "leaseExpiresAt", "retryAfter", "lastFailureCode", "createdAt", "updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("signature") DO UPDATE
        SET "ownerToken" = EXCLUDED."ownerToken",
            "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
            "retryAfter" = NULL,
            "lastFailureCode" = NULL,
            "updatedAt" = EXCLUDED."updatedAt"
        WHERE (
          "StudyContentGenerationClaim"."ownerToken" IS NOT NULL
          AND (
            "StudyContentGenerationClaim"."leaseExpiresAt" IS NULL
            OR "StudyContentGenerationClaim"."leaseExpiresAt" <= ${now}
          )
        ) OR (
          "StudyContentGenerationClaim"."ownerToken" IS NULL
          AND (
            "StudyContentGenerationClaim"."retryAfter" IS NULL
          OR "StudyContentGenerationClaim"."retryAfter" <= ${now}
          OR "StudyContentGenerationClaim"."updatedAt" <= ${requestStartedAt}
          )
        )
      RETURNING "signature"
    `);
      if (claimed.length === orderedSignatures.length) return true;
      await tx.studyContentGenerationClaim.deleteMany({
        where: { signature: { in: claimed.map((row) => row.signature) }, ownerToken },
      });
      return false;
    },
    { maxWait: 2_000, timeout: 5_000 },
  );
}

export async function getStudyContentClaimStatus(
  prisma: PrismaService,
  signature: string,
  now = new Date(),
): Promise<StudyContentClaimStatus> {
  const claim = await prisma.studyContentGenerationClaim.findUnique({
    where: { signature },
    select: { ownerToken: true, leaseExpiresAt: true, retryAfter: true },
  });
  if (!claim) return 'READY';
  if (claim.ownerToken && (!claim.leaseExpiresAt || claim.leaseExpiresAt <= now)) return 'EXPIRED';
  if (claim.ownerToken) return 'BUSY';
  if (claim.retryAfter && claim.retryAfter > now) return 'COOLDOWN';
  return 'READY';
}

export async function renewStudyContentClaims(
  prisma: PrismaService,
  signatures: string[],
  ownerToken: string,
  now = new Date(),
) {
  if (!signatures.length) return true;
  const result = await prisma.studyContentGenerationClaim.updateMany({
    where: { signature: { in: signatures }, ownerToken, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + STUDY_CONTENT_CLAIM_LEASE_MS) },
  });
  return result.count === signatures.length;
}

export async function releaseStudyContentClaims(
  prisma: PrismaService,
  signatures: string[],
  ownerToken: string,
  failureCode?: string,
  now = new Date(),
) {
  if (!signatures.length) return;
  if (!failureCode) {
    await prisma.studyContentGenerationClaim.deleteMany({
      where: { signature: { in: signatures }, ownerToken },
    });
    return;
  }
  if (!SAFE_FAILURE_CODES.has(failureCode)) {
    throw new Error('Unsupported public cache claim failure code');
  }
  await prisma.studyContentGenerationClaim.updateMany({
    where: { signature: { in: signatures }, ownerToken, leaseExpiresAt: { gt: now } },
    data: {
      ownerToken: null,
      leaseExpiresAt: null,
      retryAfter: new Date(now.getTime() + STUDY_CONTENT_CLAIM_FAILURE_COOLDOWN_MS),
      lastFailureCode: failureCode,
    },
  });
}

async function pruneExpiredStudyContentClaims(prisma: PrismaService, now: Date) {
  if (now.getTime() - lastPruneAttemptAt < 60 * 60 * 1000) return;
  lastPruneAttemptAt = now.getTime();
  const olderThan = new Date(now.getTime() - STALE_CLAIM_RETENTION_MS);
  await prisma.studyContentGenerationClaim.deleteMany({
    where: {
      OR: [
        { ownerToken: null, OR: [{ retryAfter: null }, { retryAfter: { lt: olderThan } }] },
        { ownerToken: { not: null }, leaseExpiresAt: { lt: olderThan } },
      ],
    },
  });
}
