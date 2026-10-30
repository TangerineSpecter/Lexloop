export type MicroStory = {
  key: string;
  series: string;
  part: number;
  level: 'A1' | 'A2' | 'B1';
  english: string;
  reference: string;
  explanation: string;
  frame: string;
  example: string;
  focusPhrase: string;
  focusMeaning: string;
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
    focusPhrase: 'miss the bus',
    focusMeaning: '没赶上公交车；不是“想念公交车”。',
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
    focusPhrase: 'be late for work',
    focusMeaning: '上班迟到。',
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
    focusPhrase: 'give someone a ride',
    focusMeaning: '开车捎某人一程。',
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
    focusPhrase: 'order',
    focusMeaning: '点单；这里指在咖啡店点饮品。',
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
    focusPhrase: 'just a little',
    focusMeaning: '只要一点点；这里指牛奶加一点点就好。',
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
    focusPhrase: 'left it at home',
    focusMeaning: '把它落在家里；这里的 it 指钱包。',
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
    focusPhrase: 'needs to finish a short report first',
    focusMeaning: '需要先完成一份简短报告。',
  },
  {
    key: 'meeting-02',
    series: '开会之前',
    part: 2,
    level: 'A2',
    english:
      'Tom offers to help with the report. Mia sends him the notes so he can check the numbers.',
    reference: '汤姆主动提出帮忙完成这份报告。米娅把笔记发给他，好让他核对数字。',
    explanation:
      'help with the report 表示帮忙做这项报告工作，不只指写作；offer to help 是“主动提出帮忙”；so he can... 表示这样他就能做某事。',
    frame: 'I can ___ so you can ___.',
    example: 'I can send the file so you can read it.',
    focusPhrase: 'help with the report',
    focusMeaning: '帮忙做这份报告相关的工作，不只指写作。',
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
    focusPhrase: 'feel ready',
    focusMeaning: '觉得准备好了；这里指准备好参加会议。',
  },
  {
    key: 'weekend-01',
    series: '周末约朋友',
    part: 1,
    level: 'A2',
    english:
      'Maya wants to see a friend this weekend. She texts Leo to ask if he is free on Saturday.',
    reference: 'Maya 想这周末见一位朋友。她发消息问 Leo 周六有没有空。',
    explanation: 'ask if... 是“询问是否……”；be free 在安排见面时表示“有空”。',
    frame: 'Are you free on ___?',
    example: 'Are you free on Friday?',
    focusPhrase: 'be free',
    focusMeaning: '周六有空；用于询问见面安排。',
  },
  {
    key: 'weekend-02',
    series: '周末约朋友',
    part: 2,
    level: 'A2',
    english:
      "Leo can't meet in the morning because he has a dentist appointment. He suggests meeting after lunch instead.",
    reference: 'Leo 早上没法见面，因为他约了看牙医。他提议改到午饭后见。',
    explanation: 'suggest + 动词-ing 表示提议做某事；instead 表示改做另一种安排。',
    frame: 'How about meeting ___ instead?',
    example: 'How about meeting after work instead?',
    focusPhrase: 'meeting after lunch',
    focusMeaning: '午饭后见面；故事里是改到这个时间。',
  },
  {
    key: 'weekend-03',
    series: '周末约朋友',
    part: 3,
    level: 'A2',
    english:
      'They meet outside the library at two. After choosing a café, they catch up over coffee.',
    reference: '他们两点在图书馆外碰面。选好一家咖啡馆后，他们边喝咖啡边聊近况。',
    explanation: 'catch up 在这里指“聊聊彼此近况”；over coffee 表示边喝咖啡边聊。',
    frame: "Let's catch up over ___.",
    example: "Let's catch up over lunch.",
    focusPhrase: 'catch up over coffee',
    focusMeaning: '边喝咖啡边聊彼此近况。',
  },
  {
    key: 'home-repair-01',
    series: '家里维修',
    part: 1,
    level: 'A2',
    english:
      "A pipe under Ben's sink is leaking. He calls the building manager and explains that water is dripping onto the floor.",
    reference: 'Ben 水槽下面的一根管子在漏水。他给楼栋管理员打电话，说明水正滴到地板上。',
    explanation:
      'is leaking 和 is dripping 用现在进行时，表示漏水正在发生；explain that... 引出具体情况。',
    frame: 'Something is leaking in ___.',
    example: 'Something is leaking in the bathroom.',
    focusPhrase: 'is leaking',
    focusMeaning: '正在漏水；这里指水管持续漏水。',
  },
  {
    key: 'home-repair-02',
    series: '家里维修',
    part: 2,
    level: 'A2',
    english:
      'The manager asks when someone can come by. Ben says he will be home after six but asks them to call first.',
    reference: '管理员问什么时候可以派人上门。Ben 说他六点后在家，但请对方先打电话。',
    explanation:
      'when someone can come by 是嵌入式问句，语序用“主语 + can”；come by 在这里指上门一趟。',
    frame: 'Could someone come by ___?',
    example: 'Could someone come by tomorrow morning?',
    focusPhrase: 'come by',
    focusMeaning: '顺道过来；这里指上门一趟。',
  },
  {
    key: 'home-repair-03',
    series: '家里维修',
    part: 3,
    level: 'A2',
    english:
      'The repair worker tightens a loose connection and shows Ben how to turn off the water. Ben takes a photo of the valve so he can find it again.',
    reference: '维修人员拧紧了松动的接头，还教 Ben 怎么关水。Ben 给阀门拍了张照片，方便下次找到。',
    explanation: 'show someone how to... 表示教某人怎么做；so he can... 说明拍照的目的。',
    frame: 'Could you show me how to ___?',
    example: 'Could you show me how to reset the router?',
    focusPhrase: 'turn off the water',
    focusMeaning: '关掉水源；这里指关掉供水阀。',
  },
  {
    key: 'deadline-01',
    series: '项目改期',
    part: 1,
    level: 'B1',
    english:
      'The client moves the deadline up by a week. Nina realizes the design team is already running behind schedule.',
    reference: '客户把截止日期提前了一周。妮娜意识到设计团队已经落后于进度。',
    explanation:
      'move the deadline up 表示把截止日期提前；run behind schedule 表示工作进度落后于原计划。',
    frame: "We're running behind schedule on ___.",
    example: "We're running behind schedule on the new menu.",
    focusPhrase: 'running behind schedule',
    focusMeaning: '进度落后于原计划。',
  },
  {
    key: 'deadline-02',
    series: '项目改期',
    part: 2,
    level: 'B1',
    english:
      'The client asks for an update, so Nina explains what the team has finished and which tasks will take one more day.',
    reference: '客户询问进度，妮娜便说明了已经完成的内容，并解释哪些任务还需要一天。',
    explanation:
      'what the team has finished 和 which tasks will take one more day 都是嵌入式内容从句；explain 在这里表示说明进度。',
    frame: 'I can lay out ___ so we can ___.',
    example: 'I can lay out the options so we can decide.',
    focusPhrase: 'take one more day',
    focusMeaning: '还需要一天时间。',
  },
  {
    key: 'deadline-03',
    series: '项目改期',
    part: 3,
    level: 'B1',
    english:
      'After they agree to postpone the optional animation, Nina confirms the new scope in an email. The team can now finish the core features by Friday.',
    reference:
      '他们同意把可选动画延期后，妮娜通过邮件确认了新的工作范围。团队现在最迟在周五完成核心功能。',
    explanation:
      'postpone 表示把事情推迟；confirm the new scope 可以把改过的工作范围写清楚；by Friday 表示最迟不晚于周五，周五当天也在期限内，不表示必须等到周五才完成。',
    frame: 'We can finish ___ by Friday if we ___.',
    example: 'We can finish the draft by Friday if we get the data today.',
    focusPhrase: 'by Friday',
    focusMeaning: '周五或更早完成；周五是最晚期限。',
  },
  {
    key: 'bike-repair-01',
    series: '单车维修',
    part: 1,
    level: 'B1',
    english:
      'Nina drops off her bike at a repair shop on Friday morning. The message says it will be ready after 4 p.m., but she reads it too quickly and thinks she can collect it before 4.',
    reference:
      '周五上午，妮娜把自行车送到修理店。店里的消息说下午 4 点以后可以取车，但她看得太快，以为 4 点前就能取。',
    explanation:
      'after 4 p.m. 表示下午 4 点之后，不是 4 点之前。妮娜把时间看反了，所以她原先以为取车的时间与消息相反。',
    frame: 'It will be ready after ___.',
    example: 'The report will be ready after lunch.',
    focusPhrase: 'after 4 p.m.',
    focusMeaning: '下午 4 点之后；不表示 4 点之前。',
  },
  {
    key: 'bike-repair-02',
    series: '单车维修',
    part: 2,
    level: 'B1',
    english:
      'Before leaving work, Nina checks the message again and calls the shop. The mechanic confirms that the bike will not be ready before 4 and should be ready around 4:30.',
    reference:
      '下班前，妮娜重新看了消息并给修理店打电话。维修师傅确认自行车在 4 点前还不能取，预计 4 点半左右可以取。',
    explanation:
      'not be ready before 4 表示 4 点前还不能取；around 4:30 是预计时间，不是保证精确到 4 点半。',
    frame: 'It will not be ready before ___.',
    example: 'The room will not be ready before noon.',
    focusPhrase: 'not be ready before 4',
    focusMeaning: '4 点前还不能取；店里预计 4 点半左右修好。',
  },
  {
    key: 'bike-repair-03',
    series: '单车维修',
    part: 3,
    level: 'B1',
    english:
      'At 4:30, the mechanic texts Nina that the repair is finished. She asks her friend Max to meet her outside the shop at 4:45, collects the bike, and they ride home together.',
    reference:
      '下午 4 点半，维修师傅发消息告诉妮娜自行车已经修好。她约朋友 Max 4 点 45 分在店外见面，取回自行车后，两人一起骑车回家。',
    explanation:
      'collect the bike 在这里指从修理店取回修好的自行车；师傅在 4 点半确认修好，妮娜约 4 点 45 分碰面。',
    frame: 'I need to collect ___ from the shop.',
    example: 'I need to collect my coat from the cleaner.',
    focusPhrase: 'collects the bike',
    focusMeaning: '从修理店取回已经修好的自行车。',
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
