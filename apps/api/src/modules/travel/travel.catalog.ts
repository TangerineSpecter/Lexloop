import { AssessmentItemType, CefrLevel, LanguageSkillKind, ScenarioCategory } from '@prisma/client';

export const LEVELS: CefrLevel[] = [CefrLevel.A1, CefrLevel.A2, CefrLevel.B1, CefrLevel.B2, CefrLevel.C1];

type AssessmentSeed = {
  id: string;
  type: AssessmentItemType;
  level: CefrLevel;
  dimension: string;
  scenario?: ScenarioCategory;
  prompt: string;
  options?: string[];
  correctAnswers?: string[];
  rubric?: Record<string, unknown>;
  explanation?: string;
  displayOrder: number;
};

const objective = (
  id: string,
  type: AssessmentItemType,
  level: CefrLevel,
  dimension: string,
  prompt: string,
  options: string[],
  answer: string,
  displayOrder: number,
  scenario?: ScenarioCategory,
): AssessmentSeed => ({ id, type, level, dimension, prompt, options, correctAnswers: [answer], displayOrder, scenario });

export const ASSESSMENT_ITEMS: AssessmentSeed[] = [
  objective('assess-a1-vocab-1', AssessmentItemType.VOCABULARY, CefrLevel.A1, 'vocabulary', 'At a hotel, what does “room” mean?', ['房间', '护照', '账单', '行李'], '房间', 1, ScenarioCategory.HOTEL),
  objective('assess-a1-grammar-1', AssessmentItemType.GRAMMAR, CefrLevel.A1, 'grammar', 'Choose the natural sentence.', ['I have a booking.', 'I am have booking.', 'I has a booking.', 'I booking have.'], 'I have a booking.', 2, ScenarioCategory.HOTEL),
  objective('assess-a1-order-1', AssessmentItemType.SENTENCE_ORDER, CefrLevel.A1, 'sentenceBuilding', 'Put the words in a natural order: “like / I’d / water / some”', ["I'd like some water.", "Like I'd water some.", "Some water I'd like?", "I some water like."], "I'd like some water.", 3, ScenarioCategory.RESTAURANT),
  objective('assess-a1-scene-1', AssessmentItemType.SCENARIO_RESPONSE, CefrLevel.A1, 'taskCompletion', 'A shop assistant asks “Can I help you?” What is a useful reply?', ["Yes, I'm looking for a jacket.", 'My jacket is blue yesterday.', 'The airport is large.', 'No jacket help.'], "Yes, I'm looking for a jacket.", 4, ScenarioCategory.SHOPPING),
  objective('assess-a2-vocab-1', AssessmentItemType.VOCABULARY, CefrLevel.A2, 'vocabulary', 'Your flight is “delayed”. What happened?', ['It will leave later than planned.', 'It has already landed.', 'It is free of charge.', 'It has no passengers.'], 'It will leave later than planned.', 5, ScenarioCategory.AIRPORT),
  objective('assess-a2-grammar-1', AssessmentItemType.GRAMMAR, CefrLevel.A2, 'grammar', 'Which request is correct and natural?', ['Could I have the bill, please?', 'Could I had the bill?', 'Could I to have bill?', 'I could the bill please?'], 'Could I have the bill, please?', 6, ScenarioCategory.RESTAURANT),
  objective('assess-a2-order-1', AssessmentItemType.SENTENCE_ORDER, CefrLevel.A2, 'sentenceBuilding', 'Choose the best sentence for asking about breakfast.', ['Is breakfast included in the price?', 'Does breakfast included the price?', 'Breakfast is include price?', 'Included breakfast does it?'], 'Is breakfast included in the price?', 7, ScenarioCategory.HOTEL),
  objective('assess-a2-scene-1', AssessmentItemType.SCENARIO_RESPONSE, CefrLevel.A2, 'naturalness', 'You did not hear the platform number. What would you normally say?', ['Sorry, could you say that again?', 'Repeat your words immediately.', 'I demand the platform sentence.', 'Your speaking is unavailable.'], 'Sorry, could you say that again?', 8, ScenarioCategory.TRANSPORT),
  objective('assess-b1-vocab-1', AssessmentItemType.VOCABULARY, CefrLevel.B1, 'vocabulary', 'A hotel asks for a “deposit”. What is it?', ['Money held temporarily as security', 'A complimentary meal', 'A room upgrade', 'A travel document'], 'Money held temporarily as security', 9, ScenarioCategory.HOTEL),
  objective('assess-b1-grammar-1', AssessmentItemType.GRAMMAR, CefrLevel.B1, 'grammar', 'Choose the natural way to describe a problem that started earlier and continues now.', ["I've been waiting for my luggage for an hour.", 'I wait my luggage since an hour.', 'I am waited luggage one hour.', 'I was wait for luggage now.'], "I've been waiting for my luggage for an hour.", 10, ScenarioCategory.AIRPORT),
  objective('assess-b1-order-1', AssessmentItemType.SENTENCE_ORDER, CefrLevel.B1, 'sentenceBuilding', 'Which sentence clearly asks for an alternative?', ['If that room is unavailable, could I have a twin room instead?', 'That room no, give other maybe.', 'Unavailable room if twin instead has?', 'I have instead because room.'], 'If that room is unavailable, could I have a twin room instead?', 11, ScenarioCategory.HOTEL),
  objective('assess-b1-scene-1', AssessmentItemType.SCENARIO_RESPONSE, CefrLevel.B1, 'taskCompletion', 'Your meal contains nuts although you warned the server. What is the best response?', ['I mentioned that I have a nut allergy. Could you replace this dish, please?', 'This food is impossible and you are wrong.', 'Nuts were a historical problem.', 'I do not require the menu grammar.'], 'I mentioned that I have a nut allergy. Could you replace this dish, please?', 12, ScenarioCategory.RESTAURANT),
  objective('assess-b2-vocab-1', AssessmentItemType.VOCABULARY, CefrLevel.B2, 'vocabulary', 'The airline offers to “reimburse” your hotel cost. What will it do?', ['Pay you back for the cost', 'Reserve another room', 'Cancel your passport', 'Inspect your luggage'], 'Pay you back for the cost', 13, ScenarioCategory.AIRPORT),
  objective('assess-b2-grammar-1', AssessmentItemType.GRAMMAR, CefrLevel.B2, 'grammar', 'Choose the clearest polite challenge to an unexpected charge.', ["I was under the impression that breakfast was included; could you clarify why I've been charged?", 'I thought breakfast include, explain charge.', 'Breakfast would include unless charge was.', 'Had breakfast charged because impression.'], "I was under the impression that breakfast was included; could you clarify why I've been charged?", 14, ScenarioCategory.HOTEL),
  objective('assess-b2-order-1', AssessmentItemType.SENTENCE_ORDER, CefrLevel.B2, 'sentenceBuilding', 'Which response both acknowledges and negotiates?', ["I understand the policy, but given that the item is faulty, would a refund be possible?", 'Policy understood but refund me.', 'Faulty policy is possible refund understood.', 'I acknowledge, notwithstanding, money.'], "I understand the policy, but given that the item is faulty, would a refund be possible?", 15, ScenarioCategory.SHOPPING),
  objective('assess-b2-scene-1', AssessmentItemType.SCENARIO_RESPONSE, CefrLevel.B2, 'naturalness', 'A taxi driver suggests a much longer route. Choose a natural response.', ["Wouldn't it be quicker to take the tunnel at this time of day?", 'You must drive the shortest geometry.', 'I hereby reject the proposed route.', 'Tunnel quicker, obey me.'], "Wouldn't it be quicker to take the tunnel at this time of day?", 16, ScenarioCategory.TRANSPORT),
  objective('assess-c1-vocab-1', AssessmentItemType.VOCABULARY, CefrLevel.C1, 'vocabulary', 'A receptionist says the fee is “non-negotiable”. What do they mean?', ['They will not change it through discussion.', 'They cannot explain it in English.', 'They have waived it already.', 'They need another payment method.'], 'They will not change it through discussion.', 17, ScenarioCategory.HOTEL),
  objective('assess-c1-grammar-1', AssessmentItemType.GRAMMAR, CefrLevel.C1, 'grammar', 'Choose the most tactful way to escalate a complaint.', ["I appreciate that this isn't your fault, but I'd be grateful if you could put me in touch with someone authorised to resolve it.", 'You are not at fault, therefore summon authority.', 'Although faultless, connect resolution person.', 'I demand your superior without delay.'], "I appreciate that this isn't your fault, but I'd be grateful if you could put me in touch with someone authorised to resolve it.", 18, ScenarioCategory.HELP),
  objective('assess-c1-order-1', AssessmentItemType.SENTENCE_ORDER, CefrLevel.C1, 'sentenceBuilding', 'Which sentence naturally qualifies a request without sounding confrontational?', ["If it's at all feasible, I'd prefer a later connection, even if it means a slightly longer journey.", 'If feasible at all, later connection despite journey means.', 'A later connection is hereby preferred conditionally.', 'Long journey notwithstanding later perhaps.'], "If it's at all feasible, I'd prefer a later connection, even if it means a slightly longer journey.", 19, ScenarioCategory.TRANSPORT),
  objective('assess-c1-scene-1', AssessmentItemType.SCENARIO_RESPONSE, CefrLevel.C1, 'naturalness', 'A hotel cannot find your prepaid booking. Choose the most constructive response.', ["Could we double-check the reference number first? If it still doesn't appear, perhaps we can work out a temporary solution while I contact the booking site.", 'Your system has failed and must surrender a room.', 'I prepaid; this discussion is concluded.', 'Reference booking temporary website.'], "Could we double-check the reference number first? If it still doesn't appear, perhaps we can work out a temporary solution while I contact the booking site.", 20, ScenarioCategory.HOTEL),
  { id: 'assess-free-hotel', type: AssessmentItemType.FREE_RESPONSE, level: CefrLevel.A2, dimension: 'expression', scenario: ScenarioCategory.HOTEL, prompt: 'You arrive at a hotel. Confirm that you have a booking, give your name, and ask whether breakfast is included. Write what you would say.', rubric: { goals: ['confirm booking', 'give name', 'ask about breakfast'], style: 'natural international spoken English' }, displayOrder: 21 },
  { id: 'assess-free-flight', type: AssessmentItemType.FREE_RESPONSE, level: CefrLevel.B1, dimension: 'expression', scenario: ScenarioCategory.AIRPORT, prompt: 'Your flight has been cancelled. Ask an airline employee what your options are and whether the airline can help with a hotel. Write what you would say.', rubric: { goals: ['explain cancellation', 'ask for options', 'ask about hotel assistance'], style: 'natural international spoken English' }, displayOrder: 22 },
];

type ScenarioSeed = {
  id: string;
  slug: string;
  category: ScenarioCategory;
  title: string;
  description: string;
  userRole: string;
  aiRole: string;
  objectives: string[];
  starterPhrases: string[];
  grammarFrames: Array<{ intent: string; natural: string; frame: string; explanation: string }>;
  difficultyVariants: Record<string, string>;
};

const variants = (focus: string): Record<string, string> => ({
  A1: `Use short questions, familiar words and patient replies. Focus on ${focus}.`,
  A2: `Use simple follow-up questions and one small complication. Focus on ${focus}.`,
  B1: `Require explanations, alternatives and connected sentences. Focus on ${focus}.`,
  B2: `Add negotiation, polite clarification and an unexpected constraint. Focus on ${focus}.`,
  C1: `Add pragmatic nuance, tactful escalation and flexible reformulation. Focus on ${focus}.`,
});

const frame = (intent: string, natural: string, grammarFrame: string, explanation: string) => ({ intent, natural, frame: grammarFrame, explanation });

export const SCENARIOS: ScenarioSeed[] = [
  { id: 'scene-airport-checkin', slug: 'airport-checkin', category: ScenarioCategory.AIRPORT, title: '值机与托运', description: '确认航班、选择座位并托运行李。', userRole: '即将出发的旅客', aiRole: '航空公司值机人员', objectives: ['确认目的地和航班', '办理托运行李', '询问座位或登机口'], starterPhrases: ["I'm checking in for flight...", 'Could I have an aisle seat?', 'Where is the boarding gate?'], grammarFrames: [frame('办理值机', "I'm checking in for + 航班/目的地.", "I'm checking in for + noun.", '现在进行时可表示正在办理眼前的手续。')], difficultyVariants: variants('check-in, baggage and seat requests') },
  { id: 'scene-airport-security', slug: 'airport-security', category: ScenarioCategory.AIRPORT, title: '安检与登机', description: '听懂安检要求，并确认登机时间和队列。', userRole: '准备过安检和登机的旅客', aiRole: '机场工作人员', objectives: ['确认随身物品要求', '询问登机时间', '找到正确队列'], starterPhrases: ['Do I need to take this out?', 'What time does boarding start?', 'Is this the line for flight...?'], grammarFrames: [frame('确认是否需要', 'Do I need to + 动词原形?', 'Do I need to + verb?', 'need to 后接动词原形，询问是否必须做某事。')], difficultyVariants: variants('security instructions and boarding') },
  { id: 'scene-airport-disruption', slug: 'airport-disruption', category: ScenarioCategory.AIRPORT, title: '延误与行李问题', description: '航班延误、取消或行李未到时寻求解决方案。', userRole: '遇到航班或行李问题的旅客', aiRole: '航空公司服务柜台人员', objectives: ['说明问题', '询问可选方案', '确认住宿或行李后续'], starterPhrases: ['My flight has been cancelled.', 'What options do I have?', 'Could the airline help with a hotel?'], grammarFrames: [frame('询问解决方案', 'What options do I have?', 'What + plural noun + do I have?', '用开放式问题询问对方能提供的方案。')], difficultyVariants: variants('disruption, alternatives and compensation') },
  { id: 'scene-hotel-checkin', slug: 'hotel-checkin', category: ScenarioCategory.HOTEL, title: '确认预订与入住', description: '用姓名确认预订，并询问早餐、押金和入住信息。', userRole: '到店办理入住的客人', aiRole: '酒店前台', objectives: ['确认预订和姓名', '提供所需证件', '询问早餐或退房时间'], starterPhrases: ['I have a booking under the name...', 'Is breakfast included?', 'What time is check-out?'], grammarFrames: [frame('说明预订姓名', 'I have a booking under the name + 姓名.', 'I have + noun + under the name + name.', 'under the name 表示预订登记在某个姓名下。')], difficultyVariants: variants('booking confirmation and check-in details') },
  { id: 'scene-hotel-request', slug: 'hotel-request', category: ScenarioCategory.HOTEL, title: '提出房间需求', description: '请求额外用品，并说明噪音、空调等房间问题。', userRole: '需要酒店协助的住客', aiRole: '酒店前台或客房服务', objectives: ['礼貌提出需求', '说明房间问题', '确认处理时间'], starterPhrases: ['Could I have an extra towel?', "The air conditioning doesn't seem to be working.", 'How soon could someone take a look?'], grammarFrames: [frame('礼貌请求物品', 'Could I have + 物品, please?', 'Could I have + noun, please?', 'Could I have 比 Give me 更自然礼貌。')], difficultyVariants: variants('room requests and reporting problems') },
  { id: 'scene-hotel-checkout', slug: 'hotel-checkout', category: ScenarioCategory.HOTEL, title: '退房与费用异议', description: '办理退房、寄存行李并核对意外收费。', userRole: '准备退房的住客', aiRole: '酒店前台', objectives: ['办理退房', '核对账单', '解决收费问题或寄存行李'], starterPhrases: ["I'd like to check out.", 'Could you explain this charge?', 'Could you hold my bags until this afternoon?'], grammarFrames: [frame('询问收费原因', 'Could you explain why + 完整句子?', 'Could you explain why + subject + verb?', 'why 引导的间接问句使用陈述语序。')], difficultyVariants: variants('checkout, bills and tactful disputes') },
  { id: 'scene-restaurant-order', slug: 'restaurant-order', category: ScenarioCategory.RESTAURANT, title: '点餐与加点', description: '询问推荐、点餐并调整配菜或饮品。', userRole: '餐厅顾客', aiRole: '餐厅服务员', objectives: ['询问菜单或推荐', '完成点餐', '提出一项调整'], starterPhrases: ["What would you recommend?", "I'd like the grilled fish.", 'Could I have the sauce on the side?'], grammarFrames: [frame('自然点餐', "I'd like + 食物/饮品.", "I'd like + noun.", "I'd like 是 I would like 的口语缩写，比 I want 更自然。")], difficultyVariants: variants('ordering, recommendations and modifications') },
  { id: 'scene-restaurant-allergy', slug: 'restaurant-allergy', category: ScenarioCategory.RESTAURANT, title: '成分与饮食限制', description: '询问配料，并清楚说明过敏或饮食需求。', userRole: '有饮食限制的顾客', aiRole: '餐厅服务员', objectives: ['说明饮食限制', '确认菜品成分', '选择安全替代品'], starterPhrases: ["I'm allergic to nuts.", 'Does this contain dairy?', 'Could you suggest something without...?'], grammarFrames: [frame('询问是否含有', 'Does this contain + 成分?', 'Does + subject + base verb + noun?', '一般现在时疑问句用 does 后，contain 保持原形。')], difficultyVariants: variants('ingredients, allergies and safe alternatives') },
  { id: 'scene-restaurant-bill', slug: 'restaurant-bill', category: ScenarioCategory.RESTAURANT, title: '结账与处理问题', description: '索要账单、分开付款，并处理上错菜或多收费。', userRole: '准备结账的顾客', aiRole: '餐厅服务员', objectives: ['索要账单', '说明付款方式', '礼貌处理一个问题'], starterPhrases: ['Could we have the bill, please?', 'Could we split the bill?', "I don't think we ordered this."], grammarFrames: [frame('委婉指出问题', "I don't think + 完整句子.", "I don't think + subject + verb.", '先表达自己的判断，比直接说 You are wrong 更缓和。')], difficultyVariants: variants('payment and resolving service issues') },
  { id: 'scene-shopping-browse', slug: 'shopping-browse', category: ScenarioCategory.SHOPPING, title: '询价与试用', description: '寻找商品、询问价格并申请试穿或试用。', userRole: '正在购物的顾客', aiRole: '商店店员', objectives: ['说明想找的商品', '询问价格', '请求试穿或试用'], starterPhrases: ["I'm looking for...", 'How much is this?', 'Could I try this on?'], grammarFrames: [frame('说明正在寻找', "I'm looking for + 物品.", "I'm looking for + noun.", 'look for 表示寻找，注意保留介词 for。')], difficultyVariants: variants('finding, pricing and trying products') },
  { id: 'scene-shopping-size', slug: 'shopping-size', category: ScenarioCategory.SHOPPING, title: '尺码与库存', description: '询问其他颜色、尺码、库存或相似商品。', userRole: '需要其他款式的顾客', aiRole: '商店店员', objectives: ['说明尺码或颜色需求', '询问库存', '比较替代商品'], starterPhrases: ['Do you have this in a larger size?', 'Does it come in black?', 'Is there anything similar?'], grammarFrames: [frame('询问某种规格', 'Do you have this in + 尺码/颜色?', 'Do you have + object + in + variant?', 'in 后接颜色或尺码，表达同一商品的不同版本。')], difficultyVariants: variants('sizes, stock and alternatives') },
  { id: 'scene-shopping-return', slug: 'shopping-return', category: ScenarioCategory.SHOPPING, title: '退换货', description: '说明商品问题，询问退款、换货和商店政策。', userRole: '希望退换商品的顾客', aiRole: '售后柜台店员', objectives: ['说明购买情况和问题', '提出退款或换货请求', '回应商店政策'], starterPhrases: ["I'd like to return this.", 'It turned out to be faulty.', 'Would an exchange be possible?'], grammarFrames: [frame('委婉询问可能性', 'Would + 方案 + be possible?', 'Would + noun phrase + be possible?', '用 would 和 possible 降低请求的强硬程度。')], difficultyVariants: variants('returns, faults and policy negotiation') },
  { id: 'scene-transport-directions', slug: 'transport-directions', category: ScenarioCategory.TRANSPORT, title: '问路与确认方向', description: '询问目的地位置、步行路线和地标。', userRole: '正在找路的游客', aiRole: '当地路人或工作人员', objectives: ['询问如何到达目的地', '确认关键转弯', '确认预计时间'], starterPhrases: ['How do I get to...?', 'Do I turn left at the lights?', 'How long does it take on foot?'], grammarFrames: [frame('询问路线', 'How do I get to + 地点?', 'How do I get to + place?', '这是询问到达某地最常见、自然的说法。')], difficultyVariants: variants('directions, landmarks and clarification') },
  { id: 'scene-transport-taxi', slug: 'transport-taxi', category: ScenarioCategory.TRANSPORT, title: '打车与公共交通', description: '说明目的地、确认费用并选择合适路线。', userRole: '乘客', aiRole: '司机或交通工作人员', objectives: ['说明目的地', '询问时间或费用', '确认路线或下车点'], starterPhrases: ['Could you take me to...?', 'Roughly how much will it cost?', 'Could you drop me off here?'], grammarFrames: [frame('请司机送到某地', 'Could you take me to + 地点?', 'Could you take me to + place?', 'take someone to somewhere 表示把某人送到某地。')], difficultyVariants: variants('destinations, fares and routes') },
  { id: 'scene-transport-change', slug: 'transport-change', category: ScenarioCategory.TRANSPORT, title: '行程变更', description: '错过班次或临时改计划时查询换乘和改票方案。', userRole: '需要调整行程的旅客', aiRole: '车站或票务工作人员', objectives: ['说明原行程问题', '询问下一班或替代路线', '确认票务影响'], starterPhrases: ['I missed my connection.', 'When is the next service?', 'Can I use the same ticket?'], grammarFrames: [frame('说明错过班次', 'I missed + 班次/换乘.', 'I missed + noun.', 'miss 在交通语境表示没赶上，而不是想念。')], difficultyVariants: variants('missed connections and rebooking') },
  { id: 'scene-help-medical', slug: 'help-medical', category: ScenarioCategory.HELP, title: '身体不适', description: '描述症状，寻找药房、诊所或紧急帮助。', userRole: '身体不适的旅客', aiRole: '酒店人员、药剂师或医护人员', objectives: ['说明主要症状', '说明持续时间', '确认下一步帮助'], starterPhrases: ["I don't feel well.", "I've had a fever since yesterday.", 'Is there a clinic nearby?'], grammarFrames: [frame('说明持续症状', "I've had + 症状 + since/for + 时间.", "I've had + symptom + since/for + time.", '现在完成时表示从过去持续到现在；since 接起点，for 接时长。')], difficultyVariants: variants('symptoms and seeking appropriate help') },
  { id: 'scene-help-lost', slug: 'help-lost', category: ScenarioCategory.HELP, title: '物品丢失', description: '说明丢失物品、最后出现地点和识别特征。', userRole: '丢失物品的旅客', aiRole: '失物招领处工作人员', objectives: ['说明丢失物品', '说明最后见到的地点时间', '提供可识别特征'], starterPhrases: ["I've lost my passport.", 'I last saw it at...', 'It has a blue cover.'], grammarFrames: [frame('说明物品已经丢失', "I've lost + 物品.", "I've lost + object.", '现在完成时强调丢失对现在仍有影响。')], difficultyVariants: variants('lost property descriptions and follow-up') },
  { id: 'scene-help-authority', slug: 'help-authority', category: ScenarioCategory.HELP, title: '联系警方或工作人员', description: '遇到安全或纠纷问题时，清楚说明事实并请求协助。', userRole: '需要正式协助的旅客', aiRole: '警方、领事或现场工作人员', objectives: ['简洁说明发生了什么', '提供地点和时间', '提出明确的协助请求'], starterPhrases: ['I need some help with...', 'This happened about an hour ago.', 'Could you tell me what I should do next?'], grammarFrames: [frame('询问下一步', 'Could you tell me what I should do next?', 'Could you tell me + wh-clause?', '间接问句使用陈述语序：what I should do。')], difficultyVariants: variants('clear factual reports and requesting formal help') },
];

export const LANGUAGE_SKILLS = [
  { id: 'skill-polite-request', code: 'polite-request', kind: LanguageSkillKind.GRAMMAR, title: '礼貌提出请求', level: CefrLevel.A1, description: '使用 Could I / Could you / I’d like 自然提出请求。' },
  { id: 'skill-clarification', code: 'clarification', kind: LanguageSkillKind.PRAGMATICS, title: '请求重复与确认', level: CefrLevel.A2, description: '没听懂时请求重复、放慢或确认关键信息。' },
  { id: 'skill-explain-problem', code: 'explain-problem', kind: LanguageSkillKind.EXPRESSION, title: '说明问题', level: CefrLevel.A2, description: '用简洁的时间、地点和现状说明旅行问题。' },
  { id: 'skill-negotiate', code: 'negotiate', kind: LanguageSkillKind.PRAGMATICS, title: '协商替代方案', level: CefrLevel.B1, description: '认可限制后询问可行的替代方案。' },
  { id: 'skill-tactful-escalation', code: 'tactful-escalation', kind: LanguageSkillKind.PRAGMATICS, title: '委婉升级诉求', level: CefrLevel.B2, description: '在不激化矛盾的前提下清楚坚持诉求。' },
];

export const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  AIRPORT: '机场', HOTEL: '酒店', RESTAURANT: '餐厅', SHOPPING: '购物', TRANSPORT: '交通', HELP: '求助',
};
