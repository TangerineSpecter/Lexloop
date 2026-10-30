import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearQuickReviewDraft,
  readQuickReviewDraft,
  saveQuickReviewDraft,
} from '../lib/quick-review-drafts.ts';

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

test('quick-review drafts restore only for the exact account and due-word prefix', () => {
  const storage = createStorage();
  const draft = {
    version: 1,
    userId: 'user.a',
    wordIds: ['due-1', 'due-2', 'due-3'],
    currentIndex: 1,
    revealed: true,
  };

  assert.equal(saveQuickReviewDraft(draft, storage), true);
  assert.deepEqual([...storage.values.keys()], ['lexloop.quick-review.v1.user%2Ea.due']);
  assert.deepEqual(readQuickReviewDraft('user.a', ['due-1', 'due-2', 'due-3', 'due-4'], storage), {
    draft,
    storageAvailable: true,
    stale: false,
  });
  assert.deepEqual(readQuickReviewDraft('user.b', ['due-1', 'due-2', 'due-3'], storage), {
    draft: null,
    storageAvailable: true,
    stale: false,
  });

  const saved = [...storage.values.values()][0];
  assert.ok(saved.includes('due-1'));
  assert.ok(!saved.includes('meaning'));
  assert.ok(!saved.includes('answer'));
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), [
    'currentIndex',
    'revealed',
    'userId',
    'version',
    'wordIds',
  ]);
});

test('a changed due order discards the draft instead of restoring stale questions', () => {
  const storage = createStorage();
  const draft = {
    version: 1,
    userId: 'user',
    wordIds: ['oldest', 'next', 'later'],
    currentIndex: 2,
    revealed: false,
  };
  saveQuickReviewDraft(draft, storage);

  assert.deepEqual(
    readQuickReviewDraft('user', ['newly-due', 'oldest', 'next', 'later'], storage),
    { draft: null, storageAvailable: true, stale: true },
  );
  assert.equal(storage.values.size, 0);
});

test('missing selected due words and invalid progress states are discarded', () => {
  const storage = createStorage();
  const draft = {
    version: 1,
    userId: 'user',
    wordIds: ['one', 'two'],
    currentIndex: 1,
    revealed: false,
  };
  saveQuickReviewDraft(draft, storage);
  assert.deepEqual(readQuickReviewDraft('user', ['one'], storage), {
    draft: null,
    storageAvailable: true,
    stale: true,
  });

  assert.equal(
    saveQuickReviewDraft({ ...draft, currentIndex: 2 }, storage),
    true,
    'writes are storage-level only; validation happens when restoring',
  );
  assert.deepEqual(readQuickReviewDraft('user', ['one', 'two'], storage), {
    draft: null,
    storageAvailable: true,
    stale: false,
  });
  assert.equal(storage.values.size, 0);
});

test('corrupt and unavailable storage do not break the practice flow', () => {
  const storage = createStorage();
  const draft = {
    version: 1,
    userId: 'user',
    wordIds: ['one'],
    currentIndex: 0,
    revealed: false,
  };
  saveQuickReviewDraft(draft, storage);
  const [key] = storage.values.keys();
  storage.setItem(key, '{broken');
  assert.deepEqual(readQuickReviewDraft('user', ['one'], storage), {
    draft: null,
    storageAvailable: true,
    stale: false,
  });
  assert.equal(storage.values.size, 0);

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
  assert.deepEqual(readQuickReviewDraft('user', ['one'], undefined), {
    draft: null,
    storageAvailable: false,
    stale: false,
  });
  assert.deepEqual(readQuickReviewDraft('user', ['one'], unavailable), {
    draft: null,
    storageAvailable: false,
    stale: false,
  });
  assert.equal(saveQuickReviewDraft(draft, unavailable), false);
  assert.equal(clearQuickReviewDraft('user', unavailable), false);
});

test('unexpected answer or meaning fields are neither persisted nor restored', () => {
  const storage = createStorage();
  const draft = {
    version: 1,
    userId: 'user',
    wordIds: ['one'],
    currentIndex: 0,
    revealed: false,
  };

  assert.equal(
    saveQuickReviewDraft({ ...draft, answer: 'my answer', meaning: 'a meaning' }, storage),
    true,
  );
  const [key, value] = storage.values.entries().next().value;
  assert.equal(value.includes('my answer'), false);
  assert.equal(value.includes('a meaning'), false);
  assert.deepEqual(readQuickReviewDraft('user', ['one'], storage), {
    draft,
    storageAvailable: true,
    stale: false,
  });

  storage.setItem(key, JSON.stringify({ ...draft, answer: 'unexpected' }));
  assert.deepEqual(readQuickReviewDraft('user', ['one'], storage), {
    draft: null,
    storageAvailable: true,
    stale: false,
  });
  assert.equal(storage.values.size, 0);
});

test('discarding a quick-review draft removes only the selected account snapshot', () => {
  const storage = createStorage();
  const draft = {
    version: 1,
    userId: 'user.a',
    wordIds: ['one'],
    currentIndex: 0,
    revealed: false,
  };
  saveQuickReviewDraft(draft, storage);
  saveQuickReviewDraft({ ...draft, userId: 'user.b' }, storage);

  assert.equal(clearQuickReviewDraft('user.a', storage), true);
  assert.deepEqual(readQuickReviewDraft('user.a', ['one'], storage), {
    draft: null,
    storageAvailable: true,
    stale: false,
  });
  assert.equal(readQuickReviewDraft('user.b', ['one'], storage).draft?.userId, 'user.b');
});
