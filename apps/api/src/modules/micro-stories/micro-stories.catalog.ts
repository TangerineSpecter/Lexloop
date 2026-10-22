export type MicroStory = {
  key: string;
  series: string;
  part: number;
  level: 'A1' | 'A2';
  english: string;
  reference: string;
  explanation: string;
  frame: string;
  example: string;
};

// Stable keys matter: saved misunderstanding cards must continue to point to the same text.
export const MICRO_STORIES: readonly MicroStory[] = [
  {
    key: 'bus-01',
    series: '上班路上',
    part: 1,
    level: 'A1',
    english: 'Tom leaves home late. He misses the bus.',
    reference: '汤姆出门晚了，没赶上公交车。',
    explanation: 'miss the bus 在赶车的场景里是“没赶上公交车”，不是“想念公交车”。',
    frame: 'I missed the bus.',
    example: 'I missed the train.',
  },
  {
    key: 'bus-02',
    series: '上班路上',
    part: 2,
    level: 'A1',
    english: 'Tom calls his boss. He says, “I will be late for work.”',
    reference: '汤姆给老板打电话，说：“我上班会迟到。”',
    explanation: 'be late for work 是“上班迟到”；will 表示接下来会发生的事。',
    frame: 'I will be late for ___.',
    example: 'I will be late for class.',
  },
  {
    key: 'bus-03',
    series: '上班路上',
    part: 3,
    level: 'A1',
    english: 'A friend gives Tom a ride. Tom gets to work on time.',
    reference: '一位朋友开车捎了汤姆一程。汤姆准时到了公司。',
    explanation: 'give someone a ride 是“开车捎某人一程”；on time 是“准时”。',
    frame: '___ gives me a ride.',
    example: 'My sister gives me a ride.',
  },
  {
    key: 'cafe-01',
    series: '咖啡店',
    part: 1,
    level: 'A1',
    english: 'Mia stops at a café. She orders a small coffee.',
    reference: '米娅在一家咖啡店停下来，点了一杯小杯咖啡。',
    explanation: 'order 在咖啡店里是“点单”，不是“命令”。',
    frame: 'I order ___.',
    example: 'I order a cup of tea.',
  },
  {
    key: 'cafe-02',
    series: '咖啡店',
    part: 2,
    level: 'A2',
    english: 'The barista asks if Mia wants milk. She says, “Just a little, please.”',
    reference: '咖啡师问米娅要不要牛奶。她说：“一点点就好，谢谢。”',
    explanation: 'if 在 asks if... 中引出“是否”；a little 修饰牛奶这类不可数的东西。',
    frame: 'Do you want ___? Just a little, please.',
    example: 'Do you want sugar? Just a little, please.',
  },
  {
    key: 'cafe-03',
    series: '咖啡店',
    part: 3,
    level: 'A2',
    english: 'Mia reaches for her wallet, but she left it at home. Her friend pays for the coffee.',
    reference: '米娅伸手找钱包，却发现把钱包落在家里了。她的朋友替她付了咖啡钱。',
    explanation: 'left it at home 指“把它落在家里”；pay for 后接所付钱购买的东西。',
    frame: 'I left ___ at home.',
    example: 'I left my keys at home.',
  },
  {
    key: 'meeting-01',
    series: '开会之前',
    part: 1,
    level: 'A2',
    english: 'Mia has a meeting at ten. She needs to finish a short report first.',
    reference: '米娅十点有个会。她得先写完一份简短的报告。',
    explanation: 'need to 后接动词原形；first 表示先做这件事。',
    frame: 'I need to ___ first.',
    example: 'I need to call my manager first.',
  },
  {
    key: 'meeting-02',
    series: '开会之前',
    part: 2,
    level: 'A2',
    english:
      'Tom offers to help with the report. Mia sends him the notes so he can check the numbers.',
    reference: '汤姆主动提出帮忙写报告。米娅把笔记发给他，好让他核对数字。',
    explanation: 'offer to do 是“主动提出做”；so he can... 表示这样他就能做某事。',
    frame: 'I can ___ so you can ___.',
    example: 'I can send the file so you can read it.',
  },
  {
    key: 'meeting-03',
    series: '开会之前',
    part: 3,
    level: 'A2',
    english:
      'They finish the report before the meeting starts. Mia feels ready because she knows the numbers are right.',
    reference: '他们在会议开始前完成了报告。米娅觉得准备好了，因为她知道数字是对的。',
    explanation: 'before 引出“在……之前”；because 引出原因。',
    frame: 'I feel ready because ___.',
    example: 'I feel ready because I have my notes.',
  },
];

export function storyByKey(key: string) {
  return MICRO_STORIES.find((story) => story.key === key);
}

export function nextStory(
  stories: readonly MicroStory[],
  completedKeys: readonly string[],
  activeKey?: string | null,
) {
  const completed = new Set(completedKeys);
  const active = activeKey && stories.find((story) => story.key === activeKey);
  if (active && !completed.has(active.key)) return active;
  return stories.find((story) => !completed.has(story.key));
}
