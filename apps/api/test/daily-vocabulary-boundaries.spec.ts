import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { expect, it } from 'vitest';
import {
  DAILY_BOUNDARY_REPAIRS,
  repairDailyBoundaries,
} from '../src/modules/vocabulary/daily-vocabulary-boundaries';
function sourceRows() {
  const w = XLSX.read(
    readFileSync(join(process.cwd(), 'assets/vocabulary/通用/日常生活单词.xlsx')),
  );
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(w.Sheets[w.SheetNames[0]], {
    defval: '',
  });
}
it('repairs only five explicitly reviewed lists, preserves real phrases and adds no meaning or IPA', () => {
  const rows = sourceRows();
  const before = structuredClone(rows);
  const result = repairDailyBoundaries(rows);
  expect(rows).toEqual(before);
  expect(result).toHaveLength(1189);
  expect(new Set(result.map((r) => r['单词'])).size).toBe(1189);
  for (const phrase of ['human body', 'skin cell', 'letter call sign', 'brain console'])
    expect(result.find((r) => r['单词'] === phrase)).toEqual(
      rows.find((r) => r['单词'] === phrase),
    );
  for (const r of DAILY_BOUNDARY_REPAIRS) {
    expect(result.some((row) => row['单词'] === r.original)).toBe(false);
    for (const word of r.entries)
      expect(result.find((row) => row['单词'] === word)).toEqual({
        单词: word,
        英音: '无',
        美音: '无',
        释义: '无',
      });
  }
  expect(DAILY_BOUNDARY_REPAIRS.reduce((n, r) => n + r.entries.length, 0)).toBe(17);
});
it('rejects shifted rows and newly supplied fields rather than discarding content or guessing a split', () => {
  for (const field of ['单词', '释义', '英音', '美音']) {
    const rows = sourceRows();
    rows[5][field] = '已有内容';
    expect(() => repairDailyBoundaries(rows)).toThrow('source changed');
  }
  const unrelated = sourceRows();
  unrelated[100]['单词'] = 'a changed word outside the five rows';
  expect(() => repairDailyBoundaries(unrelated)).toThrow('source changed');
  const rows = sourceRows();
  rows.splice(0, 0, rows[0]);
  expect(() => repairDailyBoundaries(rows)).toThrow('source changed');
});
