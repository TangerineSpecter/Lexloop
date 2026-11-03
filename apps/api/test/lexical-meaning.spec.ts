import { describe, expect, it } from 'vitest';
import {
  lexicalFields,
  parseMeaningLines,
  presentLexicalWord,
  normalizePhonetic,
} from '../src/modules/vocabulary/lexical';

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

describe('phonetic presentation', () => {
  it('normalizes paired notation without fabricating missing pronunciation', () => {
    expect(
      presentLexicalWord({
        text: 'chair',
        meaning: '椅子',
        ukPhonetic: ' [tʃeə] ',
        usPhonetic: '/tʃer/',
      }),
    ).toMatchObject({ ukPhonetic: 'tʃeə', usPhonetic: 'tʃer' });
    expect(
      presentLexicalWord({ text: 'chair', meaning: null, ukPhonetic: '无', usPhonetic: '' }),
    ).toMatchObject({ ukPhonetic: null, usPhonetic: null });
  });
});

it.each(['[tʃeə', 'tʃeə]', '[读音待确认]', '/tʃeə/ UK', '[tʃeə (UK)]'])(
  'preserves ambiguous source notation %s',
  (value) => {
    expect(normalizePhonetic(value)).toBe(value);
  },
);
