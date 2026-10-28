import { StudyPlanMode, StudyPlanPurpose } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { contentSignature } from '../src/modules/study/study.service';

describe('study content signatures with word levels', () => {
  const words = [
    { id: 'book-word-2', word: 'blue', part: 'adj.', meaning: '蓝色的' },
    { id: 'book-word-1', word: 'red', part: 'adj.', meaning: '红色的' },
  ];

  it('isolates known word levels while preserving cache keys for unknown levels', () => {
    const legacyUnknownLevelSignature =
      '2a3cc7e5134b863003ea0438ee2157e981a00b1f788b82015f54b29718b107bd';
    expect(contentSignature(StudyPlanMode.GROUP, words)).toBe(legacyUnknownLevelSignature);
    expect(
      contentSignature(StudyPlanMode.GROUP, [{ ...words[0], cefrLevel: null }, words[1]]),
    ).toBe(legacyUnknownLevelSignature);

    const a2 = [{ ...words[0], cefrLevel: 'A2' }, words[1]];
    const b1 = [{ ...words[0], cefrLevel: 'B1' }, words[1]];
    expect(contentSignature(StudyPlanMode.GROUP, a2)).not.toBe(legacyUnknownLevelSignature);
    expect(contentSignature(StudyPlanMode.GROUP, a2)).not.toBe(
      contentSignature(StudyPlanMode.GROUP, b1),
    );
    expect(contentSignature(StudyPlanMode.GROUP, a2)).toBe(
      contentSignature(StudyPlanMode.GROUP, [...a2].reverse()),
    );

    const weakness = contentSignature(StudyPlanMode.GROUP, a2, StudyPlanPurpose.WEAKNESS, {
      'book-word-1': 'MEANING_RECOGNITION',
    });
    expect(weakness).not.toBe(contentSignature(StudyPlanMode.GROUP, a2));
  });
});
