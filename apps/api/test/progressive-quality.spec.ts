import { describe, expect, it } from 'vitest';
import {
  PROGRESSIVE_PRACTICE_STAGE_RULES,
  validateAndRepairGeneratedContent,
  validateGeneratedContent,
} from '../src/modules/study/study.service';
import { progressiveQualitySamples as samples } from './fixtures/progressive-quality-samples';

// Fixed offline probes: expected outcomes are explicit, not scored by a second model.
const cases = [
  { id: 'foundation-baseline', sample: 'foundation', stage: 'FOUNDATION' },
  { id: 'context-baseline', sample: 'context', stage: 'CONTEXT' },
  { id: 'transfer-baseline', sample: 'transfer', stage: 'TRANSFER' },
  {
    id: 'packed-sentences',
    sample: 'foundation',
    stage: 'FOUNDATION',
    first: 'The chair is available. Sit here.',
    code: 'STUDY_PROGRESSIVE_SENTENCE_BOUNDARY_INVALID',
  },
  {
    id: 'duplicate-foundation',
    sample: 'foundation',
    stage: 'FOUNDATION',
    duplicate: true,
    code: 'STUDY_PROGRESSIVE_SENTENCES_DUPLICATE',
  },
  {
    id: 'duplicate-transfer',
    sample: 'transfer',
    stage: 'TRANSFER',
    duplicate: true,
    code: 'STUDY_PROGRESSIVE_SENTENCES_DUPLICATE',
  },
  {
    id: 'mixed-language-context',
    sample: 'context',
    stage: 'CONTEXT',
    first: 'The shop will repair Mia’s old radio before Friday，修理后请来领取。',
    code: 'STUDY_PROGRESSIVE_SENTENCE_LANGUAGE_INVALID',
  },
  {
    id: 'honorific',
    sample: 'foundation',
    stage: 'FOUNDATION',
    first: 'Dr. Green has an available chair.',
  },
  {
    id: 'acronym',
    sample: 'foundation',
    stage: 'FOUNDATION',
    first: 'The U.S. office is available now.',
  },
  {
    id: 'decimal',
    sample: 'context',
    stage: 'CONTEXT',
    first: 'Mia paid $2.50 to repair the radio at our small shop.',
  },
  {
    id: 'quotation',
    sample: 'foundation',
    stage: 'FOUNDATION',
    first: 'The available desk is marked “free.”',
  },
  { id: 'semantic-blind-spot', sample: 'foundation', stage: 'FOUNDATION', wrongAnswer: true },
] as const;

describe('offline progressive quality probes v1', () => {
  it.each(cases)('$id', (probe) => {
    const group = structuredClone(samples[probe.sample].group);
    if ('first' in probe) group.sentences[0].english = probe.first;
    if ('duplicate' in probe) group.sentences[1] = structuredClone(group.sentences[0]);
    if ('wrongAnswer' in probe) group.questions[0].correctAnswers = ['昂贵的'];
    const word = samples[probe.sample].word;
    const expected = [
      {
        index: 0,
        words: [word],
        progressiveStage: probe.stage,
        progressiveVersion: 1,
        targetQuestionTypes: {
          [word.id]: PROGRESSIVE_PRACTICE_STAGE_RULES[probe.stage].questionType,
        },
      },
    ];
    if ('code' in probe) {
      try {
        validateGeneratedContent({ groups: [group] }, expected);
      } catch (error) {
        expect(error).toMatchObject({ code: probe.code, scope: 'group' });
        return;
      }
      expect.fail(`${probe.id} should be rejected`);
    } else {
      expect(() => validateGeneratedContent({ groups: [group] }, expected)).not.toThrow();
      // Deliberately demonstrate that a structurally valid wrong answer still needs human review.
      if ('wrongAnswer' in probe)
        expect(group.questions[0].correctAnswers).not.toEqual(
          samples.foundation.group.questions[0].correctAnswers,
        );
    }
  });
});

it('stops at the existing repair budget for repeated packed-sentence responses', async () => {
  const group = structuredClone(samples.foundation.group);
  group.sentences[0].english = 'The chair is available. Sit here.';
  const word = samples.foundation.word;
  let attempts = 0;
  await expect(
    validateAndRepairGeneratedContent(
      { groups: [group] },
      [
        {
          index: 0,
          words: [word],
          progressiveStage: 'FOUNDATION',
          progressiveVersion: 1,
          targetQuestionTypes: { [word.id]: 'MEANING_RECOGNITION' },
        },
      ],
      {
        maxAttempts: 3,
        onRepairAttempt: async () => {},
        repairQuestion: async ({ question }) => question,
        repairGroup: async () => {
          attempts += 1;
          return structuredClone(group);
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'STUDY_PROGRESSIVE_SENTENCE_BOUNDARY_INVALID' });
  expect(attempts).toBe(3);
});
