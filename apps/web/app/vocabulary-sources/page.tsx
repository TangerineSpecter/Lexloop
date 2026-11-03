import Link from 'next/link';
import type { Metadata } from 'next';
import styles from './sources.module.css';
export const metadata: Metadata = { title: '词条来源与许可 · 词环' };
export const dynamic = 'force-static';
const supplementWords = [
  'surname',
  'toe',
  'divorced',
  'boyfriend',
  'heterosexual',
  'contraceptive',
  'hairdo',
];
const words = ['backache', 'moped', 'crate', 'brownie', 'ceramics', 'espresso'];
export default function VocabularySourcesPage() {
  return (
    <main className={styles.page}>
      <Link href="/about">返回关于词环</Link>
      <h1>词条来源与许可</h1>
      <p>
        日常生活词书的以下补充内容来自 Wiktionary contributors，部分经 Kaikki / Wiktextract 提取。
      </p>
      <p>
        这批补充内容按 <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>{' '}
        使用。转载或改编时请保留作者、来源与许可链接，注明改动，并按相同许可分享改编内容。此说明仅覆盖下列补充字段。
      </p>
      <ul>
        {words.map((word) => (
          <li key={word}>
            <a href={`https://en.wiktionary.org/wiki/${word}`}>{word}</a> ·{' '}
            <a href={`https://en.wiktionary.org/w/index.php?title=${word}&action=history`}>
              贡献历史
            </a>
            ：名词释义{['moped', 'brownie', 'espresso'].includes(word) ? '、英音及美音' : ''}
          </li>
        ))}
      </ul>
      <p>
        改动包括选择中文义项、添加词性标记，以及选择有明确地区标签的音标。未复制例句、录音或图片；未标地区的音标保持缺失。
      </p>
      <p>
        资料核对日期：2026 年 11 月 3 日。Kaikki 数据来自 2026 年 10 月 1 日 Wiktionary
        快照，提取日期为 10 月 30 日；backache 使用修订版 92411821。
      </p>
      <p>
        <a href="https://github.com/TangerineSpecter/Lexloop/tree/master/data/vocabulary-corrections/2026-11-03">
          查看逐词来源、义项和改动记录
        </a>
      </p>
      <p>本次更新补充词书源文件。已有账号的词条仍以数据库为准，不会因源文件更新自动替换。</p>
      <h2>日常补充词书：七个选定义项</h2>
      <p>
        以下缺失释义按同一 CC BY-SA 4.0 许可补充，署名 Wiktionary contributors /
        Kaikki。仅选择经核对的日常义项，不表示完整覆盖一个词的全部含义；未新增音标。
      </p>
      <ul>
        {supplementWords.map((word) => (
          <li key={word}>
            <a href={`https://en.wiktionary.org/wiki/${word}`}>{word}</a> ·{' '}
            <a href={`https://en.wiktionary.org/w/index.php?title=${word}&action=history`}>
              贡献历史
            </a>
            ：{['divorced', 'heterosexual'].includes(word) ? '形容词义项' : '名词义项'}
            {word === 'hairdo' && (
              <>
                ；经其同义词 <a href="https://en.wiktionary.org/wiki/hairstyle">hairstyle</a>{' '}
                的“发型”义核对（
                <a href="https://en.wiktionary.org/w/index.php?title=hairstyle&action=history">
                  贡献历史
                </a>
                ）
              </>
            )}
          </li>
        ))}
      </ul>
      <p>
        这批改动包括选择义项、添加词性、选择简体中文；hairdo
        经同义链选取译词。快照、提取与核对日期分别为 2026-10-01、2026-10-30、2026-11-03。
      </p>
      <p>
        <a href="https://github.com/TangerineSpecter/Lexloop/tree/master/data/vocabulary-corrections/2026-11-03-supplement">
          查看七词来源摘录、许可证、原词库质量审查与改动记录
        </a>
      </p>
      <p>
        新导入仅填源数据缺项。已有安装不会自动替换释义；需管理员先预览受控回填。用户改过的字段、非空释义和学习记录均保留。
      </p>
      <h2>日常用法：五词补义</h2>
      <p>
        以下新增义项由词环根据 Wiktionary contributors 的英语释义译写，按 CC BY-SA 4.0
        分享。保留已有原义，仅增加词性及语境提示；未复制例句、录音、图片或音标。核对日期：2026-11-03。
      </p>
      <ul>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=delivery&amp;oldid=93519327">
            delivery
          </a>{' '}
          ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=delivery&amp;action=history">
            贡献历史
          </a>
          ：n. 分娩；（说话或演唱的）表达方式
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=observation&amp;oldid=93711194">
            observation
          </a>{' '}
          ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=observation&amp;action=history">
            贡献历史
          </a>
          ：n. 评论；观察记录
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=sleep&amp;oldid=93751722">sleep</a> ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=sleep&amp;action=history">
            贡献历史
          </a>
          ：vt. （住宿处）可供……人住宿
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=bend&amp;oldid=93920352">bend</a> ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=bend&amp;action=history">贡献历史</a>
          ：n. （道路等的）弯曲处
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=improvement&amp;oldid=94558893">
            improvement
          </a>{' '}
          ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=improvement&amp;action=history">
            贡献历史
          </a>
          ：n. 改进后的事物
        </li>
      </ul>
      <p>
        <a href="https://github.com/TangerineSpecter/Lexloop/tree/master/data/vocabulary-corrections/2026-11-03-enrichment">
          查看原义、新增义项、版本与审查记录
        </a>
        。许可仅覆盖新增内容。新导入只匹配已审核来源和原值；已有安装需管理员单独预览受控补义，用户编辑不会自动替换。
      </p>
      <h2>日常用法：搭配与延伸义</h2>
      <p>
        以下新增内容根据 Wiktionary contributors 的义项与用法译写，按 CC BY-SA 4.0
        分享，原有释义完整保留。核对日期：2026-11-03；未新增音标或复制例句。
      </p>
      <ul>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=climb&amp;oldid=94550222">climb</a> ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=climb&amp;action=history">
            贡献历史
          </a>
          ：用法：climb 可指借助手脚向上或向下移动，并非总是上升。
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=limb&amp;oldid=93964417">limb</a> ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=limb&amp;action=history">贡献历史</a>
          ：n. 树枝
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=graveyard&amp;oldid=94591757">
            graveyard
          </a>{' '}
          ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=graveyard&amp;action=history">
            贡献历史
          </a>
          ：n. 〈比喻〉废弃物集中存放处
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=bone_up&amp;oldid=94548390">
            bone（bone up）
          </a>{' '}
          ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=bone_up&amp;action=history">
            贡献历史
          </a>
          ：搭配：bone up on ...〈俚〉复习、钻研……。
        </li>
        <li>
          <a href="https://en.wiktionary.org/w/index.php?title=foot&amp;oldid=95411640">foot</a> ·{' '}
          <a href="https://en.wiktionary.org/w/index.php?title=foot&amp;action=history">贡献历史</a>
          ：搭配：foot up to ... 合计达……。
        </li>
      </ul>
      <p>
        foot 的不及物搭配另经{' '}
        <a href="https://www.merriam-webster.com/dictionary/foot%20up">Merriam-Webster</a>{' '}
        核对，仅验证语法事实，未导入其释义或例句。
        <a href="https://github.com/TangerineSpecter/Lexloop/tree/master/data/vocabulary-corrections/2026-11-03-context">
          查看逐词来源、原义和待核项
        </a>
        。已有安装仍需管理员单独预览受控批次，不自动覆盖用户编辑。
      </p>
    </main>
  );
}
