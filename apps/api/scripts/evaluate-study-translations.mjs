#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultDatasetPath = resolve(scriptDir, '../test/fixtures/study-translation-evaluation.json');
const allowedDimensions = new Set([
  'negation',
  'tense_and_order',
  'agent',
  'quantity',
  'causal_relation',
  'condition',
]);
const allowedReviews = new Set([
  'not_reviewed',
  'meaning_preserved',
  'meaning_changed',
  'uncertain',
]);

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

export function validateDataset(dataset) {
  if (!dataset || dataset.schemaVersion !== 1 || !Array.isArray(dataset.cases)) {
    throw new Error('Dataset must have schemaVersion 1 and a cases array.');
  }
  requireNonEmptyString(dataset.provenance, 'Dataset provenance');
  if (dataset.cases.length === 0) throw new Error('Dataset must contain at least one case.');

  const seenIds = new Set();
  for (const [index, testCase] of dataset.cases.entries()) {
    const prefix = `Case ${index + 1}`;
    requireNonEmptyString(testCase.id, `${prefix} id`);
    if (seenIds.has(testCase.id)) throw new Error(`Duplicate case id: ${testCase.id}.`);
    seenIds.add(testCase.id);
    if (!allowedDimensions.has(testCase.dimension)) {
      throw new Error(`${prefix} has unsupported dimension: ${testCase.dimension}.`);
    }
    requireNonEmptyString(testCase.english, `${prefix} English source`);
    requireNonEmptyString(testCase.referenceTranslation, `${prefix} reference translation`);
    for (const field of ['keyInformation', 'equivalentExamples', 'meaningErrorExamples']) {
      if (!Array.isArray(testCase[field]) || testCase[field].length === 0) {
        throw new Error(`${prefix} ${field} must be a non-empty array.`);
      }
    }
    testCase.keyInformation.forEach((item, itemIndex) =>
      requireNonEmptyString(item, `${prefix} keyInformation[${itemIndex}]`),
    );
    testCase.equivalentExamples.forEach((item, itemIndex) =>
      requireNonEmptyString(item, `${prefix} equivalentExamples[${itemIndex}]`),
    );
    testCase.meaningErrorExamples.forEach((example, exampleIndex) => {
      requireNonEmptyString(example.translation, `${prefix} meaningErrorExamples[${exampleIndex}]`);
      if (!Array.isArray(example.changedInformation) || example.changedInformation.length === 0) {
        throw new Error(
          `${prefix} meaningErrorExamples[${exampleIndex}].changedInformation must be a non-empty array.`,
        );
      }
      example.changedInformation.forEach((item, itemIndex) =>
        requireNonEmptyString(
          item,
          `${prefix} meaningErrorExamples[${exampleIndex}].changedInformation[${itemIndex}]`,
        ),
      );
    });
  }
  return dataset;
}

export function validateOutputs(outputs, dataset) {
  if (
    !outputs ||
    typeof outputs.sourceDescription !== 'string' ||
    !Array.isArray(outputs.outputs)
  ) {
    throw new Error('Output file must have sourceDescription and an outputs array.');
  }
  requireNonEmptyString(outputs.sourceDescription, 'Output sourceDescription');
  const caseIds = new Set(dataset.cases.map((testCase) => testCase.id));
  for (const [index, output] of outputs.outputs.entries()) {
    requireNonEmptyString(output.caseId, `Output ${index + 1} caseId`);
    if (!caseIds.has(output.caseId))
      throw new Error(`Output references unknown case id: ${output.caseId}.`);
    requireNonEmptyString(output.translation, `Output ${index + 1} translation`);
    if (output.review !== undefined && !allowedReviews.has(output.review)) {
      throw new Error(
        `Output ${index + 1} review must be one of: ${[...allowedReviews].join(', ')}.`,
      );
    }
    if (output.reviewerNote !== undefined && typeof output.reviewerNote !== 'string') {
      throw new Error(`Output ${index + 1} reviewerNote must be a string when provided.`);
    }
  }
  return outputs;
}

export function createReviewTemplate(dataset) {
  return {
    sourceDescription:
      'Describe the source of these candidate outputs; the evaluator makes no model calls.',
    outputs: dataset.cases.map((testCase) => ({
      caseId: testCase.id,
      translation: '',
      review: 'not_reviewed',
      reviewerNote: '',
    })),
  };
}

export function createReport(dataset, outputs = null) {
  const casesById = new Map(dataset.cases.map((testCase) => [testCase.id, testCase]));
  const candidates = outputs?.outputs ?? [];
  const reviewCounts = Object.fromEntries([...allowedReviews].map((review) => [review, 0]));
  for (const candidate of candidates) reviewCounts[candidate.review ?? 'not_reviewed'] += 1;

  const hasReviewedOutput = candidates.some(
    (candidate) => candidate.review && candidate.review !== 'not_reviewed',
  );
  const hasUnreviewedOutput = candidates.some(
    (candidate) => !candidate.review || candidate.review === 'not_reviewed',
  );
  const status = !hasReviewedOutput
    ? 'NOT_EVALUATED'
    : hasUnreviewedOutput
      ? 'PARTIALLY_ANNOTATED_NOT_INDEPENDENTLY_VERIFIED'
      : 'ANNOTATIONS_RECORDED_NOT_INDEPENDENTLY_VERIFIED';

  return {
    status,
    dataset: {
      caseCount: dataset.cases.length,
      provenance: dataset.provenance,
      semanticValidityIndependentlyVerified: false,
    },
    candidateOutputs: {
      count: candidates.length,
      sourceDescription: outputs?.sourceDescription ?? null,
      reviewCounts,
    },
    evaluation: {
      automaticSemanticJudgment: false,
      exactReferenceMatchingUsed: false,
      modelCalls: 0,
      note:
        candidates.length === 0
          ? 'No candidate outputs were supplied; semantic quality was not evaluated.'
          : 'Translations are not compared automatically. Annotations are recorded as supplied and are not independently verified.',
    },
    candidates: candidates.map((candidate) => ({
      caseId: candidate.caseId,
      english: casesById.get(candidate.caseId).english,
      translation: candidate.translation,
      review: candidate.review ?? 'not_reviewed',
      reviewerNote: candidate.reviewerNote ?? '',
    })),
  };
}

async function main(args) {
  let outputsPath = null;
  let templatePath = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--outputs') outputsPath = args[++index];
    else if (arg === '--template') templatePath = args[++index];
    else throw new Error(`Unknown argument: ${arg}.`);
    if (!args[index]) throw new Error(`Missing value for ${arg}.`);
  }
  if (outputsPath && templatePath) throw new Error('Use either --outputs or --template, not both.');

  const dataset = validateDataset(JSON.parse(await readFile(defaultDatasetPath, 'utf8')));
  if (templatePath) {
    await writeFile(
      resolve(templatePath),
      `${JSON.stringify(createReviewTemplate(dataset), null, 2)}\n`,
    );
  }
  const outputs = outputsPath
    ? validateOutputs(JSON.parse(await readFile(resolve(outputsPath), 'utf8')), dataset)
    : null;
  const report = createReport(dataset, outputs);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
