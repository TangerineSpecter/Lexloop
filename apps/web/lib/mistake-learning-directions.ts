export type MistakeLearningDirection = {
  label: string;
  focus: string;
  nextStep: string;
  route?: { href: string; label: string };
};

export const MISTAKE_LEARNING_DIRECTIONS = {
  WORD_MNEMONIC: {
    label: '单词助记',
    focus: '通过词根、词缀、派生关系或词形联想建立记忆线索。',
    nextStep: '可选中此词生成同题型变式；它会使用新的语境，不会改写这条历史作答。',
  },
  MEANING_RECOGNITION: {
    label: '词义识别',
    focus: '在完整英文句子的语境中辨认目标词此处的词义。',
    nextStep: '可选中此词生成同题型变式；它会使用新的语境，不会改写这条历史作答。',
  },
  WORD_MATCHING: {
    label: '单词匹配',
    focus: '比较同一目标词在不同短语或固定搭配中的用法。',
    nextStep: '可选中此词生成同题型变式；它会使用新的语境，不会改写这条历史作答。',
  },
  SYNONYM_REPLACEMENT: {
    label: '同义替换',
    focus: '判断近义表达在当前句子的意思、词性和搭配中能否替换。',
    nextStep: '可选中此词生成同题型变式；它会使用新的语境，不会改写这条历史作答。',
  },
  READING_COMPREHENSION: {
    label: '阅读理解',
    focus: '按原题题干，从短文中定位信息或理解目标词的语境含义。',
    nextStep: '可选中此词生成同题型变式；具体检查点以本题保存的题干和解析为准。',
  },
  OUTPUT: {
    label: '每日输出',
    focus: '按主题主动写英文，并在表达中使用目标词。',
    nextStep: '每日输出栏目会按自己的规则推荐目标词；这条错题的选择不会自动带入。',
    route: { href: '/dashboard/practice?tab=output', label: '打开每日输出' },
  },
  CONFUSION: {
    label: '易混词辨析',
    focus: '在句子里区分易混词的词义、词性或常见搭配。',
    nextStep: '易混词栏目会按自己的规则推荐对比组；这条错题的选择不会自动带入。',
    route: { href: '/dashboard/practice?tab=confusion', label: '打开易混词训练' },
  },
} as const satisfies Record<string, MistakeLearningDirection>;

export type KnownMistakeQuestionType = keyof typeof MISTAKE_LEARNING_DIRECTIONS;

export function getMistakeLearningDirection(questionType: string): MistakeLearningDirection | null {
  return Object.hasOwn(MISTAKE_LEARNING_DIRECTIONS, questionType)
    ? MISTAKE_LEARNING_DIRECTIONS[questionType as KnownMistakeQuestionType]
    : null;
}
