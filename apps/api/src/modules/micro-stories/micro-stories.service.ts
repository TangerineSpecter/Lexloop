import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MICRO_STORIES, nextStory, storyByKey } from './micro-stories.catalog';
import { nextReviewAt } from './micro-stories.rules';

const reviewDays = [1, 3, 7, 14, 30];

@Injectable()
export class MicroStoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private reviewAt(now: Date, days: number) {
    return nextReviewAt(now, days, this.config.get<string>('APP_TIMEZONE') ?? 'Asia/Shanghai');
  }

  async current(userId: string) {
    const [progress, due] = await Promise.all([
      this.prisma.microProgress.findUnique({ where: { userId } }),
      this.prisma.microError.findFirst({
        where: { userId, dueAt: { lte: new Date() } },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    const story = nextStory(
      MICRO_STORIES,
      progress?.completedKeys ?? [],
      progress?.interpretationKey,
    );
    const interpretation =
      progress && progress.interpretationKey === story?.key ? progress.interpretation : null;
    const reviewStory = due && storyByKey(due.lessonKey);
    return {
      completed: progress?.completedKeys.filter((key) => Boolean(storyByKey(key))).length ?? 0,
      total: MICRO_STORIES.length,
      lesson: story
        ? {
            key: story.key,
            series: story.series,
            part: story.part,
            level: story.level,
            english: story.english,
            interpretation,
            ...(interpretation
              ? {
                  reference: story.reference,
                  explanation: story.explanation,
                  frame: story.frame,
                  example: story.example,
                }
              : {}),
          }
        : null,
      review:
        due && reviewStory
          ? {
              id: due.id,
              key: reviewStory.key,
              english: reviewStory.english,
              interpretation: due.interpretation,
              reference: reviewStory.reference,
              explanation: reviewStory.explanation,
              ownSentence: due.ownSentence,
              reviewCount: due.reviewCount,
            }
          : null,
    };
  }

  async errors(userId: string) {
    const rows = await this.prisma.microError.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    return rows.flatMap((row) => {
      const story = storyByKey(row.lessonKey);
      return story
        ? [
            {
              id: row.id,
              english: story.english,
              interpretation: row.interpretation,
              reference: story.reference,
              explanation: story.explanation,
              ownSentence: row.ownSentence,
              dueAt: row.dueAt,
            },
          ]
        : [];
    });
  }

  async interpret(userId: string, key: string, interpretation: string) {
    if (!interpretation.trim()) throw new BadRequestException('请先写下你的理解。');
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);
      const progress = await tx.microProgress.findUnique({ where: { userId } });
      const story = nextStory(
        MICRO_STORIES,
        progress?.completedKeys ?? [],
        progress?.interpretationKey,
      );
      if (!story || story.key !== key)
        throw new ConflictException('当前故事已更新，请刷新后继续。');
      if (progress?.interpretationKey === key && progress.interpretation) {
        if (progress.interpretation !== interpretation)
          throw new ConflictException('已保存这次理解，请继续查看解析。');
      } else {
        await tx.microProgress.upsert({
          where: { userId },
          create: { userId, interpretationKey: key, interpretation },
          update: { interpretationKey: key, interpretation },
        });
      }
      return this.currentLessonWithAnswer(story, interpretation);
    });
  }

  async complete(userId: string, key: string, mismatch: boolean, ownSentence?: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);
      const progress = await tx.microProgress.findUnique({ where: { userId } });
      const story = nextStory(
        MICRO_STORIES,
        progress?.completedKeys ?? [],
        progress?.interpretationKey,
      );
      if (!story || story.key !== key)
        throw new ConflictException('当前故事已更新，请刷新后继续。');
      if (progress?.interpretationKey !== key || !progress.interpretation)
        throw new BadRequestException('请先写下你的理解。');
      if (mismatch) {
        await tx.microError.upsert({
          where: { userId_lessonKey: { userId, lessonKey: key } },
          create: {
            userId,
            lessonKey: key,
            interpretation: progress.interpretation,
            ownSentence: ownSentence?.trim() || null,
            dueAt: this.reviewAt(new Date(), 1),
          },
          update: {
            interpretation: progress.interpretation,
            ownSentence: ownSentence?.trim() || null,
            reviewCount: 0,
            dueAt: this.reviewAt(new Date(), 1),
          },
        });
      }
      await tx.microProgress.update({
        where: { userId },
        data: {
          completedKeys: [...new Set([...progress.completedKeys, key])],
          interpretationKey: null,
          interpretation: null,
        },
      });
      await tx.learningEvent.create({
        data: { userId, type: 'MICRO_STORY_COMPLETED', payload: { lessonKey: key, mismatch } },
      });
      return { completed: progress.completedKeys.length + 1, total: MICRO_STORIES.length };
    });
  }

  async review(userId: string, id: string, remembered: boolean) {
    const row = await this.prisma.microError.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('复习卡不存在');
    if (row.dueAt.getTime() > Date.now()) throw new ConflictException('这张卡还没到复习时间。');
    const nextCount = remembered ? row.reviewCount + 1 : 0;
    const nextDueAt = this.reviewAt(
      new Date(),
      reviewDays[Math.min(nextCount, reviewDays.length - 1)],
    );
    const updated = await this.prisma.microError.updateMany({
      where: { id, userId, dueAt: { lte: new Date() } },
      data: { reviewCount: nextCount, dueAt: nextDueAt },
    });
    if (!updated.count) throw new ConflictException('这张卡已复习，请刷新。');
    return { reviewCount: nextCount, dueAt: nextDueAt };
  }

  private currentLessonWithAnswer(story: (typeof MICRO_STORIES)[number], interpretation: string) {
    return { ...story, interpretation };
  }

  private async lock(tx: Prisma.TransactionClient, userId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`learning-records:${userId}`}))`,
    );
    await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true } });
  }
}
