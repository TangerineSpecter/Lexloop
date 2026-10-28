import { describe, expect, it } from 'vitest';
import { lexicalFields, parseMeaningLines } from '../src/modules/vocabulary/lexical';

describe('lexical meaning lines', () => {
  it('keeps one part of speech per line and does not fold later parts into the first gloss', () => {
    const raw = 'n. 常规，惯例；生活乏味\nadj. 常规的，例行的\nv. <罕> 按惯例安排';
    expect(parseMeaningLines(raw)).toEqual([
      { part: 'n.', text: '常规，惯例；生活乏味' },
      { part: 'adj.', text: '常规的，例行的' },
      { part: 'v.', text: '<罕> 按惯例安排' },
    ]);
    expect(lexicalFields(raw)).toMatchObject({
      part: 'n.',
      meaning: 'n. 常规，惯例；生活乏味\nadj. 常规的，例行的\nv. <罕> 按惯例安排',
    });
  });

  it('keeps a single part-of-speech gloss compatible with the previous meaning string', () => {
    expect(lexicalFields('vt. 帮助')).toEqual({
      part: 'vt.',
      meaning: '帮助',
      meanings: [{ part: 'vt.', text: '帮助' }],
    });
    expect(lexicalFields('平稳的')).toEqual({
      part: '',
      meaning: '平稳的',
      meanings: [{ part: '', text: '平稳的' }],
    });
    expect(lexicalFields(null).meaning).toBe('暂无释义');
    expect(lexicalFields('无').meanings).toEqual([]);
  });
});
