// Derived selected senses: Wiktionary contributors, CC BY-SA 4.0.
// Provenance: data/vocabulary-corrections/2026-11-03-supplement; /vocabulary-sources.
export const SUPPLEMENT_MEANING_BATCH = 'daily-supplement-meanings-2026-11-03-v1';
export const SUPPLEMENT_MEANINGS = [
  {
    word: 'surname',
    meaning: 'n. 姓氏',
    sourceKeys: [
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/考研/2022考研核心1374词.xlsx',
      '考试/英语专业四八级/专四词汇.xlsx',
      '通用/日常生活单词.xlsx',
    ],
  },
  {
    word: 'toe',
    meaning: 'n. 脚趾',
    sourceKeys: [
      '大学/新视野大学英语读写教程（第三版）/新视野大学英语读写教程2（第三版）.xlsx',
      '考试/专升本/专升本词汇.xlsx',
      '考试/大学英语四六级/六级考纲词汇.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/英语专业四八级/专四词汇.xlsx',
      '通用/日常生活单词.xlsx',
    ],
  },
  {
    word: 'divorced',
    meaning: 'adj. 离了婚的',
    sourceKeys: ['通用/日常生活单词.xlsx'],
  },
  {
    word: 'boyfriend',
    meaning: 'n. 男朋友',
    sourceKeys: ['通用/日常生活单词.xlsx'],
  },
  {
    word: 'heterosexual',
    meaning: 'adj. 异性恋的',
    sourceKeys: ['通用/日常生活单词.xlsx'],
  },
  {
    word: 'contraceptive',
    meaning: 'n. 避孕药；避孕用具',
    sourceKeys: ['考试/英语专业四八级/专八词汇.xlsx', '通用/日常生活单词.xlsx'],
  },
  {
    word: 'hairdo',
    meaning: 'n. 发型',
    sourceKeys: ['考试/英语专业四八级/专八词汇.xlsx', '通用/日常生活单词.xlsx'],
  },
] as const;

export function reviewedSupplementMeaning(word: string) {
  return SUPPLEMENT_MEANINGS.find((entry) => entry.word === word)?.meaning ?? null;
}
