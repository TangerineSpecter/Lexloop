import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasUsableWordMeaning } from '../lib/word-meaning-availability.ts';

test('meaning availability excludes blanks and explicit placeholders', () => {
  for (const meaning of [undefined, null, '', '   ', '无', 'n. 无', '暂无释义', 'v. 暂无释义']) {
    assert.equal(hasUsableWordMeaning({ meaning }), false, String(meaning));
  }
});

test('meaning availability accepts contextual and legacy gloss formats', () => {
  assert.equal(hasUsableWordMeaning({ meaning: 'adj. 平稳的；持续的' }), true);
  assert.equal(hasUsableWordMeaning({ meanings: [{ part: 'n.', text: '对应关系' }] }), true);
  assert.equal(
    hasUsableWordMeaning({ meaning: '暂无释义', meanings: [{ part: 'v.', text: '映射' }] }),
    true,
  );
  assert.equal(
    hasUsableWordMeaning({ meaning: '稳定的', meanings: [{ part: 'n.', text: '暂无释义' }] }),
    false,
    'an explicit parsed meaning list takes precedence over its legacy display string',
  );
});
