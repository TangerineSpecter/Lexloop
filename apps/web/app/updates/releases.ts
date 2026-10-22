// Newest first. Keep at most six short items per release; never import into a client component.
type Release = {
  version: string;
  date?: string;
  items: Array<{ title: string; entry: string; usage: string }>;
};

export const RELEASES: readonly Release[] = [
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
