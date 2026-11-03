# 日常补充词书：选定义项与质量审查

本目录的数据摘录和改编释义采用 **CC BY-SA 4.0**，作者为 **Wiktionary contributors**，部分由 **Kaikki/Wiktextract** 抽取；不沿用代码的 MIT 许可。逐词 `entry`、`history`、来源 URL、快照、选定义项与词性记录在 `sources/`。转载须保留署名、来源及[许可链接](https://creativecommons.org/licenses/by-sa/4.0/)，注明改动，按相同许可分享改编内容。

七条内容为 surname（姓氏）、toe（脚趾）、divorced（离了婚的）、boyfriend（男朋友）、heterosexual（异性恋的）、contraceptive（避孕药；避孕用具）、hairdo（发型）。仅覆盖明确选定的名词或形容词义，不声称覆盖全词的全部词性/义项。hairdo 的“发型”经其 hairstyle 同义链接及 hairstyle 的中文义核对；该链两端均保留来源。contraceptive 选名词义，符合原词列中 pregnancy / condom 等主题，而非只把形容词义塞入名词语境。

资料为 enwiktionary 2026-10-01 快照，2026-10-30 提取，2026-11-03 查阅。JSON 是人工选择并转录的必要字段，hash 仅标识这些摘录，**不是完整上游页面/导出的 hash**。部分原页面有其他语言/标记抽取告警，选定中文义项另行核对；没有复制引用例句、图片、录音或音标。审核者是 assistant，未获得人工或词典专家认证。

`quality-review.json` 对92候选逐条保留精确源行与释义hash，不把38组不同字符串自动当作冲突。v1.27.157源表中89词有匹配、84词有非占位释义；4个已有词做了有针对性的词性/语境审查，另外80个已有词尚未完成语义审查。sexuality 的译项/义项对应仍不稳，保留缺项，不将“性别”直接写成其通用释义。joint/palm 的不同义项合法，不能用一义覆盖另一义；beautiful/deliver 的标注问题留待逐义复核，未自动覆盖已有内容。

## 实际应用范围

- 原113份 XLSX 未改。仅在新导入日常书时，给7个确实缺释义的词提供已审的源叠加值；原单词序列、源边界revision和现有用户数据不变。
- 已有数据库不因启动自动填充或覆盖。操作员可选择新批次 `daily-supplement-meanings-2026-11-03-v1`，先 preview，再凭预览token apply。只处理已存在、关联至该词已核对系统来源、从未编辑且 meaning 为 null 的记录；不创建缺失词、不覆盖空字符串或“无”等非null值，不覆盖后来被用户清空的词。
- `sourceKeys` 仅决定回填资格；实际修改的是共享 `VocabularyWord.meaning`。其他引用该全局词且未设置局部 `contextMeaning` 的词书也会显示新释义，并非只修改资格来源书的局部字段。
- 完整旧词库预计4个现存空释义有资格；另外3个词若数据库尚不存在则保留 missing-word。实际以预览为准，不声称生产已经补齐。
- 新批次与旧6词批次独立，省略 `--batch` 仍使用旧批次。apply/restore 保留事务、审计、过期预览拒绝和恢复时编辑保护。操作后不删除学习记录；restore也不删除词。
- `.157` 的补充词书开关仍默认关闭，旧API/Worker/updater未全部升级核对前不得开启。本轮未连接生产、执行生产回填或调用付费模型。

示例（仅说明命令，不表示已在生产执行）：

```sh
node dist/vocabulary-corrections.js preview --batch daily-supplement-meanings-2026-11-03-v1
node dist/vocabulary-corrections.js apply <preview-token> --batch daily-supplement-meanings-2026-11-03-v1
node dist/vocabulary-corrections.js restore-preview --batch daily-supplement-meanings-2026-11-03-v1
node dist/vocabulary-corrections.js restore <restore-preview-token> --batch daily-supplement-meanings-2026-11-03-v1
```
