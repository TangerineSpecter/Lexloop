import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearStudyDraft,
  clearStudyDraftIfMatches,
  readStudyDraftSnapshot,
  saveStudyDraft,
  studyDraftAnswerCount,
} from '../lib/study-drafts.ts';

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
    removeItem(key) {
      values.delete(key);
    },
  };
}

const questions = [
  {
    bookWordId: 'word-1',
    type: 'MEANING_RECOGNITION',
    prompt: 'Choose the meaning of bright.',
    options: ['暗的', '明亮的'],
  },
  {
    bookWordId: 'word-2',
    type: 'WORD_MATCHING',
    prompt: 'Match each phrase.',
    options: [],
    pairs: [
      { left: 'help people', right: '自助' },
      { left: 'help oneself', right: '服务大众' },
    ],
  },
];

const answers = {
  'word-1': { selected: ['明亮的'], confirmed: true },
  'word-2': { selected: ['help people=>自助'], confirmed: false },
};

test('study drafts are scoped to account, plan, group and the same question set', () => {
  const storage = createStorage();
  const snapshotId = saveStudyDraft('user.a', 'plan/1', 0, questions, answers, storage);
  assert.ok(snapshotId);
  assert.deepEqual(
    readStudyDraftSnapshot('user.a', 'plan/1', 0, questions, storage).answers,
    answers,
  );
  assert.deepEqual(readStudyDraftSnapshot('user.b', 'plan/1', 0, questions, storage).answers, {});
  assert.deepEqual(readStudyDraftSnapshot('user.a', 'plan/2', 0, questions, storage).answers, {});
  assert.deepEqual(readStudyDraftSnapshot('user.a', 'plan/1', 1, questions, storage).answers, {});
  assert.deepEqual(
    readStudyDraftSnapshot(
      'user.a',
      'plan/1',
      0,
      [{ ...questions[0], prompt: 'Choose the meaning of bright in this sentence.' }, questions[1]],
      storage,
    ).answers,
    {},
  );
  assert.ok(!JSON.stringify([...storage.values.values()]).includes('correctAnswers'));
  assert.ok(!JSON.stringify([...storage.values.values()]).includes('explanation'));
});

test('matching drafts remain valid while the server reveals a completed group', () => {
  const storage = createStorage();
  const reversedAfterSubmission = [{ ...questions[1], pairs: [...questions[1].pairs].reverse() }];
  const visibleBeforeSubmission = [questions[0], questions[1]];
  const visibleAfterSubmission = [questions[0], reversedAfterSubmission[0]];
  const snapshotId = saveStudyDraft('user', 'plan', 0, visibleBeforeSubmission, answers, storage);

  assert.equal(
    readStudyDraftSnapshot('user', 'plan', 0, visibleAfterSubmission, storage).snapshotId,
    snapshotId,
  );
  assert.deepEqual(
    readStudyDraftSnapshot('user', 'plan', 0, visibleAfterSubmission, storage).answers,
    answers,
  );
  assert.deepEqual(
    readStudyDraftSnapshot(
      'user',
      'plan',
      0,
      [questions[0], { ...questions[1], pairs: [{ left: 'help people', right: '拒绝' }] }],
      storage,
    ).answers,
    {},
  );
});

test('draft answer values are validated and storage failures do not interrupt practice', () => {
  const storage = createStorage();
  saveStudyDraft(
    'user',
    'plan',
    0,
    questions,
    {
      'word-1': { selected: ['invented answer'], confirmed: true },
      'word-2': { selected: ['help people=>unknown'], confirmed: true },
    },
    storage,
  );
  assert.deepEqual(readStudyDraftSnapshot('user', 'plan', 0, questions, storage).answers, {});

  storage.setItem('lexloop.study.draft.user.plan.0', '{broken');
  assert.deepEqual(readStudyDraftSnapshot('user', 'plan', 0, questions, storage).answers, {});
  assert.equal(storage.values.has('lexloop.study.draft.user.plan.0'), false);
  assert.deepEqual(readStudyDraftSnapshot('user', 'plan', 0, questions, undefined).answers, {});
  const unavailable = {
    getItem() {
      throw new Error('Storage unavailable');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
    removeItem() {
      throw new Error('Storage unavailable');
    },
  };
  assert.equal(saveStudyDraft('user', 'plan', 0, questions, answers, unavailable), null);
  assert.doesNotThrow(() => clearStudyDraft('user', 'plan', 0, unavailable));
});

test('successful submission clears only its matching snapshot and supports deliberate discard', () => {
  const storage = createStorage();
  const submittedSnapshotId = saveStudyDraft('user', 'plan', 0, questions, answers, storage);
  const newerAnswers = {
    ...answers,
    'word-1': { selected: ['暗的'], confirmed: true },
  };
  const newerSnapshotId = saveStudyDraft('user', 'plan', 0, questions, newerAnswers, storage);
  assert.ok(submittedSnapshotId);
  assert.ok(newerSnapshotId);
  assert.notEqual(submittedSnapshotId, newerSnapshotId);
  assert.equal(
    clearStudyDraftIfMatches('user', 'plan', 0, questions, answers, submittedSnapshotId, storage),
    false,
  );
  assert.deepEqual(
    readStudyDraftSnapshot('user', 'plan', 0, questions, storage).answers,
    newerAnswers,
  );

  clearStudyDraft('user', 'plan', 0, storage);
  assert.deepEqual(readStudyDraftSnapshot('user', 'plan', 0, questions, storage).answers, {});
});

test('a snapshot is retained when its saved answers no longer match the submitted values', () => {
  const storage = createStorage();
  const snapshotId = saveStudyDraft('user', 'plan', 0, questions, answers, storage);
  const key = 'lexloop.study.draft.user.plan.0';
  const changedSnapshot = JSON.parse(storage.values.get(key));
  changedSnapshot.answers['word-1'] = { selected: ['暗的'], confirmed: true };
  storage.setItem(key, JSON.stringify(changedSnapshot));

  assert.equal(
    clearStudyDraftIfMatches('user', 'plan', 0, questions, answers, snapshotId, storage),
    false,
  );
  assert.deepEqual(
    readStudyDraftSnapshot('user', 'plan', 0, questions, storage).answers['word-1'],
    { selected: ['暗的'], confirmed: true },
  );
});

test('counts saved answers only for the same questions', () => {
  const storage = createStorage();
  assert.equal(studyDraftAnswerCount('user', 'plan', 0, questions, storage), 0);
  saveStudyDraft('user', 'plan', 0, questions, answers, storage);
  assert.equal(studyDraftAnswerCount('user', 'plan', 0, questions, storage), 2);
  assert.equal(
    studyDraftAnswerCount('user', 'plan', 0, [{ ...questions[0], prompt: 'changed' }], storage),
    0,
  );
});
