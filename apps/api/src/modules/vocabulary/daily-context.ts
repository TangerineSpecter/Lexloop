// Added senses and usage adapted from Wiktionary contributors, CC BY-SA 4.0.
// Attribution and revision links: data/vocabulary-corrections/2026-11-03-context
// and /vocabulary-sources. Commercial secondary reference checks grammar only.
export const DAILY_CONTEXT_BATCH = 'daily-context-2026-11-03-v1';
export const DAILY_CONTEXT_ADDITIONS = [
  {
    word: 'climb',
    expectedMeaning: 'n. 爬；攀登\nvi. 爬；攀登；上升\nvt. 爬；攀登；上升',
    meaning:
      'n. 爬；攀登\nvi. 爬；攀登；上升\nvt. 爬；攀登；上升\n用法：climb 可指借助手脚向上或向下移动，并非总是上升。',
    sourceKeys: [
      '初中/人教版/人教版初中英语七年级下册.xlsx',
      '初中/外研版/外研版初中英语八年级上册.xlsx',
      '初中/沪教版/沪教版牛津英语七年级下册.xlsx',
      '教材/新概念英语/新概念英语第一册（新版）.xlsx',
      '考试/专升本/专升本词汇.xlsx',
      '考试/商务英语（BEC）/BEC初级.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/留学与职业考试/SAT巴朗.xlsx',
      '考试/高考/高考3500词.xlsx',
    ],
  },
  {
    word: 'limb',
    expectedMeaning: '肢',
    meaning: '肢\nn. 树枝',
    sourceKeys: [
      '大学/新视野大学英语读写教程（第三版）/新视野大学英语读写教程1（第三版）.xlsx',
      '考试/大学英语四六级/六级核心单词.xlsx',
      '考试/大学英语四六级/六级考纲词汇.xlsx',
      '考试/大学英语四六级/四级核心单词.xlsx',
      '考试/大学英语四六级/四级考纲词汇.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/英语专业四八级/专四词汇.xlsx',
    ],
  },
  {
    word: 'graveyard',
    expectedMeaning: 'n. 墓地',
    meaning: 'n. 墓地\nn. 〈比喻〉废弃物集中存放处',
    sourceKeys: ['考试/考研/2023马天艺考研英语单词之间.xlsx'],
  },
  {
    word: 'bone',
    expectedMeaning: 'n. 骨；骨骼\nvt. 剔去...的骨；施骨肥于\nvi. 苦学；专心致志',
    meaning:
      'n. 骨；骨骼\nvt. 剔去...的骨；施骨肥于\nvi. 苦学；专心致志\n搭配：bone up on ...〈俚〉复习、钻研……。',
    sourceKeys: [
      '教材/新概念英语/新概念英语第一册（新版）.xlsx',
      '考试/专升本/专升本词汇.xlsx',
      '考试/大学英语四六级/四级考纲词汇.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/高考/高考3500词.xlsx',
      '高中/人教版（2019版）/人教版高中英语必修第一册.xlsx',
      '高中/人教版（旧课标）/人教版高中英语3 - 必修.xlsx',
      '高中/外研版（2019版）/外研版高中英语必修第二册.xlsx',
    ],
  },
  {
    word: 'foot',
    expectedMeaning: 'n. 脚；英尺；步调；末尾\nvt. 支付；给……换底\nvi. 步行；跳舞；总计',
    meaning:
      'n. 脚；英尺；步调；末尾\nvt. 支付；给……换底\nvi. 步行；跳舞；总计\n搭配：foot up to ... 合计达……。',
    sourceKeys: [
      '初中/人教版/人教版初中英语八年级下册.xlsx',
      '初中/外研版/外研版初中英语七年级下册.xlsx',
      '小学/人教版/三年级上.xlsx',
      '考试/专升本/专升本词汇.xlsx',
      '考试/留学与职业考试/MBA单词.xlsx',
      '考试/英语专业四八级/专八词汇.xlsx',
      '考试/高考/高考3500词.xlsx',
    ],
  },
] as const;
