import { createHash } from 'node:crypto';
import manifest from './v1-daily-vocabulary-boundaries.json';
// Boundary-only repair of pre-import source defects. No definitions/IPA are generated.
export const DAILY_SOURCE_KEY = manifest.sourceKey;
export const DAILY_BOUNDARY_REVISION = manifest.revision;
export const DAILY_BOUNDARY_REPAIRS = manifest.repairs;

export function repairDailyBoundaries(rows: Record<string, unknown>[]) {
  // Positions are part of the revision: unrelated source word/order drift also blocks import.
  if (
    createHash('sha256')
      .update(JSON.stringify(rows.map((row) => row['单词'])))
      .digest('hex') !== manifest.sourceWordSequenceSha256
  )
    throw new Error('Daily vocabulary boundary source changed; review the boundary manifest');
  // Verify the whole patch before returning any replacement. Never discard known content.
  for (const repair of DAILY_BOUNDARY_REPAIRS) {
    const row = rows[repair.row - 2];
    if (
      row?.['单词'] !== repair.original ||
      !['释义', '英音', '美音'].every(
        (field) =>
          row[field] === null ||
          row[field] === undefined ||
          String(row[field]).trim() === '' ||
          row[field] === '无',
      )
    )
      throw new Error('Daily vocabulary boundary source changed; review the boundary manifest');
  }
  return rows.flatMap((row, index) => {
    const repair = DAILY_BOUNDARY_REPAIRS.find((r) => r.row === index + 2);
    return repair ? repair.entries.map((word) => ({ ...row, 单词: word })) : [row];
  });
}
