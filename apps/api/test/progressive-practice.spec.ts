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

import { progressiveQualitySamples as samples } from './fixtures/progressive-quality-samples';

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

  it.each([
    [
      'FOUNDATION',
      'foundation',
      'It is available to every visiting family after the receptionist finishes checking all of the reservations today.',
    ],
    ['CONTEXT', 'context', 'We repair it.'],
  ] as const)('rejects an invalid additional target sentence in %s', (stage, sample, sentence) => {
    const group = structuredClone(samples[sample].group);
    group.sentences[1].english = sentence;
    expect(() =>
      validateGeneratedContent({ groups: [group] }, expected(stage, samples[sample].word)),
    ).toThrow('目标句长度不符合阶段要求');
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
    expect(prompt).toContain('恰好 3 个不同的英文句子');
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
    expect(repairPrompt).toContain('禁止复述、翻译、改写或仿写任何真实试卷');
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
