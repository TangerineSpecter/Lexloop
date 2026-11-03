import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lexicalFields } from './lexical';
import {
  DAILY_SUPPLEMENT_KEY,
  DAILY_SUPPLEMENT_REVISION,
  DAILY_SUPPLEMENT_WORDS,
  outputReservedWords,
} from './supplement-eligibility';

export function supplementDeploymentReady(config?: ConfigService) {
  return config?.get<string>('DAILY_SUPPLEMENT_READY') === 'true';
}
export function requireSupplementDeployment(config?: ConfigService) {
  if (!supplementDeploymentReady(config))
    throw new BadRequestException(
      '补充词书尚未开放；请先完成全部 API、Worker 与更新服务的版本升级检查。',
    );
}
export function usableSupplementMeaning(meaning: string | null) {
  return lexicalFields(meaning).meanings.some(
    (line) => line.text.trim() && !['无', '暂无释义'].includes(line.text.trim()),
  );
}
export async function requireEnabledSupplement(tx: Prisma.TransactionClient, userId: string) {
  const enrolled = await tx.userVocabularyBook.findFirst({
    where: {
      userId,
      isPaused: false,
      book: {
        sourceKey: DAILY_SUPPLEMENT_KEY,
        sourceRevision: DAILY_SUPPLEMENT_REVISION,
        isSupplement: true,
        isActive: true,
        kind: 'SYSTEM',
        ownerId: null,
      },
    },
    select: { bookId: true },
  });
  if (!enrolled) throw new BadRequestException('请先启用日常补充词书；暂停不会删除已有学习记录。');
  return enrolled.bookId;
}

@Injectable()
export class DailySupplementService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async preview(userId: string) {
    const [words, enrollment, reserved] = await Promise.all([
      this.prisma.vocabularyWord.findMany({
        where: { normalized: { in: DAILY_SUPPLEMENT_WORDS } },
        include: {
          masteredBy: { where: { userId }, select: { id: true } },
          bookWords: {
            select: {
              id: true,
              book: { select: { isSupplement: true } },
              progress: { where: { userId }, select: { nextReviewAt: true, totalAttempts: true } },
              studyPlanItems: { where: { plan: { userId } }, select: { id: true } },
            },
          },
        },
      }),
      this.prisma.userVocabularyBook.findFirst({
        where: { userId, book: { sourceKey: DAILY_SUPPLEMENT_KEY } },
        include: { book: { select: { isActive: true, sourceRevision: true } } },
      }),
      outputReservedWords(this.prisma, userId),
    ]);
    const rows = DAILY_SUPPLEMENT_WORDS.map((text) => {
      const word = words.find((word) => word.normalized === text);
      const own = word?.bookWords.find(
        (item) => item.book.isSupplement && (item.progress.length || item.studyPlanItems.length),
      );
      const elsewhere = word?.bookWords.some(
        (item) => !item.book.isSupplement && (item.progress.length || item.studyPlanItems.length),
      );
      const associated = word?.bookWords.some((item) => item.book.isSupplement);
      const state =
        !word || !usableSupplementMeaning(word.meaning)
          ? 'missing'
          : word.masteredBy.length
            ? 'mastered'
            : elsewhere || reserved.has(word.id)
              ? 'learned_elsewhere'
              : own
                ? 'in_supplement'
                : enrollment && !associated
                  ? 'needs_sync'
                  : 'available';
      return {
        word: text,
        meaning: word?.meaning ?? null,
        state,
        attempts: own?.progress[0]?.totalAttempts ?? 0,
        nextReviewAt: own?.progress[0]?.nextReviewAt ?? null,
      };
    });
    return {
      deploymentReady: supplementDeploymentReady(this.config),
      revision: DAILY_SUPPLEMENT_REVISION,
      enabled: Boolean(
        enrollment &&
        !enrollment.isPaused &&
        enrollment.book.isActive &&
        enrollment.book.sourceRevision === DAILY_SUPPLEMENT_REVISION,
      ),
      enrolled: Boolean(enrollment),
      total: rows.length,
      rows,
    };
  }

  async setEnabled(userId: string, enabled: boolean) {
    if (enabled) requireSupplementDeployment(this.config);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId},0)) IS NULL`;
      if (!enabled) {
        await tx.userVocabularyBook.updateMany({
          where: { userId, book: { sourceKey: DAILY_SUPPLEMENT_KEY, isSupplement: true } },
          data: { isPaused: true },
        });
        return;
      }
      // One shared immutable list; append newly available existing global words
      // at their manifest positions, without creating/overwriting any dictionary field.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DAILY_SUPPLEMENT_KEY},0)) IS NULL`;
      const book = await tx.vocabularyBook.upsert({
        where: { sourceKey: DAILY_SUPPLEMENT_KEY },
        create: {
          sourceKey: DAILY_SUPPLEMENT_KEY,
          sourcePath: 'reviewed-boundaries:v2',
          sourceRevision: DAILY_SUPPLEMENT_REVISION,
          title: '日常生活 · 补充词书',
          category: 'GENERAL',
          isSupplement: true,
        },
        update: {},
      });
      if (
        !book.isSupplement ||
        book.kind !== 'SYSTEM' ||
        book.ownerId ||
        !book.isActive ||
        book.sourceRevision !== DAILY_SUPPLEMENT_REVISION
      )
        throw new BadRequestException('补充词书版本或来源不匹配；未更改任何记录。');
      const existing = await tx.vocabularyBookWord.findMany({
        where: { bookId: book.id },
        include: { word: true },
      });
      if (
        existing.some(
          (item) =>
            DAILY_SUPPLEMENT_WORDS[item.position - 1] !== item.word.normalized ||
            item.contextMeaning !== null,
        )
      )
        throw new BadRequestException('补充词书关联已变化；请先检查，未自动修复。');
      const words = await tx.vocabularyWord.findMany({
        where: { normalized: { in: DAILY_SUPPLEMENT_WORDS } },
      });
      const candidates = words.filter((word) => usableSupplementMeaning(word.meaning));
      if (!candidates.length) throw new BadRequestException('当前词库没有可用补充词；未创建订阅。');
      await tx.vocabularyBookWord.createMany({
        data: candidates.map((word) => ({
          bookId: book.id,
          wordId: word.id,
          position: DAILY_SUPPLEMENT_WORDS.indexOf(word.normalized) + 1,
        })),
        skipDuplicates: true,
      });
      const finalMap = await tx.vocabularyBookWord.findMany({
        where: { bookId: book.id },
        include: { word: true },
      });
      if (
        finalMap.some(
          (item) =>
            DAILY_SUPPLEMENT_WORDS[item.position - 1] !== item.word.normalized ||
            item.contextMeaning !== null,
        ) ||
        candidates.some((word) => !finalMap.some((item) => item.wordId === word.id))
      )
        throw new BadRequestException('补充词书关联冲突；本次操作已回滚。');
      await tx.userVocabularyBook.upsert({
        where: { userId_bookId: { userId, bookId: book.id } },
        create: { userId, bookId: book.id, isDefault: false, isPaused: false },
        update: { isPaused: false },
      });
    });
    return this.preview(userId);
  }
}
