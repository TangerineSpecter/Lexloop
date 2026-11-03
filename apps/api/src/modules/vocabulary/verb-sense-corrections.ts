// Exact edits of existing project text; factual references and originals:
// data/vocabulary-corrections/2026-11-03-verb-review. No upstream definitions copied.
export const VERB_SENSE_BATCH = 'daily-verb-senses-2026-11-03-v1';
export const VERB_SENSE_CORRECTIONS = [
  {
    word: 'kick',
    expectedMeaning: 'vt. 踢；反冲，朝后座\nn. 踢；反冲，后座力\nvi. 踢；反冲',
    meaning: 'vt. 踢\nn. 踢；反冲，后座力\nvi. 踢；反冲',
    sourceKeys: [
      '初中/人教版/人教版初中英语九年级全册.xlsx',
      '初中/外研版/外研版初中英语九年级上册.xlsx',
      '初中/沪教版/沪教版牛津英语七年级上册.xlsx',
      '教材/新概念英语/新概念英语第二册（新版）.xlsx',
      '考试/专升本/专升本词汇.xlsx',
      '考试/商务英语（BEC）/BEC初级.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/英语专业四八级/专四词汇.xlsx',
      '考试/高考/高考3500词.xlsx',
    ],
  },
  {
    word: 'whistle',
    expectedMeaning: 'n. 口哨；汽笛；呼啸声\nvt. 吹口哨；鸣汽笛',
    meaning: 'n. 口哨；汽笛；呼啸声\nvi. 吹口哨；鸣汽笛',
    sourceKeys: [
      '考试/大学英语四六级/四级考纲词汇.xlsx',
      '考试/托福雅思/雅思词汇乱序便携版.xlsx',
      '考试/托福雅思/雅思词汇乱序版.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/英语专业四八级/专四词汇.xlsx',
      '考试/高考/高考3500词.xlsx',
      '高中/人教版（2019版）/人教版高中英语必修第一册.xlsx',
      '高中/人教版（旧课标）/人教版高中英语11 - 选修.xlsx',
      '高中/人教版（旧课标）/人教版高中英语8 - 选修.xlsx',
      '高中/外研版（旧课标）/外研版高中英语 必修5.xlsx',
    ],
  },
] as const;
