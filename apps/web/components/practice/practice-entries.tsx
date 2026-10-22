import styles from './practice-entries.module.css';

export function PracticeEntries() {
  return (
    <nav className={styles.entries} aria-label="学习专项">
      <a href="/dashboard/practice?tab=output">
        <small>01 · WRITE</small>
        <strong>
          每日输出挑战 <span aria-hidden="true">↗</span>
        </strong>
        <span>用学过的词，写出自己的表达。</span>
      </a>
      <a href="/dashboard/practice?tab=confusion">
        <small>02 · COMPARE</small>
        <strong>
          易混词对比训练 <span aria-hidden="true">↗</span>
        </strong>
        <span>放进语境，分清词义与搭配。</span>
      </a>
      <a href="/dashboard/practice?tab=weekly">
        <small>03 · PLAN</small>
        <strong>
          每周学习处方 <span aria-hidden="true">↗</span>
        </strong>
        <span>看看这一周，下一步该练什么。</span>
      </a>
    </nav>
  );
}
