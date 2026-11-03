# 日常动作及多义词复核

基于 v1.27.159，本轮从尚未重点语义复核的 72 词中审查 9 词，剩余 63 词未做重点审查。“审查过”不等于全部义项获认证。逐词分类、原释义 hash、来源行及参考链接见 `review.json`。

## 只修正两处确定问题

- kick：移除 `vt.` 行中的“反冲，朝后座”，保留“踢”；原 `vi.` 行的“反冲”及名词行不变。[Merriam-Webster](https://www.merriam-webster.com/dictionary/kick) 将枪械反冲列为不及物用法。没有把“后座力”当错字修改，地区词典有该用法。
- whistle：原“吹口哨；鸣汽笛”行的 `vt.` 改为 `vi.`。[Merriam-Webster](https://www.merriam-webster.com/dictionary/whistle) 与 [Collins](https://www.collinsdictionary.com/us/dictionary/english/whistle) 支持这两个无宾语义的标注。whistle 也能用于吹奏某曲调等及物语境，本轮不声称该词只能不及物，也未新增或删除其他译项。

asleep、cold、cheek 的选定义项有依据，保留少见但合法用法。bone、foot、beard 的部分延伸义未充分核实，保留待审；tear 同形异音的两个主要义都成立，但当前扁平字段无法逐义配音，本轮不拆词、不改音标或学习身份。

## 来源、许可及旧数据

查阅日期 2026-11-03。商业词典仅用于核对词性和义项事实，没有复制定义、例句或音标；本轮修改项目已有文本中的标记和重复错位内容，不导入第三方词典数据。所有参考 URL 保留于台账；原始 XLSX 完整保留，来源权利未因此次审查重新获认证。

新装仅对指定词、指定源、完整旧值一致的内容应用修正。既有数据库不因启动或导入被覆盖，原三批次内容及默认行为不变。

操作员可使用独立批次 `daily-verb-senses-2026-11-03-v1` 依次 preview、apply；需已存在词、精确原值、逐词系统来源资格且从未编辑。修改共享全局 meaning，其他无局部释义的引用书也会显示新值。原值与审计在同一事务保存，支持 restore-preview / restore；应用后编辑不覆盖，恢复后不自动重做。不会改局部释义、音标、词序或学习记录。

```sh
node dist/vocabulary-corrections.js preview --batch daily-verb-senses-2026-11-03-v1
node dist/vocabulary-corrections.js apply <preview-token> --batch daily-verb-senses-2026-11-03-v1
node dist/vocabulary-corrections.js restore-preview --batch daily-verb-senses-2026-11-03-v1
node dist/vocabulary-corrections.js restore <restore-token> --batch daily-verb-senses-2026-11-03-v1
```

生产 apply/restore 为 0，未调用付费模型。补充词书仍默认关闭，旧服务全部升级核对前不得开启。

## 验证结果

- kick 的 9 份、whistle 的 10 份源表逐份验证完整旧值；113 份原始 XLSX hash 保持一致。
- 真实 PostgreSQL 全量 113 书新装验证两个修正生效；旧库相同值不会被再次导入覆盖。两组精确替换批次共用参数化数据库回归，覆盖原值保存、跨批次 token 拒绝、错误源和编辑拒绝、事务失败全回滚、并发仅一次成功、幂等和恢复保护；学习记录保持不变。
- API 全量 105 文件 **585/585**，无跳过；脚本 **24/24**；API 类型检查、Nest 构建及改动格式检查通过。独立复核未发现剩余阻断，独立来源兼容单测 **4/4** 通过。
- 新测试首次类型检查发现循环变量遮蔽，已修复并通过完整回归。无遗留失败。本轮未改 Web、部署配置或数据库结构，不重复无关浏览器测试。
