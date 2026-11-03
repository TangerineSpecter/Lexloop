import Link from 'next/link';
import type { Metadata } from 'next';
import styles from './sources.module.css';
export const metadata: Metadata = { title: '词条来源与许可 · 词环' };
export const dynamic = 'force-static';
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
    </main>
  );
}
