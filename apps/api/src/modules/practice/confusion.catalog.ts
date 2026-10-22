import type { ContrastWord } from '@lexloop/types';

type Question = { id: string; sentence: string; answer: string; explanation: string };
export type CatalogGroup = {
  id: string;
  title: string;
  note: string;
  words: ContrastWord[];
  questions: Question[];
};
function pair(
  id: string,
  left: ContrastWord,
  right: ContrastWord,
  prompts: Array<[string, string, string]>,
): CatalogGroup {
  return {
    id,
    title: `${left.word} / ${right.word}`,
    note: '先做语境填空，再查看对比笔记。',
    words: [left, right],
    questions: prompts.map(([sentence, answer, explanation], index) => ({
      id: `${id}-${index + 1}`,
      sentence,
      answer,
      explanation,
    })),
  };
}
export const CONFUSION_CATALOG: CatalogGroup[] = [
  pair(
    'affect-effect',
    {
      word: 'affect',
      meaning: 'v. 影响',
      rule: '常用作动词，后接受到影响的对象。',
      example: 'The weather can affect our plans.',
    },
    {
      word: 'effect',
      meaning: 'n. 影响；结果',
      rule: '常用作名词，常见搭配 have an effect on。',
      example: 'Sleep has an effect on memory.',
    },
    [
      ['The noise may ___ your concentration.', 'affect', 'may 后接动词原形，表示影响专注力。'],
      [
        'The medicine had a positive ___ on her health.',
        'effect',
        'a positive 后需要名词，构成 have an effect on。',
      ],
      ['Does the price ___ your decision?', 'affect', 'does 后接动词原形，decision 是宾语。'],
      [
        'We are studying the ___ of light on sleep.',
        'effect',
        'the effect of ... 表示某事的影响。',
      ],
    ],
  ),
  pair(
    'borrow-lend',
    {
      word: 'borrow',
      meaning: 'v. 借入',
      rule: '以借入者为主语：borrow something from someone。',
      example: 'I borrow books from the library.',
    },
    {
      word: 'lend',
      meaning: 'v. 借出',
      rule: '以借出者为主语：lend someone something。',
      example: 'Can you lend me a pen?',
    },
    [
      ['Could I ___ your dictionary for a minute?', 'borrow', 'I 是借入者。'],
      ['Could you ___ me your dictionary?', 'lend', 'you 是借出者，后接 me 和物品。'],
      ['We sometimes ___ tools from our neighbors.', 'borrow', 'from 提示物品的来源。'],
      ['Banks ___ money to businesses.', 'lend', '银行把钱借出去，lend ... to ...。'],
    ],
  ),
  pair(
    'rise-raise',
    {
      word: 'rise',
      meaning: 'v. 上升；升起',
      rule: '不及物，后面不直接接宾语。',
      example: 'Prices rise every year.',
    },
    {
      word: 'raise',
      meaning: 'v. 举起；提高',
      rule: '及物，需要动作作用的对象。',
      example: 'Please raise your hand.',
    },
    [
      ['Please ___ your hand before speaking.', 'raise', 'your hand 是宾语，用 raise。'],
      ['Warm air tends to ___.', 'rise', '空气自己上升，没有直接宾语。'],
      ['The company plans to ___ salaries.', 'raise', '公司提高工资，salaries 是宾语。'],
      ['Water levels may ___ after heavy rain.', 'rise', '水位自行上涨。'],
    ],
  ),
  pair(
    'say-tell',
    {
      word: 'say',
      meaning: 'v. 说',
      rule: '侧重说出的内容；对某人说用 say ... to someone。',
      example: 'What did she say?',
    },
    {
      word: 'tell',
      meaning: 'v. 告诉；讲述',
      rule: '告诉某人内容：tell someone something；另有 tell a story。',
      example: 'Please tell me the truth.',
    },
    [
      ['Please ___ me your name.', 'tell', 'tell 后可以直接接人 me。'],
      ['What did he ___ about the plan?', 'say', '询问说了什么内容，用 say。'],
      ['Can you ___ us a story?', 'tell', 'tell someone a story 是常见搭配。'],
      ['Did she ___ hello to you?', 'say', 'say hello to someone。'],
    ],
  ),
  pair(
    'accept-except',
    {
      word: 'accept',
      meaning: 'v. 接受',
      rule: '动词，后接邀请、建议或物品等。',
      example: 'I accept your invitation.',
    },
    {
      word: 'except',
      meaning: 'prep. 除……之外',
      rule: '表示从整体中排除某个成员。',
      example: 'Everyone came except Tom.',
    },
    [
      ['Will you ___ the invitation?', 'accept', '接受邀请需要动词 accept。'],
      ['The shop opens every day ___ Sunday.', 'except', '排除星期日。'],
      ['We cannot ___ damaged goods.', 'accept', '接受货物，用动词 accept。'],
      ['Everyone agreed ___ one person.', 'except', '从所有人中排除一人。'],
    ],
  ),
  pair(
    'adapt-adopt',
    {
      word: 'adapt',
      meaning: 'v. 适应；改编',
      rule: 'adapt to 表示适应；adapt ... for 表示为某用途改编。',
      example: 'It takes time to adapt to a new job.',
    },
    {
      word: 'adopt',
      meaning: 'v. 采用；收养',
      rule: '采用方法、政策，或收养孩子、动物。',
      example: 'We should adopt a new approach.',
    },
    [
      ['We need to ___ to the new schedule.', 'adapt', 'adapt to 表示适应。'],
      ['The team will ___ a new strategy.', 'adopt', '采用策略，用 adopt。'],
      ['They hope to ___ a child.', 'adopt', '收养孩子，用 adopt。'],
      [
        'We must ___ the material for younger readers.',
        'adapt',
        '为读者调整材料，用 adapt ... for ...。',
      ],
    ],
  ),
  pair(
    'sensible-sensitive',
    {
      word: 'sensible',
      meaning: 'adj. 明智的；合理的',
      rule: '评价判断、决定或人做事理性。',
      example: 'That is a sensible decision.',
    },
    {
      word: 'sensitive',
      meaning: 'adj. 敏感的；灵敏的',
      rule: '对外界反应敏感，常与 to 搭配。',
      example: 'My skin is sensitive to sunlight.',
    },
    [
      ['Wearing a helmet is a ___ precaution.', 'sensible', '戴头盔是明智的预防措施。'],
      [
        'This sensor is ___ to changes in temperature.',
        'sensitive',
        '对温度变化灵敏，sensitive to。',
      ],
      ['She gave me some ___ advice.', 'sensible', '合理的建议，用 sensible。'],
      ['Please be careful; this is a ___ topic.', 'sensitive', '敏感话题用 sensitive。'],
    ],
  ),
  pair(
    'economic-economical',
    {
      word: 'economic',
      meaning: 'adj. 经济的；经济学的',
      rule: '描述国家、行业、政策等经济层面的事物。',
      example: 'The report discusses economic growth.',
    },
    {
      word: 'economical',
      meaning: 'adj. 节约的；划算的',
      rule: '强调节省钱、时间或资源。',
      example: 'This car is economical to run.',
    },
    [
      ['The country faces serious ___ problems.', 'economic', '国家经济问题用 economic。'],
      [
        'Taking the bus is more ___ than driving.',
        'economical',
        '比较花费是否节约，用 economical。',
      ],
      ['We are studying ___ policy.', 'economic', '经济政策用 economic。'],
      ['This machine is ___ with electricity.', 'economical', '强调节省电力。'],
    ],
  ),
  pair(
    'remember-remind',
    {
      word: 'remember',
      meaning: 'v. 记得',
      rule: '自己记住；remember to do 表示记得去做。',
      example: 'Remember to bring your passport.',
    },
    {
      word: 'remind',
      meaning: 'v. 提醒；使想起',
      rule: '提醒某人：remind someone to do / of something。',
      example: 'Please remind me to call her.',
    },
    [
      ['Please ___ me to send the email.', 'remind', '提醒我去做，用 remind me to。'],
      ['Do you ___ his name?', 'remember', '询问是否记得一个名字。'],
      ['These photos ___ me of our trip.', 'remind', 'remind someone of something。'],
      ['Please ___ to lock the door.', 'remember', '主语自己记得去做，用 remember to。'],
    ],
  ),
  pair(
    'historic-historical',
    {
      word: 'historic',
      meaning: 'adj. 有历史意义的',
      rule: '强调对历史有重大影响。',
      example: 'It was a historic victory.',
    },
    {
      word: 'historical',
      meaning: 'adj. 与历史有关的',
      rule: '描述历史资料、研究或题材。',
      example: 'She writes historical novels.',
    },
    [
      ['The moon landing was a ___ event.', 'historic', '强调登月的重大历史意义。'],
      ['She is researching ___ records.', 'historical', '与历史有关的资料。'],
      ['They signed a ___ peace agreement.', 'historic', '强调协议的历史意义。'],
      ['I enjoy reading ___ fiction.', 'historical', '历史题材小说用 historical fiction。'],
    ],
  ),
];
