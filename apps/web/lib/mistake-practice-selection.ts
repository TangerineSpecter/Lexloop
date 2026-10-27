export type MistakePracticeItem = {
  bookWordId: string;
  weaknesses: Array<{ questionType: string }>;
};

export type MistakePracticeSelection = {
  standardWordIds: string[];
  outputWordIds: string[];
  confusionWordIds: string[];
};

export function partitionMistakePracticeSelection(
  items: MistakePracticeItem[],
  selectedBookWordIds: string[],
): MistakePracticeSelection {
  const byId = new Map(items.map((item) => [item.bookWordId, item]));
  const selection: MistakePracticeSelection = {
    standardWordIds: [],
    outputWordIds: [],
    confusionWordIds: [],
  };

  for (const bookWordId of new Set(selectedBookWordIds)) {
    const item = byId.get(bookWordId);
    if (!item?.weaknesses.length) continue;

    const types = new Set(item.weaknesses.map((weakness) => weakness.questionType));
    const isSpecial = types.has('OUTPUT') || types.has('CONFUSION');
    if (types.has('OUTPUT')) selection.outputWordIds.push(bookWordId);
    if (types.has('CONFUSION')) selection.confusionWordIds.push(bookWordId);
    if (!isSpecial) selection.standardWordIds.push(bookWordId);
  }

  return selection;
}
