import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StudyPlanItemSource, StudyPlanMode, StudyPlanStatus, WordProgressState } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AiService } from '../ai/ai.service';
import { AiModelConfigService } from '../admin/ai-model-config.service';
import { PrismaService } from '../../prisma/prisma.service';

const DAY = 86_400_000;
const startOfToday = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; };
const modeMap = { group: StudyPlanMode.GROUP, individual: StudyPlanMode.INDIVIDUAL, exam: StudyPlanMode.EXAM } as const;
type RequestedMode = keyof typeof modeMap;
type PlanWord = { id: string; word: string; part: string; meaning: string };
type GeneratedQuestion = {
  bookWordId: string;
  type: 'WORD_MNEMONIC' | 'MEANING_RECOGNITION' | 'WORD_MATCHING' | 'SYNONYM_REPLACEMENT' | 'READING_COMPREHENSION';
  prompt: string;
  options: string[];
  correctAnswers: string[];
  explanation: string;
  optionNotes?: string[];
  pairs?: Array<{ left: string; right: string }>;
};
type GeneratedGroup = {
  index: number;
  title: string;
  wordOccurrences: Record<string, number>;
  sentences: Array<{ english: string; chinese: string; simplified: string }>;
  questions: GeneratedQuestion[];
};
type GeneratedContent = { groups: GeneratedGroup[] };
type ResolvedGroup = { group: GeneratedGroup; cacheId?: string; signature: string; reused: boolean };
type GradedAnswer = { isCorrect: boolean; questionType: GeneratedQuestion['type']; selectedAnswer: string[] };

@Injectable()
export class StudyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly modelConfigs: AiModelConfigService,
  ) {}

  async createPlan(userId: string, requestedNewWordCount?: number, requestedMode: RequestedMode = 'group') {
    const mode = modeMap[requestedMode];
    if (!mode) throw new BadRequestException('不支持的学习模式');
    if (mode === StudyPlanMode.EXAM) throw new BadRequestException('真题模式正在建设中，当前不会调用大模型');
    if (!await this.modelConfigs.selectedProvider(userId)) {
      throw new BadRequestException('请先在阅读材料模型设置中选择可用的大模型');
    }
    const existing = await this.prisma.studyPlan.findFirst({
      where: {
        userId,
        OR: [
          { status: StudyPlanStatus.GENERATING },
          { status: StudyPlanStatus.ACTIVE, generatedContent: { not: Prisma.DbNull } },
          { status: StudyPlanStatus.FAILED, createdAt: { gte: startOfToday() } },
        ],
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.items.length) return this.serializePlan(existing.id, userId);

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { defaultNewWordCount: true } });
    const [review, defaultBook] = await Promise.all([
      this.prisma.userWordProgress.findMany({
        where: { userId, state: WordProgressState.REVIEWING, nextReviewAt: { lte: new Date() } },
        orderBy: { nextReviewAt: 'asc' },
        select: { bookWordId: true },
      }),
      this.prisma.userVocabularyBook.findFirst({ where: { userId, isDefault: true }, select: { bookId: true } }),
    ]);
    const newWordCount = requestedNewWordCount ?? user.defaultNewWordCount;
    const newWords = defaultBook ? await this.prisma.vocabularyBookWord.findMany({
      where: {
        bookId: defaultBook.bookId,
        progress: { none: { userId } },
        word: { masteredBy: { none: { userId } } },
      },
      orderBy: { position: 'asc' },
      take: newWordCount,
      select: { id: true },
    }) : [];
    const reviewIds = review.map(item => item.bookWordId);
    const newIds = newWords.map(item => item.id).filter(id => !reviewIds.includes(id));
    const ids = shuffle([...reviewIds, ...newIds]);
    if (!ids.length) throw new BadRequestException('当前没有可加入学习计划的单词');
    const groups = buildGroups(ids, mode);

    const plan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.studyPlan.create({ data: { userId, mode, status: StudyPlanStatus.GENERATING } });
      await tx.studyPlanItem.createMany({
        data: groups.flatMap((group, groupIndex) => group.map(bookWordId => ({
          planId: created.id,
          bookWordId,
          source: reviewIds.includes(bookWordId) ? StudyPlanItemSource.REVIEW : StudyPlanItemSource.NEW,
          groupIndex,
        }))),
      });
      return created;
    });
    return this.serializePlan(plan.id, userId);
  }

  async generatePlan(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      include: {
        items: {
          orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
          include: { bookWord: { include: { word: true } } },
        },
      },
    });
    if (!plan) throw new NotFoundException('学习计划不存在');
    if (plan.status === StudyPlanStatus.ACTIVE || plan.status === StudyPlanStatus.COMPLETED) return this.serializePlan(planId, userId);
    if (plan.mode === StudyPlanMode.EXAM) throw new BadRequestException('真题模式不使用 AI 生成内容');
    if (!await this.modelConfigs.selectedProvider(userId)) {
      throw new BadRequestException('请先在阅读材料模型设置中选择可用的大模型');
    }
    const generationStartedAt = new Date();
    const staleBefore = new Date(generationStartedAt.getTime() - 10 * 60 * 1000);
    const claim = await this.prisma.studyPlan.updateMany({
      where: {
        id: planId,
        userId,
        status: { in: [StudyPlanStatus.GENERATING, StudyPlanStatus.FAILED] },
        OR: [
          { generationStartedAt: null },
          { generationStartedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: StudyPlanStatus.GENERATING,
        generationStartedAt,
        generationError: null,
      },
    });
    if (!claim.count) return this.serializePlan(planId, userId);
    const grouped = plan.items.reduce((result, item) => {
      const current = result.get(item.groupIndex) ?? [];
      current.push(item);
      result.set(item.groupIndex, current);
      return result;
    }, new Map<number, typeof plan.items>());
    const words = plan.items.map(item => ({
      id: item.bookWordId,
      word: item.bookWord.word.text,
      part: part(item.bookWord.word.meaning),
      meaning: meaning(item.bookWord.word.meaning),
    }));
    const groupSpec = [...grouped.entries()].map(([index, items]) => ({
      index,
      words: items.map(item => words.find(word => word.id === item.bookWordId)!),
    }));

    try {
      const cached = await Promise.all(groupSpec.map(async (spec): Promise<ResolvedGroup | null> => {
        const signature = contentSignature(plan.mode, spec.words);
        const cache = await this.prisma.studyContentCache.findFirst({
          where: {
            signature,
            mode: plan.mode,
            // A cache entry is reusable when this user has never answered a
            // question from it. Other users' attempts do not block reuse.
            planItems: { none: { attempts: { some: { userId } } } },
          },
          orderBy: [{ hitCount: 'desc' }, { createdAt: 'asc' }],
        });
        if (!cache) return null;
        return {
          cacheId: cache.id,
          signature,
          reused: true,
          group: { ...(cache.material as unknown as GeneratedGroup), index: spec.index },
        };
      }));
      const missingSpecs = groupSpec.filter((_, index) => !cached[index]);
      let generatedMissing: GeneratedGroup[] = [];
      if (missingSpecs.length) {
        const response = await this.ai.generateForUser({
          purpose: 'study-plan',
          prompt: generationPrompt(plan.mode, missingSpecs),
          schema: {},
        }, userId);
        const generated = parseGeneratedContent(response);
        validateGeneratedContent(generated, missingSpecs);
        generatedMissing = generated.groups;
      }
      const resolved = groupSpec.map((spec, index): ResolvedGroup => {
        const cache = cached[index];
        if (cache) return cache;
        const group = generatedMissing.find(item => item.index === spec.index)!;
        const passage = group.sentences.map(sentence => sentence.english).join(' ');
        group.wordOccurrences = Object.fromEntries(spec.words.map(word => [
          word.word,
          passage.match(new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'gi'))?.length ?? 0,
        ]));
        return { group, signature: contentSignature(plan.mode, spec.words), reused: false };
      });
      const generatedContent: GeneratedContent = { groups: resolved.map(item => item.group) };
      validateGeneratedContent(generatedContent, groupSpec);
      await this.prisma.$transaction(async (tx) => {
        for (const resolvedGroup of resolved) {
          let cacheId = resolvedGroup.cacheId;
          if (cacheId) {
            await tx.studyContentCache.update({
              where: { id: cacheId },
              data: { hitCount: { increment: 1 }, lastUsedAt: new Date() },
            });
          } else {
            const created = await tx.studyContentCache.create({
              data: {
                signature: resolvedGroup.signature,
                mode: plan.mode,
                material: { ...resolvedGroup.group, index: 0 } as unknown as Prisma.InputJsonValue,
              },
            });
            cacheId = created.id;
          }
          for (const question of resolvedGroup.group.questions) {
            await tx.studyPlanItem.updateMany({
              where: { planId, bookWordId: question.bookWordId },
              data: {
                contentCacheId: cacheId,
                question: question as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }
        const newWordIds = plan.items
          .filter(item => item.source === StudyPlanItemSource.NEW)
          .map(item => item.bookWordId);
        if (newWordIds.length) {
          await tx.userWordProgress.createMany({
            data: newWordIds.map(bookWordId => ({
              userId,
              bookWordId,
              state: WordProgressState.LEARNING,
              firstLearnedAt: startOfToday(),
            })),
            skipDuplicates: true,
          });
        }
        await tx.studyPlan.update({
          where: { id: planId },
          data: {
            generatedContent: generatedContent as unknown as Prisma.InputJsonValue,
            generationError: null,
            generationStartedAt: null,
            generatedAt: new Date(),
            status: StudyPlanStatus.ACTIVE,
          },
        });
      });
      return this.serializePlan(planId, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '大模型未返回有效的学习内容';
      await this.prisma.studyPlan.update({
        where: { id: planId },
        data: {
          status: StudyPlanStatus.FAILED,
          generationStartedAt: null,
          generationError: message.slice(0, 500),
        },
      });
      if (error instanceof BadRequestException) throw error;
      throw new BadGatewayException(`学习计划生成失败：${message}`);
    }
  }

  async listPlans(userId: string) {
    const plans = await this.prisma.studyPlan.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true },
    });
    return Promise.all(plans.map(plan => this.serializePlan(plan.id, userId)));
  }

  async completeGroup(
    userId: string,
    planId: string,
    groupIndex: number,
    answers: Array<{ bookWordId: string; selectedAnswer: string[]; responseTimeMs?: number }>,
  ) {
    const items = await this.prisma.studyPlanItem.findMany({
      where: { planId, groupIndex, plan: { userId, status: StudyPlanStatus.ACTIVE } },
      include: { bookWord: true },
    });
    if (!items.length) throw new NotFoundException('学习分组不存在或计划尚未生成完毕');
    if (items.some(item => item.completedAt)) return this.serializePlan(planId, userId);
    if (items.length !== answers.length) throw new BadRequestException('答题结果与学习分组不匹配');
    const answersMatchGroup = new Set(answers.map(answer => answer.bookWordId)).size === items.length
      && answers.every(answer => items.some(item => item.bookWordId === answer.bookWordId));
    if (!answersMatchGroup) throw new BadRequestException('答题结果包含不属于当前分组的单词');

    await this.prisma.$transaction(async (tx) => {
      await tx.studyPlan.updateMany({
        where: { id: planId, startedAt: null },
        data: { startedAt: new Date() },
      });
      for (const item of items) {
        const answer = answers.find(value => value.bookWordId === item.bookWordId)!;
        const graded = gradeQuestion(item.question, answer.selectedAnswer);
        const progress = await tx.userWordProgress.findUniqueOrThrow({ where: { userId_bookWordId: { userId, bookWordId: item.bookWordId } } });
        await tx.wordReviewAttempt.create({
          data: {
            userId,
            bookWordId: item.bookWordId,
            planItemId: item.id,
            isCorrect: graded.isCorrect,
            questionType: graded.questionType,
            selectedAnswer: graded.selectedAnswer,
            responseTimeMs: answer.responseTimeMs == null ? undefined : Math.max(0, Math.min(3_600_000, answer.responseTimeMs)),
          },
        });
        await tx.userWordProgress.update({ where: { id: progress.id }, data: this.schedule(progress, graded.isCorrect) });
      }
      await tx.studyPlanItem.updateMany({ where: { id: { in: items.map(item => item.id) } }, data: { completedAt: new Date() } });
      const left = await tx.studyPlanItem.count({ where: { planId, completedAt: null } });
      if (!left) {
        await tx.studyPlan.update({
          where: { id: planId },
          data: { status: StudyPlanStatus.COMPLETED, completedAt: new Date() },
        });
      }
    });
    return this.serializePlan(planId, userId);
  }

  private schedule(progress: {
    reviewCount: number; totalAttempts: number; correctAttempts: number; consecutiveCorrect: number;
    lastIntervalDays: number; postponedCount: number; lastReviewedAt: Date | null; nextReviewAt: Date | null;
  }, correct: boolean) {
    const now = new Date();
    const totalAttempts = progress.totalAttempts + 1;
    const correctAttempts = progress.correctAttempts + (correct ? 1 : 0);
    const accuracy = correctAttempts / totalAttempts;
    const overdueDays = progress.nextReviewAt ? Math.max(0, (now.getTime() - progress.nextReviewAt.getTime()) / DAY) : 0;
    const actualGap = progress.lastReviewedAt ? Math.max(1, (now.getTime() - progress.lastReviewedAt.getTime()) / DAY) : 1;
    const base = Math.max(1, progress.lastIntervalDays || 1);
    const quality = correct ? (accuracy >= .85 ? 2.2 : accuracy >= .65 ? 1.45 : .9) : .45;
    const overdueFactor = Math.max(.4, 1 - Math.min(.55, overdueDays / base * .18));
    const postponeFactor = Math.max(.55, 1 - Math.min(.4, progress.postponedCount * .08));
    const persistentDifficulty = progress.reviewCount >= 4 && accuracy < .6;
    const interval = Math.max(1, Math.min(persistentDifficulty ? 2 : 180, Math.round(base * quality * overdueFactor * postponeFactor)));
    const nextReviewAt = new Date(now.getTime() + interval * DAY);
    const unfamiliarity = unfamiliarityScore({
      accuracy,
      overdueDays,
      actualGap,
      lastIntervalDays: base,
      reviewCount: progress.reviewCount + 1,
      consecutiveCorrect: correct ? progress.consecutiveCorrect + 1 : 0,
      postponedCount: progress.postponedCount,
    });
    return {
      state: WordProgressState.REVIEWING,
      reviewCount: { increment: 1 },
      totalAttempts: { increment: 1 },
      correctAttempts: correct ? { increment: 1 } : undefined,
      consecutiveCorrect: correct ? { increment: 1 } : 0,
      lastIntervalDays: interval,
      lastReviewedAt: now,
      nextReviewAt,
      familiarity: 100 - unfamiliarity,
      postponedCount: 0,
    };
  }

  private async serializePlan(planId: string, userId: string) {
    const plan = await this.prisma.studyPlan.findFirst({
      where: { id: planId, userId },
      include: {
        items: {
          orderBy: [{ groupIndex: 'asc' }, { id: 'asc' }],
          include: { bookWord: { include: { word: true } }, attempts: { orderBy: { createdAt: 'desc' }, take: 1 } },
        },
      },
    });
    if (!plan) throw new NotFoundException('学习计划不存在');
    const items = plan.items.map(item => ({
      id: item.bookWordId,
      word: item.bookWord.word.text,
      part: part(item.bookWord.word.meaning),
      meaning: meaning(item.bookWord.word.meaning),
      source: item.source,
      groupIndex: item.groupIndex,
      question: item.question,
      completed: Boolean(item.completedAt),
      result: item.attempts[0]?.isCorrect,
    }));
    const attempts = plan.items.flatMap(item => item.attempts);
    const typeStats = Object.values(attempts.reduce<Record<string, { type: string; total: number; correct: number }>>((result, attempt) => {
      const type = attempt.questionType ?? 'OTHER';
      const row = result[type] ?? { type, total: 0, correct: 0 };
      row.total++;
      if (attempt.isCorrect) row.correct++;
      result[type] = row;
      return result;
    }, {}));
    return {
      id: plan.id,
      mode: plan.mode.toLowerCase(),
      status: plan.status,
      generationError: plan.generationError,
      generatedAt: plan.generatedAt,
      createdAt: plan.createdAt,
      completedAt: plan.completedAt,
      wordCount: items.length,
      groupCount: new Set(items.map(item => item.groupIndex)).size,
      completed: items.filter(item => item.completed).length,
      content: plan.generatedContent,
      summary: {
        totalQuestions: attempts.length,
        correctQuestions: attempts.filter(attempt => attempt.isCorrect).length,
        durationSeconds: Math.round(attempts.reduce((sum, attempt) => sum + (attempt.responseTimeMs ?? 0), 0) / 1000),
        typeStats,
      },
      words: items,
    };
  }
}

function buildGroups(ids: string[], mode: StudyPlanMode) {
  if (mode === StudyPlanMode.INDIVIDUAL) return ids.map(id => [id]);
  const groups: string[][] = [];
  let cursor = 0;
  while (cursor < ids.length) {
    const remaining = ids.length - cursor;
    if (remaining <= 5) {
      if (remaining === 1 && groups.length) groups[groups.length - 1].push(ids[cursor]);
      else groups.push(ids.slice(cursor));
      break;
    }
    let size = 2 + Math.floor(Math.random() * 4);
    if (remaining - size === 1) size = size === 2 ? 3 : size - 1;
    groups.push(ids.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function shuffle<T>(values: T[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function gradeQuestion(questionValue: unknown, selectedValue: unknown): GradedAnswer {
  if (!questionValue || typeof questionValue !== 'object' || Array.isArray(questionValue)) {
    throw new BadRequestException('题目数据无效，请重新生成学习计划');
  }
  const question = questionValue as Partial<GeneratedQuestion>;
  const supportedTypes: GeneratedQuestion['type'][] = [
    'WORD_MNEMONIC',
    'MEANING_RECOGNITION',
    'WORD_MATCHING',
    'SYNONYM_REPLACEMENT',
    'READING_COMPREHENSION',
  ];
  if (!question.type || !supportedTypes.includes(question.type) || !Array.isArray(selectedValue)
    || selectedValue.some(value => typeof value !== 'string')) {
    throw new BadRequestException('答题结果格式无效');
  }
  if (question.type === 'WORD_MATCHING' && (
    !Array.isArray(question.pairs)
    || question.pairs.some(pair => !pair || typeof pair.left !== 'string' || typeof pair.right !== 'string')
  )) {
    throw new BadRequestException('配对题缺少可判定的正确答案，请重新生成学习计划');
  }
  const expected = question.type === 'WORD_MATCHING'
    ? question.pairs!.map(pair => `${pair.left}=>${pair.right}`)
    : question.correctAnswers;
  if (!Array.isArray(expected) || !expected.length || expected.some(value => typeof value !== 'string')) {
    throw new BadRequestException('题目缺少可判定的正确答案，请重新生成学习计划');
  }
  const selectedAnswer = [...selectedValue].sort();
  const correctAnswers = [...expected].sort();
  return {
    questionType: question.type,
    selectedAnswer,
    isCorrect: selectedAnswer.length === correctAnswers.length
      && correctAnswers.every((value, index) => value === selectedAnswer[index]),
  };
}

export function contentSignature(mode: StudyPlanMode, words: PlanWord[]) {
  const canonicalWords = [...words]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(word => ({ id: word.id, word: word.word, part: word.part, meaning: word.meaning }));
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, mode, words: canonicalWords }))
    .digest('hex');
}

function generationPrompt(mode: StudyPlanMode, groups: Array<{ index: number; words: PlanWord[] }>) {
  return `为 Lexloop 生成一份${mode === StudyPlanMode.INDIVIDUAL ? '独立单词' : '随机分组'}学习计划。
输入分组：${JSON.stringify(groups)}

必须只返回以下 JSON 结构：
{"groups":[{"index":0,"title":"英文短标题","wordOccurrences":{"word":2},"sentences":[{"english":"英文句子","chinese":"完整中文翻译","simplified":"除目标单词保留英文外，其余内容翻成中文的中英混合句"}],"questions":[{"bookWordId":"输入中的 id","type":"WORD_MNEMONIC|MEANING_RECOGNITION|WORD_MATCHING|SYNONYM_REPLACEMENT|READING_COMPREHENSION","prompt":"题干","options":["选项"],"correctAnswers":["正确选项原文"],"explanation":"简明解析","optionNotes":["与 options 对齐的提示"],"pairs":[{"left":"英文搭配","right":"中文解释"}]}]}]}

规则：
1. 每组 2–4 个自然、连贯且难度适中的英文句子，全文尽量不超过 90 个英文单词；独立单词材料尽量不超过 55 个英文单词。
2. 每组每个目标单词必须至少自然出现一次，并准确填写 wordOccurrences；不要为了次数生硬重复。
3. 每个英文句子必须有逐句 chinese 和 simplified。simplified 中目标单词保持英文原样，其余译成自然中文。
4. 每个目标单词恰好生成一道题，bookWordId 必须来自输入；五种题型轮换使用。每道客观题都能自动判分，通常提供 4 个有迷惑性的选项。
5. WORD_MNEMONIC 是多选题，围绕词根、词缀、派生词或可靠的形音义联想，correctAnswers 可多项，解析逐项说明关系，不得编造词源。
6. WORD_MATCHING 用 pairs 提供 4 组同一目标词的英文搭配与唯一中文释义；options 可为空。
7. READING_COMPREHENSION 模仿考试阅读理解，必须依据本组文章考查目标词在篇章中的含义、细节或推断，不考文章外知识。
8. 所有题目的正确答案和解析必须与文章、目标词释义一致。`;
}

function parseGeneratedContent(response: unknown): GeneratedContent {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型响应缺少 JSON 内容');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned) as GeneratedContent;
}

function validateGeneratedContent(content: GeneratedContent, expected: Array<{ index: number; words: PlanWord[] }>) {
  if (!Array.isArray(content.groups) || content.groups.length !== expected.length) throw new Error('模型返回的阅读材料分组数量不正确');
  for (const expectedGroup of expected) {
    const group = content.groups.find(item => item.index === expectedGroup.index);
    if (!group || !Array.isArray(group.sentences) || !group.sentences.length || !Array.isArray(group.questions)) throw new Error(`第 ${expectedGroup.index + 1} 组内容不完整`);
    if (group.questions.length !== expectedGroup.words.length || new Set(group.questions.map(question => question.bookWordId)).size !== expectedGroup.words.length) {
      throw new Error(`第 ${expectedGroup.index + 1} 组必须为每个单词生成且只生成一道题`);
    }
    if (group.sentences.some(sentence => !sentence.english?.trim() || !sentence.chinese?.trim() || !sentence.simplified?.trim())) {
      throw new Error(`第 ${expectedGroup.index + 1} 组缺少逐句翻译或简化文本`);
    }
    for (const word of expectedGroup.words) {
      const question = group.questions.find(item => item.bookWordId === word.id);
      if (!question || !question.prompt?.trim() || !Array.isArray(question.correctAnswers)) throw new Error(`单词 ${word.word} 缺少完整练习题`);
      if (!group.sentences.some(sentence => new RegExp(`\\b${escapeRegExp(word.word)}\\b`, 'i').test(sentence.english))) throw new Error(`阅读材料未包含单词 ${word.word}`);
    }
  }
}

export function unfamiliarityScore(input: {
  accuracy: number; overdueDays: number; actualGap: number; lastIntervalDays: number;
  reviewCount: number; consecutiveCorrect: number; postponedCount: number;
}) {
  const accuracyRisk = (1 - input.accuracy) * 58;
  const overdueRisk = Math.min(18, input.overdueDays / Math.max(1, input.lastIntervalDays) * 12);
  const gapRisk = Math.min(8, Math.max(0, input.actualGap - input.lastIntervalDays) / Math.max(1, input.lastIntervalDays) * 5);
  const streakRelief = Math.min(12, input.consecutiveCorrect * 3);
  const postponeRisk = Math.min(10, input.postponedCount * 2);
  const persistentRisk = input.reviewCount >= 4 && input.accuracy < .6 ? 14 : input.reviewCount < 2 && input.accuracy < .6 ? 6 : 0;
  return Math.max(0, Math.min(100, Math.round(accuracyRisk + overdueRisk + gapRisk + postponeRisk + persistentRisk - streakRelief)));
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function part(value: string | null) { return value?.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i)?.[1] ?? ''; }
function meaning(value: string | null) { const raw = value ?? '暂无释义'; return raw.slice(raw.match(/^((?:adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)\.)\s*/i)?.[0].length ?? 0); }
