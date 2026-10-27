import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearConfusionDraft,
  clearConfusionDraftIfMatches,
  readConfusionDraft,
  readConfusionDraftSnapshot,
  saveConfusionDraft,
} from '../lib/confusion-drafts.ts';

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
  { id: 'q1', sentence: 'Please ___ the light.', options: ['turn on', 'turn off'] },
  { id: 'q2', sentence: 'Can I ___ your book?', options: ['borrow', 'lend'] },
];

test('confusion drafts are scoped to both user and group and discard invalid answers', () => {
  const storage = createStorage();
  assert.ok(
    saveConfusionDraft('user.a', 'group/1', questions, { q1: 'turn on', q3: 'unknown' }, storage),
  );
  assert.deepEqual(readConfusionDraft('user.a', 'group/1', questions, storage), {
    q1: 'turn on',
  });
  assert.deepEqual(readConfusionDraft('user.b', 'group/1', questions, storage), {});
  assert.deepEqual(readConfusionDraft('user.a', 'group/2', questions, storage), {});
});

test('restoration validates the question content and current option values', () => {
  const storage = createStorage();
  saveConfusionDraft('user', 'group', questions, { q1: 'turn off', q2: 'lend' }, storage);
  assert.deepEqual(readConfusionDraft('user', 'group', questions, storage), {
    q1: 'turn off',
    q2: 'lend',
  });
  assert.deepEqual(
    readConfusionDraft(
      'user',
      'group',
      [{ ...questions[0], sentence: 'Please ___ the heater.' }, questions[1]],
      storage,
    ),
    {},
  );
  assert.deepEqual(
    readConfusionDraft(
      'user',
      'group',
      [questions[0], { ...questions[1], options: ['borrow', 'lease', 'lend'] }],
      storage,
    ),
    {},
  );
  assert.deepEqual(
    readConfusionDraft(
      'user',
      'group',
      [{ ...questions[0], options: ['turn off', 'turn on'] }, questions[1]],
      storage,
    ),
    { q1: 'turn off', q2: 'lend' },
  );
});

test('corrupt or unavailable storage degrades to empty drafts without throwing', () => {
  const storage = createStorage();
  storage.setItem('lexloop.confusion.draft.user.group', '{broken');
  assert.deepEqual(readConfusionDraft('user', 'group', questions, storage), {});
  assert.deepEqual(readConfusionDraft('user', 'group', questions, undefined), {});

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
  assert.deepEqual(readConfusionDraft('user', 'group', questions, unavailable), {});
  assert.equal(
    saveConfusionDraft('user', 'group', questions, { q1: 'turn on' }, unavailable),
    null,
  );
  assert.doesNotThrow(() => clearConfusionDraft('user', 'group', unavailable));
});

test('clearing a draft removes only the selected user and group', () => {
  const storage = createStorage();
  saveConfusionDraft('user.a', 'group.a', questions, { q1: 'turn on' }, storage);
  saveConfusionDraft('user.a', 'group.b', questions, { q2: 'lend' }, storage);
  saveConfusionDraft('user.b', 'group.a', questions, { q1: 'turn off' }, storage);

  clearConfusionDraft('user.a', 'group.a', storage);

  assert.deepEqual(readConfusionDraft('user.a', 'group.a', questions, storage), {});
  assert.deepEqual(readConfusionDraft('user.a', 'group.b', questions, storage), { q2: 'lend' });
  assert.deepEqual(readConfusionDraft('user.b', 'group.a', questions, storage), { q1: 'turn off' });
});

test('successful submission clears only the matching draft, preserving newer tab work', () => {
  const storage = createStorage();
  const submittedSnapshotId = saveConfusionDraft(
    'user',
    'group',
    questions,
    { q1: 'turn on' },
    storage,
  );
  const newerSnapshotId = saveConfusionDraft(
    'user',
    'group',
    questions,
    { q1: 'turn off' },
    storage,
  );
  assert.ok(submittedSnapshotId);
  assert.ok(newerSnapshotId);
  assert.notEqual(submittedSnapshotId, newerSnapshotId);
  assert.equal(
    readConfusionDraftSnapshot('user', 'group', questions, storage).snapshotId,
    newerSnapshotId,
  );

  assert.equal(
    clearConfusionDraftIfMatches(
      'user',
      'group',
      questions,
      { q1: 'turn on' },
      submittedSnapshotId,
      storage,
    ),
    false,
  );
  assert.deepEqual(readConfusionDraft('user', 'group', questions, storage), { q1: 'turn off' });
  assert.equal(
    clearConfusionDraftIfMatches(
      'user',
      'group',
      questions,
      { q1: 'turn off' },
      newerSnapshotId,
      storage,
    ),
    true,
  );
  assert.deepEqual(readConfusionDraft('user', 'group', questions, storage), {});
});

test('a changed question signature prevents clearing the submitted snapshot', () => {
  const storage = createStorage();
  const snapshotId = saveConfusionDraft('user', 'group', questions, { q1: 'turn on' }, storage);
  const updatedQuestions = [{ ...questions[0], sentence: 'Can you ___ the music?' }, questions[1]];

  assert.ok(snapshotId);
  assert.equal(
    readConfusionDraftSnapshot('user', 'group', questions, storage).snapshotId,
    snapshotId,
  );
  assert.equal(
    clearConfusionDraftIfMatches(
      'user',
      'group',
      updatedQuestions,
      { q1: 'turn on' },
      snapshotId,
      storage,
    ),
    false,
  );
  assert.equal(storage.values.size, 1);
  assert.equal(
    clearConfusionDraftIfMatches(
      'user',
      'group',
      questions,
      { q1: 'turn on' },
      snapshotId,
      storage,
    ),
    true,
  );
});
