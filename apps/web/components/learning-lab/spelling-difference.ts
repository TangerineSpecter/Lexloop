export type SpellingDiffKind = 'match' | 'substitution' | 'extra' | 'missing';

export type SpellingDiffPart = {
  kind: SpellingDiffKind;
  value: string;
};

export type SpellingIssue =
  | { kind: 'substitution'; entered: string; expected: string }
  | { kind: 'extra'; entered: string }
  | { kind: 'missing'; expected: string };

export type SpellingDifference = {
  equal: boolean;
  alignable: boolean;
  normalizedAnswer: string;
  normalizedTarget: string;
  answerParts: SpellingDiffPart[];
  targetParts: SpellingDiffPart[];
  issues: SpellingIssue[];
};

const MAX_DIFF_CHARACTERS = 240;
const MAX_DIFF_CELLS = 60_000;

export function normalizeSpelling(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function repeatedPart(value: string, kind: SpellingDiffKind): SpellingDiffPart[] {
  return Array.from(value, (character) => ({ kind, value: character }));
}

export function compareSpelling(answer: string, target: string): SpellingDifference {
  const normalizedAnswer = normalizeSpelling(answer);
  const normalizedTarget = normalizeSpelling(target);
  const base = {
    normalizedAnswer,
    normalizedTarget,
  };

  if (normalizedAnswer === normalizedTarget) {
    return {
      ...base,
      equal: true,
      alignable: true,
      answerParts: repeatedPart(normalizedAnswer, 'match'),
      targetParts: repeatedPart(normalizedTarget, 'match'),
      issues: [],
    };
  }

  if (normalizedAnswer.length + normalizedTarget.length > MAX_DIFF_CHARACTERS) {
    return {
      ...base,
      equal: false,
      alignable: false,
      answerParts: [],
      targetParts: [],
      issues: [],
    };
  }

  const answerCharacters = Array.from(normalizedAnswer);
  const targetCharacters = Array.from(normalizedTarget);
  const answerLength = answerCharacters.length;
  const targetLength = targetCharacters.length;

  if (!answerLength) {
    const targetParts = repeatedPart(normalizedTarget, 'missing');
    return {
      ...base,
      equal: false,
      alignable: true,
      answerParts: [],
      targetParts,
      issues: targetCharacters.map((expected) => ({ kind: 'missing', expected })),
    };
  }

  if (!targetLength) {
    const answerParts = repeatedPart(normalizedAnswer, 'extra');
    return {
      ...base,
      equal: false,
      alignable: true,
      answerParts,
      targetParts: [],
      issues: answerCharacters.map((entered) => ({ kind: 'extra', entered })),
    };
  }

  const columns = targetLength + 1;
  const cellCount = (answerLength + 1) * columns;
  if (cellCount > MAX_DIFF_CELLS) {
    return {
      ...base,
      equal: false,
      alignable: false,
      answerParts: [],
      targetParts: [],
      issues: [],
    };
  }

  const distances = new Uint16Array(cellCount);
  const at = (row: number, column: number) => row * columns + column;
  for (let row = 0; row <= answerLength; row += 1) distances[at(row, 0)] = row;
  for (let column = 0; column <= targetLength; column += 1) distances[at(0, column)] = column;

  for (let row = 1; row <= answerLength; row += 1) {
    for (let column = 1; column <= targetLength; column += 1) {
      const substitutionCost = answerCharacters[row - 1] === targetCharacters[column - 1] ? 0 : 1;
      distances[at(row, column)] = Math.min(
        distances[at(row - 1, column)] + 1,
        distances[at(row, column - 1)] + 1,
        distances[at(row - 1, column - 1)] + substitutionCost,
      );
    }
  }

  const answerPartsReverse: SpellingDiffPart[] = [];
  const targetPartsReverse: SpellingDiffPart[] = [];
  const issuesReverse: SpellingIssue[] = [];
  let row = answerLength;
  let column = targetLength;

  while (row > 0 || column > 0) {
    const currentDistance = distances[at(row, column)];
    const diagonalDistance = row > 0 && column > 0 ? distances[at(row - 1, column - 1)] : -1;

    if (
      row > 0 &&
      column > 0 &&
      answerCharacters[row - 1] === targetCharacters[column - 1] &&
      currentDistance === diagonalDistance
    ) {
      answerPartsReverse.push({ kind: 'match', value: answerCharacters[row - 1] });
      targetPartsReverse.push({ kind: 'match', value: targetCharacters[column - 1] });
      row -= 1;
      column -= 1;
      continue;
    }

    if (row > 0 && column > 0 && currentDistance === diagonalDistance + 1) {
      const entered = answerCharacters[row - 1];
      const expected = targetCharacters[column - 1];
      answerPartsReverse.push({ kind: 'substitution', value: entered });
      targetPartsReverse.push({ kind: 'substitution', value: expected });
      issuesReverse.push({ kind: 'substitution', entered, expected });
      row -= 1;
      column -= 1;
      continue;
    }

    if (row > 0 && currentDistance === distances[at(row - 1, column)] + 1) {
      const entered = answerCharacters[row - 1];
      answerPartsReverse.push({ kind: 'extra', value: entered });
      issuesReverse.push({ kind: 'extra', entered });
      row -= 1;
      continue;
    }

    const expected = targetCharacters[column - 1];
    targetPartsReverse.push({ kind: 'missing', value: expected });
    issuesReverse.push({ kind: 'missing', expected });
    column -= 1;
  }

  return {
    ...base,
    equal: false,
    alignable: true,
    answerParts: answerPartsReverse.reverse(),
    targetParts: targetPartsReverse.reverse(),
    issues: issuesReverse.reverse(),
  };
}
