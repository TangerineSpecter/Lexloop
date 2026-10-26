import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../lib/micro-story-drafts.ts', import.meta.url), 'utf8');
const storage = new Map();
let failReads = false;
let failWrites = false;
const localStorage = {
  get length() {
    return storage.size;
  },
  getItem(key) {
    if (failReads) throw new Error('Storage unavailable');
    return storage.get(key) ?? null;
  },
  setItem(key, value) {
    if (failWrites) throw new Error('Quota exceeded');
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  key(index) {
    return [...storage.keys()][index] ?? null;
  },
};
const module = { exports: {} };
const compiled = ts.transpile(source, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
});
runInNewContext(compiled, { module, exports: module.exports, localStorage, encodeURIComponent });
const { clearMicroStoryDrafts, readStoryDraft, saveStoryDraft, saveReviewDraft } = module.exports;

test('draft reads are bounded to a user and exact story and tolerate unavailable storage', () => {
  storage.clear();
  saveStoryDraft('user.a', {
    storyKey: 'bus-01',
    interpretation: '汤姆错过了公交车。',
    ownSentence: 'I missed the bus.',
  });
  assert.equal(readStoryDraft('user.a', 'bus-01').interpretation, '汤姆错过了公交车。');
  assert.equal(readStoryDraft('user.b', 'bus-01'), null);
  assert.equal(readStoryDraft('user.a', 'bus-02'), null);
  assert.equal(storage.has('lexloop.micro-story.story.user%2Ea'), false);

  storage.set('lexloop.micro-story.story.corrupt', '{invalid');
  assert.equal(readStoryDraft('corrupt', 'bus-01'), null);
  assert.equal(storage.has('lexloop.micro-story.story.corrupt'), false);

  failReads = true;
  assert.equal(readStoryDraft('user.a', 'bus-01'), null);
  failReads = false;
  failWrites = true;
  assert.doesNotThrow(() =>
    saveStoryDraft('user.a', {
      storyKey: 'bus-01',
      interpretation: 'in memory',
      ownSentence: '',
    }),
  );
  failWrites = false;
});

test('clear-all cleanup removes only this user’s story and review drafts', () => {
  storage.clear();
  storage.set('lexloop.micro-story.story.user%2Ea', 'story');
  saveReviewDraft('user.a', 'review.1', '汤姆错过公交车');
  storage.set('lexloop.micro-story.review.other.review%2E1', 'keep');
  storage.set('lexloop.output.draft.user.a', 'keep');

  clearMicroStoryDrafts('user.a');

  assert.equal(storage.has('lexloop.micro-story.story.user%2Ea'), false);
  assert.equal(storage.has('lexloop.micro-story.review.user%2Ea.review%2E1'), false);
  assert.equal(storage.get('lexloop.micro-story.review.other.review%2E1'), 'keep');
  assert.equal(storage.get('lexloop.output.draft.user.a'), 'keep');
});
