import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { VOCABULARY_CORRECTIONS } from '../src/modules/vocabulary/vocabulary-corrections.batch';
import { normalizePhonetic } from '../src/modules/vocabulary/lexical';
it('ships precisely the reviewed source fields with no invented regional IPA', () => {
  const manifest = JSON.parse(
    readFileSync(
      join(process.cwd(), '../../data/vocabulary-corrections/2026-11-03/manifest.json'),
      'utf8',
    ),
  );
  expect(VOCABULARY_CORRECTIONS).toEqual(
    manifest.entries.map((e: { word: string; changes: Array<{ column: string; to: string }> }) =>
      Object.fromEntries([
        ['word', e.word],
        ...e.changes.map((c) => [
          ({ 释义: 'meaning', 英音: 'ukPhonetic', 美音: 'usPhonetic' } as Record<string, string>)[
            c.column
          ],
          c.column === '释义' ? c.to : normalizePhonetic(c.to),
        ]),
      ]),
    ),
  );
});
