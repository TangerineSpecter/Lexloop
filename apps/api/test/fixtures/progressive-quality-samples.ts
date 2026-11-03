// Original synthetic regression materials; not an external dictionary or certified level corpus.
export const progressiveQualitySamples = {
  foundation: {
    word: { id: 'word-available', word: 'available', part: 'adj.', meaning: '可用的' },
    group: {
      index: 0,
      title: 'A free chair',
      wordOccurrences: { available: 1 },
      sentences: [
        {
          english: 'The chair is available now.',
          chinese: '这把椅子现在可以使用。',
          simplified: '这把椅子现在可用。',
          grammar: '形容词 available 描述椅子的状态。',
        },
        {
          english: 'Please take a seat.',
          chinese: '请坐。',
          simplified: '请坐。',
          grammar: '祈使句表示礼貌请求。',
        },
      ],
      questions: [
        {
          bookWordId: 'word-available',
          type: 'MEANING_RECOGNITION' as const,
          prompt: 'What does “available” mean for the chair?',
          options: ['可用的', '昂贵的', '损坏的', '遥远的'],
          correctAnswers: ['可用的'],
          explanation: '句子说椅子现在可用，所以有人可以坐下。',
        },
      ],
    },
  },
  context: {
    word: { id: 'word-repair', word: 'repair', part: 'v.', meaning: '修理' },
    group: {
      index: 0,
      title: 'A radio at the shop',
      wordOccurrences: { repair: 1 },
      sentences: [
        {
          english:
            'The shop will repair Mia’s old radio before Friday and call her when it is ready.',
          chinese: '商店会在周五前修好米娅的旧收音机，准备好后给她打电话。',
          simplified: '商店会在周五前修理米娅的旧收音机，准备好后给她打电话。',
          grammar: 'will repair 表示将来会进行的维修。',
        },
        {
          english: 'She can collect it then.',
          chinese: '她到时可以去取。',
          simplified: '她到时可以去取。',
          grammar: '情态动词 can 表示可以做某事。',
        },
      ],
      questions: [
        {
          bookWordId: 'word-repair',
          type: 'SYNONYM_REPLACEMENT' as const,
          prompt: 'Which word can replace “repair” in this sentence?',
          options: ['fix', 'replace', 'borrow', 'paint'],
          correctAnswers: ['fix'],
          explanation: '此处商店要让收音机恢复可用，fix 可替换 repair；其余词改变了动作。',
        },
      ],
    },
  },
  transfer: {
    word: { id: 'word-repair', word: 'repair', part: 'v.', meaning: '修理' },
    group: {
      index: 0,
      title: 'A lamp at the repair shop',
      wordOccurrences: { repair: 1 },
      sentences: [
        {
          english:
            'Mara asked the worker to repair her lamp on Monday, but he could not test it because the electricity was off.',
          chinese: '周一，玛拉请店员修理她的灯，但因为停电，他无法测试它。',
          simplified: '周一，玛拉请店员 repair 她的灯，但因为停电，他无法测试它。',
          grammar: 'because 引导原因从句，说明无法测试的原因。',
        },
        {
          english: 'He asked her to return Tuesday morning, when the power would be back.',
          chinese: '他请她周二早上再来，那时供电会恢复。',
          simplified: '他请她周二早上再来，那时供电会恢复。',
          grammar: 'when 引导时间从句，说明再次到店的时间。',
        },
        {
          english: 'After finding a loose wire, he fixed the lamp and called Mara before noon.',
          chinese: '发现一根松动的电线后，他修好了灯，并在中午前给玛拉打了电话。',
          simplified: '发现一根松动的电线后，他修好了灯，并在中午前给玛拉打了电话。',
          grammar: 'After 引导时间状语，fixed 表示已完成的维修。',
        },
      ],
      questions: [
        {
          bookWordId: 'word-repair',
          type: 'READING_COMPREHENSION' as const,
          prompt: 'Why did the worker ask Mara to return Tuesday morning?',
          options: [
            'The power would be back, so he could test the lamp.',
            'The shop would move to another street.',
            'Mara needed to bring a different lamp.',
            'The worker planned to buy the lamp.',
          ],
          correctAnswers: ['The power would be back, so he could test the lamp.'],
          explanation: '周一停电，店员无法测试；周二供电恢复后才能继续检查。',
        },
      ],
    },
  },
};
