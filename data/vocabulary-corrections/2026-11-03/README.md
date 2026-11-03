# 日常词书已核对补丁（2026-11-03）

本批次实际修改源词书 **6 个词、12 个字段**：backache、moped、crate、brownie、ceramics、espresso 的名词释义；moped、brownie、espresso 的英音与美音。不是全书补齐，也没有词频语料支持“最高频”排序。来源摘录、候选选择与应用分开记录；不覆盖已有值、不调整词面或行顺序。

## 来源和许可

作者为 **Wiktionary contributors**。除 backache 直接取自 Wiktionary 修订版 92411821 外，使用 Kaikki/Wiktextract 的 enwiktionary-2026-10-01 快照、2026-10-30 提取版本。逐词 URL、历史、义项 ID、中文译词、带自身地区标签的 IPA、检索时间及许可见 `sources/*.json`；SHA-256 见 `manifest.json`。

这些摘录及派生字段按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分享，许可依据为 [Wiktionary:Copyrights](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)。保留作者、来源/历史、许可链接和改动说明；再分发改编内容遵守相同方式共享要求。仓库代码的 MIT 许可不替代这些数据的许可，也不据此为旧词书整体重新授权。源 XLSX 的第二张表“来源与许可”随文件携带逐词归属；产品“关于词环 → 词条来源与许可”提供归属入口。

改动仅为选取已有中文义项、添加 `n.` 标记、选择适用地区 IPA。espresso 选首个 RP 变体，其余变体仍保留。未复制例句引用、音频或图片。JSON 是从可访问网页逐项摘录，不是未经处理的完整导出；原始 JSON 下载在本环境返回 HTTP 403，不假装已完成自动抓取。已有两个候选的原始摘录也保留不变。

## 可重复提取与核验流程

1. 从缺失报告选择可独立识别的词面，确认源词书准确行号及前后两行。多词拼接、拼写可疑及无法判定词性者留待审，不能先拆词再猜义。
2. 打开 `sources/*.json` 中的词条和历史 URL；选定词性、义项和中文译词，录入最小摘录。检查 IPA 记录自己的地区标签；音频标签不可借用。记录快照/修订版、许可、作者及改动。网页变化时新建批次，不覆盖历史快照。
3. `manifest.json` 从摘录选择准确候选，并保留原值、行号、上下文和理由。测试会拒绝来源外译词、错词性、无地区 IPA、已有字段覆盖、重复条目与来源缺失。
4. 本批 **6/6 逐词对照核验由助手完成**，`review.kind=assistant-source-review`，`humanApproval=null`。不冒称人工审校或专业词典质量认证。人工复核者可依前两步逐条复现，重点核对 moped 异音异义、brownie 食品义、ceramics 制品义、espresso 地区变体；若发现分歧新开修订，不修改既有值。
5. `node scripts/apply-vocabulary-corrections.mjs` 只验证已应用源文件；`--apply-source` 只在目标仍为记录的精确原始哈希时写入，已应用时验证并保持不变，其他漂移拒绝。不读取环境密钥、不联网、不访问数据库。
6. `node --test scripts/apply-vocabulary-corrections.test.mjs scripts/verify-vocabulary-candidates.test.mjs` 对照归档源文件逐单元格检查。此前两条候选预览改用其原始工作簿归档校验，保留历史“待审”状态；本批应用结果单独记录。

## 实际结果与保留项

日常词书 1,177 行：缺释义 1,115 → **1,109**；缺英音和美音分别 1,120 → **1,117**。全库 113 词书：缺释义 14,296 → **14,290**；缺英美音分别 37,613 → **37,610**。均为源行完整度，包含重复，不代表准确率或线上覆盖率。

crate/backache 的 IPA 无地区标签，ceramics 只有录音没有 IPA，6 个地区字段保持缺失。其余大量拼接行、来源不明项和旧冲突均保留。没有使用 ECDICT、FreeDict、付费模型或推测生成内容。

**已有数据库应用数为 0**。种子导入只创建缺失词条、`skipDuplicates` 保留现有词条；修改源文件不会修复现有账号中的旧缺口。本轮不创建线上回填操作、不操作生产。全新数据库可从这份源文件导入补充内容；以后要同步已有库，需另行实现带审计的仅补空更新，并测试学习进度不变。
