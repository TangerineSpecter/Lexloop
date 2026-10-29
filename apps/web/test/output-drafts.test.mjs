import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearOutputDraftSubmissionIfMatches,
  outputDraftKey,
  readOutputDraft,
  saveOutputDraft,
} from '../lib/output-drafts.ts';

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

const identity = { userId: 'user-a', challengeId: 'challenge-a', date: '2026-10-27' };
const answer = 'I can use this answer again after a network interruption.';
const submission = { answer, id: 'request-id-123' };

test('output drafts restore the request identity only for the same account and challenge', () => {
  const storage = createStorage();
  assert.equal(saveOutputDraft(identity, answer, submission, storage), true);
  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission,
    storageAvailable: true,
  });
  assert.deepEqual(readOutputDraft({ ...identity, userId: 'user-b' }, storage), {
    answer: '',
    submission: null,
    storageAvailable: true,
  });
  assert.deepEqual(readOutputDraft({ ...identity, challengeId: 'challenge-b' }, storage), {
    answer: '',
    submission: null,
    storageAvailable: true,
  });
  assert.deepEqual(readOutputDraft({ ...identity, date: '2026-10-28' }, storage), {
    answer: '',
    submission: null,
    storageAvailable: true,
  });
  assert.equal(outputDraftKey(identity.userId), 'lexloop.output.draft.user-a');
});

test('legacy answer drafts remain usable but never invent a previous request identity', () => {
  const storage = createStorage();
  storage.setItem(outputDraftKey(identity.userId), JSON.stringify({ date: identity.date, answer }));
  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission: null,
    storageAvailable: true,
  });
});

test('stale or mismatched submission ids are discarded while the answer is retained', () => {
  const storage = createStorage();
  saveOutputDraft(identity, answer, { answer: 'another answer', id: submission.id }, storage);
  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission: null,
    storageAvailable: true,
  });
  storage.setItem(
    outputDraftKey(identity.userId),
    JSON.stringify({
      version: 2,
      ...identity,
      answer,
      clientRequestId: 'x',
      requestAnswer: answer,
    }),
  );
  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission: null,
    storageAvailable: true,
  });
});

test('successful request cleanup clears only the same saved snapshot', () => {
  const storage = createStorage();
  saveOutputDraft(identity, answer, submission, storage);
  const newerAnswer = `${answer} Another sentence.`;
  saveOutputDraft(identity, newerAnswer, { answer: newerAnswer, id: 'new-request-id' }, storage);

  assert.equal(clearOutputDraftSubmissionIfMatches(identity, submission, storage), false);
  assert.equal(readOutputDraft(identity, storage).answer, newerAnswer);

  saveOutputDraft(identity, answer, submission, storage);
  assert.equal(clearOutputDraftSubmissionIfMatches(identity, submission, storage), true);
  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission: null,
    storageAvailable: true,
  });
});

test('a measured response duration stays bound to its request identity across draft restoration', () => {
  const storage = createStorage();
  const timedSubmission = { ...submission, responseTimeMs: 4200 };
  saveOutputDraft(identity, answer, timedSubmission, storage);

  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission: timedSubmission,
    storageAvailable: true,
  });
  assert.equal(readOutputDraft({ ...identity, userId: 'user-b' }, storage).submission, null);

  const draft = JSON.parse(storage.getItem(outputDraftKey(identity.userId)));
  draft.requestResponseTimeMs = 3_600_001;
  storage.setItem(outputDraftKey(identity.userId), JSON.stringify(draft));
  assert.deepEqual(readOutputDraft(identity, storage), {
    answer,
    submission,
    storageAvailable: true,
  });
});

test('corrupt and unavailable storage never interrupts editing or submission', () => {
  const corrupt = createStorage();
  corrupt.setItem(outputDraftKey(identity.userId), '{broken');
  assert.deepEqual(readOutputDraft(identity, corrupt), {
    answer: '',
    submission: null,
    storageAvailable: true,
  });

  const unavailable = {
    getItem() {
      throw new Error('storage unavailable');
    },
    setItem() {
      throw new Error('quota exceeded');
    },
  };
  assert.deepEqual(readOutputDraft(identity, unavailable), {
    answer: '',
    submission: null,
    storageAvailable: false,
  });
  assert.equal(saveOutputDraft(identity, answer, submission, unavailable), false);
  assert.equal(clearOutputDraftSubmissionIfMatches(identity, submission, unavailable), false);
  assert.doesNotThrow(() => readOutputDraft(identity, undefined));
});
