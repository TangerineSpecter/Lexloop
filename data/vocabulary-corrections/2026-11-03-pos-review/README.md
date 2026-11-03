# 既有释义：词性与语境复核

本轮针对 10 个候选做重点义项核查，不把“看过来源”当作“全词通过审核”。其中 beautiful、deliver 是上批待审项；其余 8 个来自此前未审的 80 个词，仍有 72 个未做重点语义审查。逐词结论、原释义 hash 和来源行见 `review.json`，原始 XLSX 完整保留。

## 两处实质修正

- beautiful：只删除原形容词释义中“出色地”“迷人地”两行，保留原有形容词译项。以 [Merriam-Webster beautiful](https://www.merriam-webster.com/dictionary/beautiful) 与 [beautifully](https://www.merriam-webster.com/dictionary/beautifully) 的词性对照核实。
- deliver：只将“投球”行的 `n.` 改为 `vt.`，其他行不变。[American Heritage deliver](https://www.ahdictionary.com/word/search.html?q=deliver) 将投掷义列为及物动词。此修正不代表已认证其余全部中英文释义。

不因“少见”删除合法义项：shaver 的理发师义和 recover 的特殊名词义有来源支持；observe 的庆祝义与观察义并存。pregnancy、nickname、silent、breathing 的部分额外译项尚未充分核实。bite 的普通词义与大写缩略词涉及大小写及专业语境，暂不改动。

## 许可与来源

查阅日期 2026-11-03。商业词典仅用于核对词性事实，不复制其定义、例句或音标；本轮是对项目已有文本做两处精确编辑，不批量引入第三方词典。Wiktionary / Kaikki 衍生的复核说明署名 **Wiktionary contributors**，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分享，逐词链接及贡献历史见 `review.json`。复核说明为改写摘要，不是上游逐字转录或完整快照。项目原始词表的来源权利未因本轮审查获得重新认证。

## 应用及保护边界

新装在读取已核对的指定来源时，只匹配 manifest 中完整原释义；不会改原 XLSX，不覆盖已存在的全局词。不同释义、空值、未知来源都保持不变。日常书词数和释义覆盖率不增加，本轮改善的是两处学习内容。

已有安装只通过独立批次 `daily-existing-pos-2026-11-03-v1` 显式应用。相比之前只填空的批次，本批次允许精确旧值替换，但要求原值完全一致、系统书来源符合该词清单、词形完全一致且 `createdAt === updatedAt`。编辑后即使改回原值也不自动修正。原两批次仍只填空，默认命令仍选择最早六词批次。

回填修改共享全局 `VocabularyWord.meaning`，所有无局部 contextMeaning 的引用词书均可能显示新值。不会修改书本局部释义、音标、词序或学习记录。preview token 绑定实际值；应用与审计同事务，保存完整原值，支持恢复且不覆盖应用后编辑。恢复后不自动重做。不同版本同批次重跑不得修改 manifest，新的修正须使用新批次。

```sh
node dist/vocabulary-corrections.js preview --batch daily-existing-pos-2026-11-03-v1
node dist/vocabulary-corrections.js apply <preview-token> --batch daily-existing-pos-2026-11-03-v1
node dist/vocabulary-corrections.js restore-preview --batch daily-existing-pos-2026-11-03-v1
node dist/vocabulary-corrections.js restore <restore-token> --batch daily-existing-pos-2026-11-03-v1
```

生产 apply/restore 均未执行，未调用付费模型。补充词书仍默认关闭，旧服务未全部升级核对前不得开启。

## 验证结果

- 两个词的精确原值对应 beautiful 9 个、deliver 19 个已核对来源；来源清单及原值由单测逐份 XLSX 验证。113 份原 XLSX hash 与原台账一致。
- 真实 PostgreSQL 全量新装测试导入 113 书后两处修正生效；已有相同旧值不会因再次导入被覆盖。
- 独立批次测试验证两词事务应用、注入审计失败全回滚、并发应用只有一次成功、跨批次 token 拒绝、不同原值/空值/用户编辑/错误来源拒绝；保存原值后恢复只处理未编辑记录，学习记录不变。原有并发编辑屏障测试继续通过。
- API 全量 104 文件 **582/582**，无跳过；脚本 **24/24**；API 类型检查、Nest 构建和改动格式检查通过。独立复核无确定阻断，并独立运行三个批次来源兼容单测 **3/3**。
- 本轮未改 Web、部署配置或数据库结构，未重复无关浏览器和部署测试。首轮新增测试的学习进度字段名有误，已修正并重跑全量，无遗留失败。
