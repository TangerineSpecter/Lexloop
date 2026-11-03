import { Prisma } from '@prisma/client';

// JavaScript trim()/\s whitespace, including NBSP and full-width space.
// Callers expose each definition line as meaning_line.value.
const whitespace = '[\u0009-\u000d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';
const trimPattern = `^${whitespace}+|${whitespace}+$`;
const partPattern = `^(adj|adv|n|v|vi|vt|prep|pron|conj|num|art|aux|int)[.]${whitespace}*`;

/** Same order as parseMeaningLines: trim the line, then remove its optional POS. */
export const normalizedMeaningLine = Prisma.sql`
  REGEXP_REPLACE(
    REGEXP_REPLACE(meaning_line.value, ${trimPattern}, '', 'g'),
    ${partPattern}, '', 'i'
  )
`;
