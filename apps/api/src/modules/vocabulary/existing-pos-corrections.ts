import { DAILY_ENRICHMENTS } from './daily-enrichment';
import { USAGE_CLARITY_CORRECTIONS } from './usage-clarity-corrections';
import { VERB_SENSE_CORRECTIONS } from './verb-sense-corrections';
// Exact editorial corrections; originals, source rows and factual references:
// data/vocabulary-corrections/2026-11-03-pos-review. No upstream definitions copied.
export const EXISTING_POS_BATCH = 'daily-existing-pos-2026-11-03-v1';
export const EXISTING_POS_CORRECTIONS = [
  {
    word: 'beautiful',
    expectedMeaning: 'adj. 美丽的\n出色地\n出色的\n迷人的\n迷人地',
    meaning: 'adj. 美丽的\n出色的\n迷人的',
    sourceKeys: [
      '初中/人教版/人教版初中英语七年级下册.xlsx',
      '初中/外研版/外研版初中英语七年级上册.xlsx',
      '初中/外研版/外研版初中英语七年级下册.xlsx',
      '小学/人教版/三年级下.xlsx',
      '教材/新概念英语/新概念英语第一册（新版）.xlsx',
      '考试/专升本/专升本词汇.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/留学与职业考试/SAT巴朗.xlsx',
      '考试/高考/高考3500词.xlsx',
    ],
  },
  {
    word: 'deliver',
    expectedMeaning:
      'n. 投球\nvt. 交付；发表；递送；释放；给予（打击）；给…接生\nvi. 实现；传送；履行；投递',
    meaning:
      'vt. 投球\nvt. 交付；发表；递送；释放；给予（打击）；给…接生\nvi. 实现；传送；履行；投递',
    sourceKeys: [
      '考试/专升本/专升本词汇.xlsx',
      '考试/商务英语（BEC）/BEC中级.xlsx',
      '考试/商务英语（BEC）/BEC初级.xlsx',
      '考试/大学英语四六级/六级核心单词2022新版.xlsx',
      '考试/大学英语四六级/四级核心单词2022新版.xlsx',
      '考试/大学英语四六级/四级考纲词汇.xlsx',
      '考试/托福雅思/TOEFL词汇乱序版.xlsx',
      '考试/托福雅思/雅思词汇乱序便携版.xlsx',
      '考试/托福雅思/雅思词汇乱序版.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/考研/2023考研核心1864词.xlsx',
      '考试/考研/2023考研核心1864词/Day5.xlsx',
      '考试/考研/2023马天艺考研英语单词之间.xlsx',
      '考试/英语专业四八级/专四词汇.xlsx',
      '考试/高考/高考3500词.xlsx',
      '考试/高考/高考历年真题核心高频688.xlsx',
      '高中/人教版（2019版）/人教版高中英语必修第一册.xlsx',
      '高中/人教版（旧课标）/人教版高中英语4 - 必修.xlsx',
      '高中/外研版（2019版）/外研版高中英语必修第一册.xlsx',
    ],
  },
] as const;

export function reviewedExistingMeaning(word: string, sourceKey: string, meaning: string | null) {
  const correction = [
    ...EXISTING_POS_CORRECTIONS,
    ...VERB_SENSE_CORRECTIONS,
    ...USAGE_CLARITY_CORRECTIONS,
    ...DAILY_ENRICHMENTS,
  ].find(
    (entry) =>
      entry.word === word &&
      entry.sourceKeys.some((key) => key === sourceKey) &&
      entry.expectedMeaning === meaning,
  );
  return correction?.meaning ?? meaning;
}
