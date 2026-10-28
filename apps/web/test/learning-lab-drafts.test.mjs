import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../lib/learning-lab-drafts.ts', import.meta.url), 'utf8');
const storageRows = new Map();
let failReads = false;
let failWrites = false;
const storage = {
  getItem(key) {
    if (failReads) throw new Error('Storage unavailable');
    return storageRows.get(key) ?? null;
  },
  setItem(key, value) {
    if (failWrites) throw new Error('Quota exceeded');
    storageRows.set(key, String(value));
  },
  removeItem(key) {
    storageRows.delete(key);
  },
};
const module = { exports: {} };
const compiled = ts.transpile(source, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
});
runInNewContext(compiled, { module, exports: module.exports, encodeURIComponent });
const {
  clearLearningLabDraft,
  clearLearningLabDraftIfMatches,
  readLearningLabDraft,
  saveLearningLabDraft,
} = module.exports;

const questions = [
  { id: 'q1', prompt: 'Choose the best reply.', options: ['A', 'B', 'C'] },
  { id: 'q2', prompt: 'Choose the best phrase.', options: ['D', 'E', 'F'] },
  { id: 'q3', prompt: 'Choose the best meaning.', options: ['G', 'H', 'I'] },
];

test('quiz drafts restore only for the exact account and lesson', () => {
  storageRows.clear();
  const saved = saveLearningLabDraft('user.a', 'lesson.b', questions, [1, -1, 2], storage);
  assert.equal(saved.storageAvailable, true);
  assert.ok(saved.snapshotId);
  const restored = readLearningLabDraft('user.a', 'lesson.b', questions, storage);
  assert.deepEqual(Array.from(restored.answers), [1, -1, 2]);
  assert.equal(restored.restored, true);
  assert.equal(restored.storageAvailable, true);
  assert.equal(restored.snapshotId, saved.snapshotId);
  assert.deepEqual(
    Array.from(readLearningLabDraft('user', 'a.lesson.b', questions, storage).answers),
    [-1, -1, -1],
  );
  assert.deepEqual(
    Array.from(readLearningLabDraft('user.a', 'lesson.c', questions, storage).answers),
    [-1, -1, -1],
  );
  assert.equal(storageRows.size, 1);
  assert.equal(clearLearningLabDraft('user', 'a.lesson.b', storage), true);
  assert.equal(storageRows.size, 1);
});

test('changed question content invalidates the old selection without restoring it', () => {
  storageRows.clear();
  saveLearningLabDraft('learner', 'lesson', questions, [0, -1, -1], storage);
  const changed = questions.map((question) => ({ ...question, options: [...question.options] }));
  changed[0].options[0] = 'A revised';

  const changedResult = readLearningLabDraft('learner', 'lesson', changed, storage);
  assert.deepEqual(Array.from(changedResult.answers), [-1, -1, -1]);
  assert.equal(changedResult.restored, false);
  assert.equal(changedResult.storageAvailable, true);
  assert.equal(storageRows.size, 0);
});

test('successful submission clears only its matching snapshot and keeps a newer tab draft', () => {
  storageRows.clear();
  const submitted = saveLearningLabDraft('learner', 'lesson', questions, [0, -1, -1], storage);
  const newer = saveLearningLabDraft('learner', 'lesson', questions, [1, 2, -1], storage);

  assert.equal(
    clearLearningLabDraftIfMatches(
      'learner',
      'lesson',
      questions,
      [0, -1, -1],
      submitted.snapshotId,
      storage,
    ),
    false,
  );
  const preserved = readLearningLabDraft('learner', 'lesson', questions, storage);
  assert.deepEqual(Array.from(preserved.answers), [1, 2, -1]);
  assert.equal(preserved.snapshotId, newer.snapshotId);

  assert.equal(
    clearLearningLabDraftIfMatches(
      'learner',
      'lesson',
      questions,
      [1, 2, -1],
      newer.snapshotId,
      storage,
    ),
    true,
  );
  const restoredAfterLostResponse = saveLearningLabDraft(
    'learner',
    'lesson',
    questions,
    [2, -1, -1],
    storage,
  );
  assert.equal(
    clearLearningLabDraftIfMatches('learner', 'lesson', questions, [2, -1, -1], null, storage),
    true,
  );
  assert.ok(restoredAfterLostResponse.snapshotId);
  assert.equal(storageRows.size, 0);
});

test('corrupt and invalid selections are discarded; unavailable storage does not throw', () => {
  storageRows.clear();
  saveLearningLabDraft('learner', 'lesson', questions, [0, -1, -1], storage);
  const key = [...storageRows.keys()][0];
  storageRows.set(key, '{broken');
  assert.equal(readLearningLabDraft('learner', 'lesson', questions, storage).restored, false);
  assert.equal(storageRows.size, 0);

  assert.equal(
    saveLearningLabDraft('learner', 'lesson', questions, [3, -1, -1], storage).storageAvailable,
    false,
  );
  assert.equal(
    saveLearningLabDraft('learner', 'lesson', questions, [-1, -1, -1], storage).storageAvailable,
    true,
  );
  assert.equal(storageRows.size, 0);

  failReads = true;
  const unavailable = readLearningLabDraft('learner', 'lesson', questions, storage);
  assert.deepEqual(Array.from(unavailable.answers), [-1, -1, -1]);
  assert.equal(unavailable.restored, false);
  assert.equal(unavailable.storageAvailable, false);
  failReads = false;
  failWrites = true;
  assert.equal(
    saveLearningLabDraft('learner', 'lesson', questions, [0, -1, -1], storage).storageAvailable,
    false,
  );
  failWrites = false;
  assert.equal(clearLearningLabDraft('learner', 'lesson', undefined), false);
});
