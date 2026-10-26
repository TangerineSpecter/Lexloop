// Newest first. Keep at most six short items per release; never import into a client component.
type Release = {
  version: string;
  date?: string;
  items: Array<{ title: string; entry: string; usage: string }>;
};

export const RELEASES: readonly Release[] = [
  {
    version: '1.2.0',
    date: '2026-10-26',
    items: [
      {
        title: '微故事语音练习',
        entry: '微故事 → 英文原文或到期复习句',
        usage: '选择正常速度或 0.8 倍慢速播放，边听边跟读；语音由浏览器本地合成。',
      },
    ],
  },
  {
    version: '1.1.1',
    date: '2026-10-22',
    items: [
      {
        title: '个人生词本与统一收藏',
        entry: '首页或侧栏 → 生词本与收藏',
        usage:
          '汇总旅行、阅读、每日一句和手动收藏的词汇，保留原句，支持搜索、来源筛选和复习；句子收藏也可统一回顾。',
      },
      {
        title: '生词短文精读',
        entry: '生词本 → 勾选 1–6 个词 → 用选中词精读',
        usage: '选择材料难度，生成短文，逐句查看译文与讲解，完成读后小测并保存成绩。',
      },
      {
        title: '语法薄弱项专项',
        entry: '首页或侧栏 → 语法薄弱项专项',
        usage:
          '根据近期批改和专项错题生成语法讲解与变式练习，查看原始依据；暂无记录时可直接做基础自测。',
      },
      {
        title: '输出批改恢复修复',
        entry: '首页 → 每日输出挑战',
        usage: '批改服务中途重启后自动等待并恢复处理，减少回答因重试过早而批改失败。',
      },
      {
        title: '对比训练查询优化',
        entry: '首页 → 易混词对比训练',
        usage: '优化已练习词组的判断，减少长期积累训练记录后的查询开销。',
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-22',
    items: [
      {
        title: '每日输出挑战',
        entry: '首页 → 每日输出挑战',
        usage: '用近期学词写一小段英文，查看 AI 逐词与语法反馈，再重写巩固。',
      },
      {
        title: '易混词对比训练',
        entry: '首页 → 易混词对比训练',
        usage: '选择推荐词组，完成语境填空，再对照规则与例句复盘。',
      },
      {
        title: '每周学习处方',
        entry: '首页 → 每周学习处方',
        usage: '根据近 7 天记录查看三项学习建议，点击即可开始对应练习。',
      },
    ],
  },
  {
    version: '1.0.4',
    date: '2026-10-22',
    items: [
      {
        title: '每日一句',
        entry: '学习进度首页 → 每日一句',
        usage:
          '后台每天北京时间 06:00 起提前准备，首页直接展示句子；有未读内容时保留原句，结合学习记录和所选 AI 模型生成。',
      },
      {
        title: '语法解析、回顾与收藏',
        entry: '每日一句 → 查看解析 / 回顾与收藏',
        usage: '查看中文结构拆解、用法讲解与迁移例句，收藏喜欢的句子，并反馈难度以调整后续内容。',
      },
      {
        title: '每日一句全局开关',
        entry: '系统设置 → 功能开关',
        usage: '管理员可启停每日一句；关闭后隐藏首页入口并停止新生成，历史与收藏保留。',
      },
    ],
  },
  {
    version: '1.0.3',
    date: '2026-10-22',
    items: [
      {
        title: '安装与系统更新修复',
        entry: '系统设置 → 系统更新',
        usage:
          '修复首次安装启动失败和更新服务不可用，增加安装健康检查与失败恢复。旧版更新服务无法启动时，需重新执行最新安装脚本修复一次。',
      },
    ],
  },
  {
    version: '1.0.2',
    date: '2026-10-22',
    items: [
      {
        title: '更新记录',
        entry: '首页右上角 → 更新记录',
        usage: '查看版本变化、功能入口和简短用法。',
      },
    ],
  },
  {
    version: '1.0.1',
    date: '2026-10-22',
    items: [
      {
        title: '安装端口设置',
        entry: '服务器安装脚本 → --port 参数',
        usage: '首次安装默认使用 12880，可指定其他端口；已有安装保留原端口。',
      },
    ],
  },
  {
    version: '1.0.0',
    items: [
      {
        title: '地下词环',
        entry: '左侧导航 → 地下词环',
        usage: '选择职业，答题探索地牢，收集装备。',
      },
      {
        title: '旅行场景练习',
        entry: '左侧导航 → 场景口语',
        usage: '完成文字测评，选择场景练习对话；可收藏旅行生词。',
      },
      {
        title: '错题专项与 AI 助手',
        entry: '我的单词 → 待巩固；学习分组或错题详情 → AI 助手',
        usage: '选择薄弱词生成专项，遇到疑问可继续追问；AI 功能需配置可用模型。',
      },
      {
        title: '学习生涯',
        entry: '左侧导航 → 学习统计 → 学习生涯',
        usage: '回看词汇积累、能力变化与薄弱项。',
      },
    ],
  },
];

export const RELEASES_PER_PAGE = 5;
export const releasePageCount = Math.ceil(RELEASES.length / RELEASES_PER_PAGE);
