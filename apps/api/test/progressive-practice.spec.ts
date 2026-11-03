import { ProgressivePracticeStage, StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  MAX_STUDY_QUESTION_REPAIR_ATTEMPTS,
  PROGRESSIVE_PRACTICE_STAGE_RULES,
  PROGRESSIVE_PRACTICE_VERSION,
  contentSignature,
  generationPrompt,
  progressiveGroupRepairPrompt,
  validateAndRepairGeneratedContent,
  validateGeneratedContent,
} from '../src/modules/study/study.service';

const samples = {
  foundation: {
    word: { id: 'word-available', word: 'available', part: 'adj.', meaning: '可用的' },
    group: {
      index: 0,
      title: 'A free chair',
      wordOccurrences: { available: 1 },
      sentences: [
        {
          english: 'The chair is available now.',
          chinese: '这把椅子现在可以使用。',
          simplified: '这把椅子现在可用。',
          grammar: '形容词 available 描述椅子的状态。',
        },
        {
          english: 'Please take a seat.',
          chinese: '请坐。',
          simplified: '请坐。',
          grammar: '祈使句表示礼貌请求。',
        },
      ],
      questions: [
        {
          bookWordId: 'word-available',
          type: 'MEANING_RECOGNITION' as const,
          prompt: 'What does “available” mean for the chair?',
          options: ['可用的', '昂贵的', '损坏的', '遥远的'],
          correctAnswers: ['可用的'],
          explanation: '句子说椅子现在可用，所以有人可以坐下。',
        },
      ],
    },
  },
  context: {
    word: { id: 'word-repair', word: 'repair', part: 'v.', meaning: '修理' },
    group: {
      index: 0,
      title: 'A radio at the shop',
      wordOccurrences: { repair: 1 },
      sentences: [
        {
          english:
            'The shop will repair Mia’s old radio before Friday and call her when it is ready.',
          chinese: '商店会在周五前修好米娅的旧收音机，准备好后给她打电话。',
          simplified: '商店会在周五前修理米娅的旧收音机，准备好后给她打电话。',
          grammar: 'will repair 表示将来会进行的维修。',
        },
        {
          english: 'She can collect it then.',
          chinese: '她到时可以去取。',
          simplified: '她到时可以去取。',
          grammar: '情态动词 can 表示可以做某事。',
        },
      ],
      questions: [
        {
          bookWordId: 'word-repair',
          type: 'SYNONYM_REPLACEMENT' as const,
          prompt: 'Which word can replace “repair” in this sentence?',
          options: ['fix', 'replace', 'borrow', 'paint'],
          correctAnswers: ['fix'],
          explanation: '此处商店要让收音机恢复可用，fix 可替换 repair；其余词改变了动作。',
        },
      ],
    },
  },
  transfer: {
    word: { id: 'word-repair', word: 'repair', part: 'v.', meaning: '修理' },
    group: {
      index: 0,
      title: 'A lamp at the repair shop',
      wordOccurrences: { repair: 1 },
      sentences: [
        {
          english:
            'Mara asked the worker to repair her lamp on Monday, but he could not test it because the electricity was off.',
          chinese: '周一，玛拉请店员修理她的灯，但因为停电，他无法测试它。',
          simplified: '周一，玛拉请店员 repair 她的灯，但因为停电，他无法测试它。',
          grammar: 'because 引导原因从句，说明无法测试的原因。',
        },
        {
          english: 'He asked her to return Tuesday morning, when the power would be back.',
          chinese: '他请她周二早上再来，那时供电会恢复。',
          simplified: '他请她周二早上再来，那时供电会恢复。',
          grammar: 'when 引导时间从句，说明再次到店的时间。',
        },
        {
          english: 'After finding a loose wire, he fixed the lamp and called Mara before noon.',
          chinese: '发现一根松动的电线后，他修好了灯，并在中午前给玛拉打了电话。',
          simplified: '发现一根松动的电线后，他修好了灯，并在中午前给玛拉打了电话。',
          grammar: 'After 引导时间状语，fixed 表示已完成的维修。',
        },
      ],
      questions: [
        {
          bookWordId: 'word-repair',
          type: 'READING_COMPREHENSION' as const,
          prompt: 'Why did the worker ask Mara to return Tuesday morning?',
          options: [
            'The power would be back, so he could test the lamp.',
            'The shop would move to another street.',
            'Mara needed to bring a different lamp.',
            'The worker planned to buy the lamp.',
          ],
          correctAnswers: ['The power would be back, so he could test the lamp.'],
          explanation: '周一停电，店员无法测试；周二供电恢复后才能继续检查。',
        },
      ],
    },
  },
};

function expected(
  stage: ProgressivePracticeStage,
  word: (typeof samples)[keyof typeof samples]['word'],
) {
  return [
    {
      index: 0,
      words: [word],
      targetQuestionTypes: { [word.id]: PROGRESSIVE_PRACTICE_STAGE_RULES[stage].questionType },
      progressiveStage: stage,
      progressiveVersion: PROGRESSIVE_PRACTICE_VERSION,
    },
  ];
}

describe('progressive practice contracts', () => {
  it('keeps the three stage demands distinct and the sample answers supported by their sentences', () => {
    expect(PROGRESSIVE_PRACTICE_STAGE_RULES[ProgressivePracticeStage.FOUNDATION].questionType).toBe(
      'MEANING_RECOGNITION',
    );
    expect(PROGRESSIVE_PRACTICE_STAGE_RULES[ProgressivePracticeStage.CONTEXT].questionType).toBe(
      'SYNONYM_REPLACEMENT',
    );
    expect(PROGRESSIVE_PRACTICE_STAGE_RULES[ProgressivePracticeStage.TRANSFER].questionType).toBe(
      'READING_COMPREHENSION',
    );
    expect(() =>
      validateGeneratedContent(
        { groups: [samples.foundation.group] },
        expected(ProgressivePracticeStage.FOUNDATION, samples.foundation.word),
      ),
    ).not.toThrow();
    expect(() =>
      validateGeneratedContent(
        { groups: [samples.context.group] },
        expected(ProgressivePracticeStage.CONTEXT, samples.context.word),
      ),
    ).not.toThrow();
    expect(() =>
      validateGeneratedContent(
        { groups: [samples.transfer.group] },
        expected(ProgressivePracticeStage.TRANSFER, samples.transfer.word),
      ),
    ).not.toThrow();
  });

  it('rejects a stage question-type mismatch, extra sentences, and out-of-range target sentences', () => {
    const wrongType = structuredClone({
      ...samples.foundation.group,
      questions: samples.foundation.group.questions.map((question) => ({
        ...question,
        type: 'SYNONYM_REPLACEMENT' as const,
      })),
    });
    expect(() =>
      validateGeneratedContent(
        { groups: [wrongType] },
        expected(ProgressivePracticeStage.FOUNDATION, samples.foundation.word),
      ),
    ).toThrow('必须生成 MEANING_RECOGNITION');

    const extraSentence = structuredClone(samples.foundation.group);
    extraSentence.sentences.push({
      english: 'Lina smiles.',
      chinese: '莉娜笑了。',
      simplified: '莉娜笑了。',
      grammar: '一般现在时表示当前情况。',
    });
    expect(() =>
      validateGeneratedContent(
        { groups: [extraSentence] },
        expected(ProgressivePracticeStage.FOUNDATION, samples.foundation.word),
      ),
    ).toThrow('渐进练习第 1 组 结构不符合阶段要求');

    const shortSentence = structuredClone(samples.context.group);
    shortSentence.sentences[0].english = 'We repair it.';
    expect(() =>
      validateGeneratedContent(
        { groups: [shortSentence] },
        expected(ProgressivePracticeStage.CONTEXT, samples.context.word),
      ),
    ).toThrow('渐进练习第 1 组 目标句长度不符合阶段要求');
  });

  it('separates progressive stages and versions while preserving the legacy normal signature', () => {
    const word = samples.foundation.word;
    const normalSignature = contentSignature(StudyPlanMode.INDIVIDUAL, [word]);
    expect(normalSignature).toBe(
      contentSignature(StudyPlanMode.INDIVIDUAL, [word], StudyPlanPurpose.NORMAL),
    );
    const foundation = contentSignature(
      StudyPlanMode.INDIVIDUAL,
      [word],
      StudyPlanPurpose.PROGRESSIVE,
      { [word.id]: 'MEANING_RECOGNITION' },
      { stage: ProgressivePracticeStage.FOUNDATION, version: 1 },
    );
    expect(foundation).not.toBe(
      contentSignature(
        StudyPlanMode.INDIVIDUAL,
        [word],
        StudyPlanPurpose.PROGRESSIVE,
        { [word.id]: 'SYNONYM_REPLACEMENT' },
        { stage: ProgressivePracticeStage.CONTEXT, version: 1 },
      ),
    );
    expect(foundation).not.toBe(
      contentSignature(
        StudyPlanMode.INDIVIDUAL,
        [word],
        StudyPlanPurpose.PROGRESSIVE,
        { [word.id]: 'MEANING_RECOGNITION' },
        { stage: ProgressivePracticeStage.FOUNDATION, version: 2 },
      ),
    );
  });

  it('includes stage requirements in the plan prompt and group-only repair prompt', () => {
    const contract = { stage: ProgressivePracticeStage.TRANSFER, version: 1 };
    const prompt = generationPrompt(
      StudyPlanMode.INDIVIDUAL,
      [
        {
          index: 0,
          words: [samples.transfer.word],
          targetQuestionTypes: { 'word-repair': 'READING_COMPREHENSION' },
        },
      ],
      StudyPlanPurpose.PROGRESSIVE,
      contract,
    );
    expect(prompt).toContain('渐进练习');
    expect(prompt).not.toContain('五种题型轮换使用');
    expect(prompt).toContain('题型以 targetQuestionTypes 为准');
    expect(prompt).toContain('禁止复述、翻译、改写或仿写任何真实试卷');
    expect(prompt).toContain('恰好 3 个英文句子');
    expect(prompt).toContain('不代表 CEFR 认证');

    const error = new Error('short passage');
    const repairPrompt = progressiveGroupRepairPrompt({
      error: Object.assign(error, {
        code: 'STUDY_PROGRESSIVE_TRANSFER_PASSAGE_LENGTH_INVALID',
      }) as never,
      group: samples.transfer.group,
      words: [samples.transfer.word],
      stage: contract.stage,
      version: contract.version,
      attempt: 1,
    });
    expect(repairPrompt).toContain('只修复一组');
    expect(repairPrompt).toContain('阶段要求');
    expect(repairPrompt).toContain('不得新增词条');
  });

  it('counts group repairs within the same three-request total budget', async () => {
    const invalidGroup = structuredClone(samples.foundation.group);
    invalidGroup.sentences.push({
      english: 'Lina smiles.',
      chinese: '莉娜笑了。',
      simplified: '莉娜笑了。',
      grammar: '一般现在时表示当前情况。',
    });
    let repairCalls = 0;
    const error = await validateAndRepairGeneratedContent(
      { groups: [invalidGroup] },
      expected(ProgressivePracticeStage.FOUNDATION, samples.foundation.word),
      {
        maxAttempts: 1,
        attemptOffset: MAX_STUDY_QUESTION_REPAIR_ATTEMPTS - 1,
        onRepairAttempt: async (attempt) =>
          expect(attempt).toBe(MAX_STUDY_QUESTION_REPAIR_ATTEMPTS),
        repairQuestion: async () => {
          throw new Error('question repair is not expected');
        },
        repairGroup: async ({ attempt, group }) => {
          repairCalls += 1;
          expect(attempt).toBe(MAX_STUDY_QUESTION_REPAIR_ATTEMPTS);
          return group;
        },
      },
    ).catch((caught: unknown) => caught);
    expect(repairCalls).toBe(1);
    expect(error).toMatchObject({ code: 'STUDY_PROGRESSIVE_GROUP_SENTENCE_COUNT_INVALID' });
  });
});
