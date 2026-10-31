export function emptyStudyGuide(input: {
  reviewCount: number;
  weakFocusCount: number | undefined;
  newWordCount: number;
}) {
  if (input.reviewCount !== 0 || input.weakFocusCount !== 0) return null;
  if (!Number.isSafeInteger(input.newWordCount) || input.newWordCount < 0) return null;
  if (input.newWordCount > 0) {
    return '今天没有到期词，也没有待练错题。用上面的「创建学习计划」从新词开始就行。';
  }
  return '今天没有到期词，也没有待练错题。可以用侧栏切换词书，或等已安排的复习到期。';
}
