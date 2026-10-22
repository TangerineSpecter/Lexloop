import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContrastGroup, ContrastResult } from '@lexloop/types';
import { PrismaService } from '../../prisma/prisma.service';
import { CONFUSION_CATALOG } from './confusion.catalog';
import { PracticeEvidenceService, type PracticeEvidence } from './practice-evidence.service';

@Injectable()
export class ConfusionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: PracticeEvidenceService,
  ) {}
  async list(userId: string): Promise<ContrastGroup[]> {
    const [weak, recent, previous] = await Promise.all([
      this.prisma.weaknessSignal.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: { wrongCount: 'desc' },
        take: 60,
        select: { bookWord: { select: { word: { select: { text: true } } } } },
      }),
      this.prisma.userWordProgress.findMany({
        where: { userId, state: { in: ['LEARNING', 'REVIEWING'] } },
        orderBy: { lastReviewedAt: 'desc' },
        take: 80,
        select: { bookWord: { select: { word: { select: { text: true } } } } },
      }),
      this.prisma.confusionAttempt.groupBy({ by: ['groupId'], where: { userId } }),
    ]);
    const weakWords = new Set(weak.map((row) => row.bookWord.word.text.toLowerCase()));
    const learned = new Set(recent.map((row) => row.bookWord.word.text.toLowerCase()));
    const practiced = new Set(previous.map((row) => row.groupId));
    return CONFUSION_CATALOG.map((group) => ({
      ...group,
      questions: group.questions.map(({ id, sentence }, index) => ({
        id,
        sentence,
        options: group.words
          .map((word) => word.word)
          .sort((a, b) => (index % 2 ? b.localeCompare(a) : a.localeCompare(b))),
      })),
      recommendation: group.words.some((word) => weakWords.has(word.word))
        ? '包含你的待巩固词'
        : group.words.some((word) => learned.has(word.word))
          ? '关联近期学习词'
          : '常见易混表达',
      practiced: practiced.has(group.id),
    })).sort(
      (a, b) =>
        rank(a.recommendation) - rank(b.recommendation) ||
        Number(a.practiced) - Number(b.practiced),
    );
  }

  async submit(
    userId: string,
    groupId: string,
    answers: Array<{ questionId: string; selected: string }>,
    clientRequestId: string,
    responseTimeMs: number,
  ): Promise<ContrastResult> {
    const group = CONFUSION_CATALOG.find((item) => item.id === groupId);
    if (!group) throw new NotFoundException('对比词组不存在');
    if (
      answers.length !== group.questions.length ||
      new Set(answers.map((answer) => answer.questionId)).size !== answers.length ||
      answers.some(
        (answer) =>
          !group.questions.some((q) => q.id === answer.questionId) ||
          !group.words.some((word) => word.word === answer.selected),
      )
    )
      throw new BadRequestException('请完整回答本组所有题目');
    const results = group.questions.map((question) => {
      const selected = answers.find((answer) => answer.questionId === question.id)!.selected;
      return {
        questionId: question.id,
        selected,
        answer: question.answer,
        correct: selected === question.answer,
        explanation: question.explanation,
      };
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`practice-evidence:${userId}`}))`,
      );
      const repeated = await tx.confusionAttempt.findUnique({
        where: { userId_clientRequestId: { userId, clientRequestId } },
      });
      if (repeated) {
        const saved = repeated.answers as unknown as ContrastResult['results'];
        if (
          repeated.groupId !== groupId ||
          saved.some(
            (row) =>
              answers.find((answer) => answer.questionId === row.questionId)?.selected !==
              row.selected,
          )
        )
          throw new ConflictException('提交编号与回答不匹配');
        return {
          id: repeated.id,
          groupId: repeated.groupId,
          correctCount: repeated.correctCount,
          total: repeated.total,
          results: saved,
        };
      }
      const today = new Date(Date.now() - 86_400_000);
      if ((await tx.confusionAttempt.count({ where: { userId, createdAt: { gte: today } } })) >= 30)
        throw new BadRequestException('24 小时内已完成 30 组，请休息后再练习');
      const attempt = await tx.confusionAttempt.create({
        data: {
          userId,
          groupId,
          clientRequestId,
          correctCount: results.filter((row) => row.correct).length,
          total: results.length,
          answers: results as unknown as Prisma.InputJsonValue,
        },
      });
      const matches = await tx.userWordProgress.findMany({
        where: {
          userId,
          bookWord: {
            book: {
              isActive: true,
              OR: [{ ownerId: userId }, { kind: 'SYSTEM', userBooks: { some: { userId } } }],
            },
            word: { normalized: { in: group.words.map((word) => word.word) } },
          },
        },
        take: 30,
        include: { bookWord: { include: { word: true } } },
      });
      const evidence: PracticeEvidence[] = [];
      const seen = new Set<string>();
      for (const match of matches) {
        if (seen.has(match.bookWord.word.normalized)) continue;
        seen.add(match.bookWord.word.normalized);
        const questions = group.questions.filter(
          (question) => question.answer === match.bookWord.word.normalized,
        );
        const ownResults = results.filter((row) =>
          questions.some((question) => question.id === row.questionId),
        );
        if (!ownResults.length) continue;
        evidence.push({
          bookWordId: match.bookWordId,
          correct: ownResults.every((row) => row.correct),
          questionType: 'CONFUSION',
          answer: ownResults.map((row) => row.selected).join(' / '),
          prompt: questions.map((q) => q.sentence).join('\n'),
          explanation: ownResults.map((row) => row.explanation).join('\n'),
          expected: questions.map((q) => q.answer).join(' / '),
          responseTimeMs: Math.floor(responseTimeMs / group.words.length),
        });
      }
      await this.evidence.record(tx, userId, evidence);
      await tx.learningEvent.create({
        data: {
          userId,
          type: 'CONFUSION_COMPLETED',
          payload: {
            attemptId: attempt.id,
            groupId,
            correctCount: attempt.correctCount,
            total: attempt.total,
          },
        },
      });
      return {
        id: attempt.id,
        groupId,
        correctCount: attempt.correctCount,
        total: attempt.total,
        results,
      };
    });
    return result;
  }
  async history(userId: string) {
    return this.prisma.confusionAttempt.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        groupId: true,
        correctCount: true,
        total: true,
        answers: true,
        createdAt: true,
      },
    });
  }
}
function rank(reason: string) {
  return reason === '包含你的待巩固词' ? 0 : reason === '关联近期学习词' ? 1 : 2;
}
