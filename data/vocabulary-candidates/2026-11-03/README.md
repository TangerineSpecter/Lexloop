# 日常生活词书候选预览：espresso / crate

**待复核，应用数量 0。** 本目录不在 API 词表资产导入目录中，不会随启动进入数据库。`preview.json` 保留 Excel 行号、工作簿 SHA-256、原字段、义项和候选；`sources/` 是观察到的 Kaikki 页面字段摘录，不是完整原始 JSON 导出。摘录以独立 SHA-256 固定，附 dump 日期、抽取日期和访问日期。

| 词条     | 释义候选    | 英音候选                                       | 美音候选                   | 仍需复核                                                                                           |
| -------- | ----------- | ---------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| espresso | n. 浓缩咖啡 | 三个 Received Pronunciation 变体，保留全部待选 | 一个 General American 读音 | 词书目标义、英国读音变体选择；未选其他名词义                                                       |
| crate    | n. 板条箱   | 不填                                           | 不填                       | 仅选容器名词义；另有动词及其他名词义。IPA 无地区标签，不能从相邻音频标签推断；页面另有翻译抽取警告 |

来源：[espresso](https://kaikki.org/dictionary/English/meaning/e/es/espresso.html)、[crate](https://kaikki.org/dictionary/English/meaning/c/cr/crate.html)。原始词条及作者历史链接见每份 sources JSON。原值均为 `无`；未修改工作簿或生产数据。中文候选选用来源已有的简体中文译词，加 `n.`；未生成新译义，IPA 原样保留。

## 许可与署名

本目录的词典摘录和由其派生的候选内容采用 **Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）**，不适用仓库代码的 MIT 许可。作者为 Wiktionary contributors，数据由 Kaikki / Wiktextract 提取。许可：[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)，依据：[Wiktionary Copyrights](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)、[Kaikki licensing](https://kaikki.org/dictionary/index.html)。来源提供 CC-BY-SA / GFDL，本文选择 CC-BY-SA 4.0 路径。

再分发摘录及其改编需保留署名、来源与许可链接，说明修改，并遵循相同方式共享要求；没有来源方对本项目的背书。没有复制例句引文、音频、图片或其他可能单独授权的素材。此批只做字段选择和词性前缀整理，具体修改记录在 JSON 中。

## 离线核验

运行 `node scripts/verify-vocabulary-candidates.mjs` 检查源工作簿和摘录 hash、原值、义项归属及地区标签；运行 `node --test scripts/verify-vocabulary-candidates.test.mjs` 检查覆盖已有值、虚构译义、从无地区 IPA 推断美音等行为会被拒绝。核验不访问网络、不写数据库；通过仅表示记录可追溯且未越过这些边界，不代表词典义项已获人工批准。

后续补充：此预览属于历史待审快照，验证脚本改为读取本目录 `source-workbook.xlsx`（哈希与原预览记录一致）。当前源文件中的实际应用另见 `data/vocabulary-corrections/2026-11-03`，不把历史预览状态改成批准，也不把本文件中的“未应用”误解为当前源文件状态。
