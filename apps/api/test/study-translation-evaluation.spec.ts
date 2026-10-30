import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import dataset from './fixtures/study-translation-evaluation.json';

const apiDir = resolve(__dirname, '..');
const repositoryDir = resolve(apiDir, '../..');
const scriptPath = resolve(apiDir, 'scripts/evaluate-study-translations.mjs');
const temporaryDirectories: string[] = [];

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'lexloop-translation-evaluation-'));
  temporaryDirectories.push(directory);
  return directory;
}

function runEvaluator(args: string[] = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repositoryDir,
    encoding: 'utf8',
  });
  return result;
}

function getAmbiguousCase() {
  const testCase = dataset.cases.find((item) => item.dimension === 'ambiguity');
  if (!testCase) throw new Error('Ambiguity case is missing from the offline fixture.');
  return testCase;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('offline study translation evaluation', () => {
  it('covers the requested meaning dimensions with explicit counterexamples', () => {
    expect(new Set(dataset.cases.map((testCase) => testCase.dimension))).toEqual(
      new Set([
        'negation',
        'tense_and_order',
        'agent',
        'quantity',
        'causal_relation',
        'condition',
        'ambiguity',
      ]),
    );
    for (const testCase of dataset.cases) {
      expect(testCase.keyInformation.length, `${testCase.id} key information`).toBeGreaterThan(0);
      expect(
        testCase.equivalentExamples.length,
        `${testCase.id} equivalent variants`,
      ).toBeGreaterThan(0);
      expect(
        testCase.meaningErrorExamples.length,
        `${testCase.id} counterexamples`,
      ).toBeGreaterThan(0);
    }
    expect(dataset.provenance).toMatch(/not independently human-reviewed/i);
    const ambiguousCase = getAmbiguousCase();
    expect(ambiguousCase?.referenceNote).toMatch(/not the only reading/i);
    expect(ambiguousCase?.equivalentExamples).toHaveLength(1);
  });

  it('reports no supplied outputs as not evaluated, not as a pass', () => {
    const result = runEvaluator();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('NOT_EVALUATED');
    expect(report.candidateOutputs.count).toBe(0);
    expect(report.evaluation.modelCalls).toBe(0);
    expect(report.evaluation.automaticSemanticJudgment).toBe(false);
    expect(report.dataset.semanticValidityIndependentlyVerified).toBe(false);
  });

  it('creates a review template with all cases explicitly unreviewed', () => {
    const directory = createTemporaryDirectory();
    const templatePath = join(directory, 'review-template.json');
    const result = runEvaluator(['--template', templatePath]);
    expect(result.status).toBe(0);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    expect(template.outputs).toHaveLength(dataset.cases.length);
    expect(
      template.outputs.every((output: { review: string }) => output.review === 'not_reviewed'),
    ).toBe(true);
    expect(template.outputs[0]).toMatchObject({
      english: dataset.cases[0].english,
      keyInformation: dataset.cases[0].keyInformation,
      equivalentExamples: dataset.cases[0].equivalentExamples,
      meaningErrorExamples: dataset.cases[0].meaningErrorExamples,
    });
    expect(JSON.parse(result.stdout).status).toBe('NOT_EVALUATED');
  });

  it('does not reject a different translation by exact-reference comparison', () => {
    const directory = createTemporaryDirectory();
    const outputsPath = join(directory, 'outputs.json');
    const alternateTranslation = '图书馆周日不开门。';
    writeFileSync(
      outputsPath,
      JSON.stringify({
        sourceDescription: 'Synthetic test candidate; not a model result.',
        outputs: [{ caseId: 'negation-weekly-closure', translation: alternateTranslation }],
      }),
    );

    const result = runEvaluator(['--outputs', outputsPath]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('NOT_EVALUATED');
    expect(report.candidates[0].translation).toBe(alternateTranslation);
    expect(report.candidates[0].review).toBe('not_reviewed');
    expect(report.candidates[0].keyInformation).toEqual(dataset.cases[0].keyInformation);
    expect(report.candidates[0].meaningErrorExamples).toEqual(
      dataset.cases[0].meaningErrorExamples,
    );
    expect(report.evaluation.exactReferenceMatchingUsed).toBe(false);
  });

  it('keeps both readings visible when a source sentence is ambiguous', () => {
    const directory = createTemporaryDirectory();
    const outputsPath = join(directory, 'outputs.json');
    const ambiguousCase = getAmbiguousCase();
    writeFileSync(
      outputsPath,
      JSON.stringify({
        sourceDescription: 'Synthetic test candidate; not a model result.',
        outputs: [
          {
            caseId: ambiguousCase.id,
            translation: ambiguousCase.equivalentExamples[0],
          },
        ],
      }),
    );

    const result = runEvaluator(['--outputs', outputsPath]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('NOT_EVALUATED');
    expect(report.candidates[0].referenceNote).toMatch(/not the only reading/i);
    expect(report.candidates[0].keyInformation).toContain(
      'The sentence alone does not choose between those two readings.',
    );
  });

  it('records supplied annotations without presenting them as verified accuracy', () => {
    const directory = createTemporaryDirectory();
    const outputsPath = join(directory, 'outputs.json');
    writeFileSync(
      outputsPath,
      JSON.stringify({
        sourceDescription: 'Synthetic test candidate; manually annotated for tool testing.',
        outputs: [
          {
            caseId: 'negation-weekly-closure',
            translation: '图书馆星期日不开放。',
            review: 'meaning_preserved',
          },
        ],
      }),
    );

    const result = runEvaluator(['--outputs', outputsPath]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('ANNOTATIONS_RECORDED_NOT_INDEPENDENTLY_VERIFIED');
    expect(report.candidateOutputs.reviewCounts.meaning_preserved).toBe(1);
    expect(report.evaluation.automaticSemanticJudgment).toBe(false);
  });

  it('rejects outputs that reference unknown cases or unsupported review labels', () => {
    const directory = createTemporaryDirectory();
    const outputsPath = join(directory, 'outputs.json');
    writeFileSync(
      outputsPath,
      JSON.stringify({
        sourceDescription: 'Invalid test input',
        outputs: [{ caseId: 'unknown', translation: '译文' }],
      }),
    );
    const unknownCase = runEvaluator(['--outputs', outputsPath]);
    expect(unknownCase.status).not.toBe(0);
    expect(unknownCase.stderr).toMatch(/unknown case id/);

    writeFileSync(
      outputsPath,
      JSON.stringify({
        sourceDescription: 'Invalid test input',
        outputs: [{ caseId: 'negation-weekly-closure', translation: '译文', review: 'pass' }],
      }),
    );
    const unsupportedReview = runEvaluator(['--outputs', outputsPath]);
    expect(unsupportedReview.status).not.toBe(0);
    expect(unsupportedReview.stderr).toMatch(/review must be one of/);
  });
});
