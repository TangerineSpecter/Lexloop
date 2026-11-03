import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { normalizedMeaningLine } from '../src/modules/vocabulary/meaning-sql';
import { parseMeaningLines } from '../src/modules/vocabulary/lexical';

describe.skipIf(!process.env.LAB_TEST_DATABASE_URL)(
  'meaning availability SQL and display parity',
  () => {
    it('trims before POS removal for normal, placeholder and Unicode-space lines', async () => {
      const prisma = new PrismaClient({
        datasources: { db: { url: process.env.LAB_TEST_DATABASE_URL! } },
      });
      try {
        for (const raw of [
          null,
          '',
          '无',
          '  n. 无',
          '\tadj. 暂无释义  ',
          '\u3000n.\u00a0无\ufeff',
          '  n. ',
          ' n. 修理 ',
          ' \u00a0VT.\u3000修理\u202f',
          '没有词性前缀的释义',
        ]) {
          const rows = await prisma.$queryRaw<Array<{ normalized: string | null }>>(
            Prisma.sql`SELECT ${normalizedMeaningLine} AS normalized FROM (VALUES (${raw}::text)) AS meaning_line(value)`,
          );
          const expected = parseMeaningLines(raw)[0]?.text ?? '';
          // Bare 无 is deliberately removed by parseMeaningLines; both sides classify it missing.
          const usable = (value: string) => value !== '' && value !== '无' && value !== '暂无释义';
          expect(usable(rows[0].normalized ?? '')).toBe(usable(expected));
          if (raw !== '无') expect(rows[0].normalized ?? '').toBe(expected);
        }
      } finally {
        await prisma.$disconnect();
      }
    });
  },
);
