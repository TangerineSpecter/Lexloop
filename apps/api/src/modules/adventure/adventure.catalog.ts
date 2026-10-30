import { EquipmentRarity, EquipmentSlot, SkillTarget } from '@prisma/client';
import type { AdventureCombatPassive, AdventureCombatPassiveKey } from '@lexloop/types';

export const COMBAT_PASSIVE_RULES_VERSION = 1;

export const COMBAT_PASSIVES: Record<AdventureCombatPassiveKey, AdventureCombatPassive> = {
  VANGUARD: {
    key: 'VANGUARD',
    title: '稳守',
    description: '答对格挡且仍会受伤时，额外减免最多 4 点伤害。',
  },
  BURST: {
    key: 'BURST',
    title: '精准施法',
    description: '消耗至少 1 点资源发动技能并完美命中，额外造成 6 点战斗伤害。',
  },
  STRIKER: {
    key: 'STRIKER',
    title: '连续出击',
    description: '同房间连续答对后，本次答对攻击额外造成 6 点战斗伤害；答错会重置连击。',
  },
  SUPPORT: {
    key: 'SUPPORT',
    title: '温和疗愈',
    description: '未满生命时答对词块组句，或有效评分的自由作答，每个房间最多恢复 4 点生命。',
  },
};

export type ClassSeed = {
  id: string;
  key: string;
  name: string;
  description: string;
  combatRole: string;
  tier: number;
  requiredLevel: number;
  parentId?: string;
  sortOrder: number;
};

const base: ClassSeed[] = [
  {
    id: 'class-warrior',
    key: 'warrior',
    name: '战士',
    description: '用稳定命中积累护盾与反击。',
    combatRole: 'VANGUARD',
    tier: 0,
    requiredLevel: 1,
    sortOrder: 1,
  },
  {
    id: 'class-mage',
    key: 'mage',
    name: '法师',
    description: '消耗专注强化精准回答的爆发。',
    combatRole: 'BURST',
    tier: 0,
    requiredLevel: 1,
    sortOrder: 2,
  },
  {
    id: 'class-ranger',
    key: 'ranger',
    name: '游侠',
    description: '连续正确时获得暴击与额外探索。',
    combatRole: 'STRIKER',
    tier: 0,
    requiredLevel: 1,
    sortOrder: 3,
  },
  {
    id: 'class-cleric',
    key: 'cleric',
    name: '牧师',
    description: '通过清晰表达恢复生命并维持增益。',
    combatRole: 'SUPPORT',
    tier: 0,
    requiredLevel: 1,
    sortOrder: 4,
  },
];

const branches: ClassSeed[] = [
  branch('knight', '骑士', '坚固格挡与反击。', 'VANGUARD', 'warrior', 1),
  branch('berserker', '狂战士', '以生命风险换取更高伤害。', 'STRIKER', 'warrior', 2),
  branch('elementalist', '元素使', '精准答案累积元素连锁。', 'BURST', 'mage', 1),
  branch('arcanist', '奥术师', '用资源调度换取稳定施法。', 'CONTROL', 'mage', 2),
  branch('sharpshooter', '神射手', '无提示回忆获得高额暴击。', 'STRIKER', 'ranger', 1),
  branch('pathfinder', '探路者', '擅长路线、掉落与持续作战。', 'UTILITY', 'ranger', 2),
  branch('priest', '祭司', '用正确表达治疗并生成护盾。', 'SUPPORT', 'cleric', 1),
  branch('oracle', '神谕者', '预见题型并削弱敌人。', 'CONTROL', 'cleric', 2),
];

const advanced: ClassSeed[] = [
  advancedClass('guardian', '守护者', 'knight', 1),
  advancedClass('warlord', '战争领主', 'berserker', 2),
  advancedClass('archmage', '大魔导师', 'elementalist', 1),
  advancedClass('chronomancer', '时术师', 'arcanist', 2),
  advancedClass('deadeye', '鹰眼', 'sharpshooter', 1),
  advancedClass('warden', '荒野守望者', 'pathfinder', 2),
  advancedClass('high-priest', '大祭司', 'priest', 1),
  advancedClass('seer', '先知', 'oracle', 2),
];

function branch(
  key: string,
  name: string,
  description: string,
  role: string,
  parent: string,
  order: number,
): ClassSeed {
  return {
    id: `class-${key}`,
    key,
    name,
    description,
    combatRole: role,
    tier: 1,
    requiredLevel: 10,
    parentId: `class-${parent}`,
    sortOrder: order,
  };
}

function advancedClass(key: string, name: string, parent: string, order: number): ClassSeed {
  return {
    id: `class-${key}`,
    key,
    name,
    description: `${name}将职业特性推进到新的阶段。`,
    combatRole: 'SPECIALIST',
    tier: 2,
    requiredLevel: 25,
    parentId: `class-${parent}`,
    sortOrder: order,
  };
}

export const CLASS_NODES = [...base, ...branches, ...advanced];
const classNodeById = new Map(CLASS_NODES.map((node) => [node.id, node]));

const basePassiveByClassId: Record<string, AdventureCombatPassiveKey> = {
  'class-warrior': 'VANGUARD',
  'class-mage': 'BURST',
  'class-ranger': 'STRIKER',
  'class-cleric': 'SUPPORT',
};

export function combatPassiveKeyForClassId(classId: string | null | undefined) {
  const visited = new Set<string>();
  let current = classId ? classNodeById.get(classId) : undefined;
  while (current && !visited.has(current.id)) {
    const passiveKey = basePassiveByClassId[current.id];
    if (passiveKey) return passiveKey;
    visited.add(current.id);
    current = current.parentId ? classNodeById.get(current.parentId) : undefined;
  }
  return null;
}

export function combatPassiveForKey(value: unknown): AdventureCombatPassive | null {
  return typeof value === 'string' && Object.hasOwn(COMBAT_PASSIVES, value)
    ? COMBAT_PASSIVES[value as AdventureCombatPassiveKey]
    : null;
}

export function combatPassiveForClassId(classId: string | null | undefined) {
  return combatPassiveForKey(combatPassiveKeyForClassId(classId));
}

const skillNames = [
  ['基础技', '答对后提高本次伤害。', { damageMultiplier: 1.15 }],
  ['专注技', '精准命中时恢复一点职业资源。', { perfectResource: 1 }],
  ['守势技', '格挡成功时进一步降低伤害。', { blockBonus: 0.15 }],
  ['终结技', '消耗资源造成强力一击。', { damageMultiplier: 1.55 }],
  ['知识印记', '生产型回答获得额外经验。', { productionExperience: 0.15 }],
  ['坚韧', '提高本次探索的最大生命。', { maxHp: 8 }],
  ['寻宝直觉', '提高结算时的材料收益。', { materialBonus: 0.12 }],
] as const;

export const SKILLS = CLASS_NODES.flatMap((node) =>
  skillNames.map((skill, index) => ({
    id: `skill-${node.key}-${index + 1}`,
    key: `${node.key}-${index + 1}`,
    classNodeId: node.id,
    name: `${node.name}·${skill[0]}`,
    description: skill[1],
    target: index === 2 || index === 5 ? SkillTarget.SELF : SkillTarget.ENEMY,
    cost: index === 3 ? 2 : index < 4 ? 1 : 0,
    requiredLevel: node.requiredLevel + Math.min(index, 3),
    effect: skill[2],
    requiredSkillId: index > 0 ? `skill-${node.key}-${index}` : undefined,
    sortOrder: index + 1,
  })),
);

export const EQUIPMENT = [
  equipment(
    'ink-blade',
    '墨线短剑',
    '答对后的伤害略微提高。',
    EquipmentSlot.WEAPON,
    EquipmentRarity.COMMON,
    1,
    { attackMultiplier: 1.06 },
  ),
  equipment(
    'yellow-quill',
    '黄标羽杖',
    '精准命中时更容易积累资源。',
    EquipmentSlot.WEAPON,
    EquipmentRarity.RARE,
    4,
    { attackMultiplier: 1.1, perfectResource: 1 },
  ),
  equipment(
    'margin-bow',
    '页边长弓',
    '连续正确时提高伤害。',
    EquipmentSlot.WEAPON,
    EquipmentRarity.EPIC,
    9,
    { attackMultiplier: 1.16 },
  ),
  equipment(
    'paper-mail',
    '折页轻甲',
    '格挡失败时减少少量伤害。',
    EquipmentSlot.ARMOR,
    EquipmentRarity.COMMON,
    1,
    { blockBonus: 0.08 },
  ),
  equipment(
    'blue-margin',
    '蓝墨守护袍',
    '提高最大生命和格挡效果。',
    EquipmentSlot.ARMOR,
    EquipmentRarity.RARE,
    4,
    { maxHp: 10, blockBonus: 0.1 },
  ),
  equipment(
    'archive-plate',
    '档案重甲',
    '大幅提高生存能力。',
    EquipmentSlot.ARMOR,
    EquipmentRarity.EPIC,
    9,
    { maxHp: 18, blockBonus: 0.12 },
  ),
  equipment(
    'word-charm',
    '生词护符',
    '提高材料收益。',
    EquipmentSlot.ACCESSORY,
    EquipmentRarity.COMMON,
    1,
    { materialBonus: 0.08 },
  ),
  equipment(
    'recall-seal',
    '回忆印章',
    '生产型题目提供更多经验。',
    EquipmentSlot.ACCESSORY,
    EquipmentRarity.RARE,
    4,
    { productionExperience: 0.12 },
  ),
  equipment(
    'cartographer-eye',
    '制图师之眼',
    '同时提高金币与材料收益。',
    EquipmentSlot.ACCESSORY,
    EquipmentRarity.EPIC,
    9,
    { goldBonus: 0.12, materialBonus: 0.12 },
  ),
  equipment(
    'lexicon-edge',
    '词典之锋',
    '把精准召回转化为强力攻击。',
    EquipmentSlot.WEAPON,
    EquipmentRarity.LEGENDARY,
    15,
    { attackMultiplier: 1.22, perfectResource: 1 },
  ),
  equipment(
    'memory-aegis',
    '长忆壁垒',
    '提高生命并强化格挡。',
    EquipmentSlot.ARMOR,
    EquipmentRarity.LEGENDARY,
    15,
    { maxHp: 24, blockBonus: 0.16 },
  ),
  equipment(
    'loop-compass',
    '词环罗盘',
    '显著提高远征结算收益。',
    EquipmentSlot.ACCESSORY,
    EquipmentRarity.LEGENDARY,
    15,
    { goldBonus: 0.16, materialBonus: 0.16, productionExperience: 0.15 },
  ),
];

function equipment(
  key: string,
  name: string,
  description: string,
  slot: EquipmentSlot,
  rarity: EquipmentRarity,
  minFloor: number,
  baseStats: Record<string, number>,
) {
  return { id: `equipment-${key}`, key, name, description, slot, rarity, minFloor, baseStats };
}

export const FLOOR_TITLES = [
  '墨迹入口',
  '回声书库',
  '断句长廊',
  '同义岔路',
  '遗忘矿坑',
  '语序钟楼',
  '表达深井',
  '复述祭坛',
];
export const ENEMIES = ['漏墨史莱姆', '错序蝙蝠', '遗忘菌菇', '近义伪装者', '语法石像', '沉默守卫'];
