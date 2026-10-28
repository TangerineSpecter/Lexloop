'use client';

import { useState } from 'react';
import styles from './practice-entries.module.css';

export function PracticeEntries() {
  const [open, setOpen] = useState(false);
  return (
    <section className={styles.section}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>学习专项</span>
        <small>{open ? '收起' : '展开 7 个入口'}</small>
      </button>
      {open ? (
    <nav className={styles.entries} aria-label="学习专项">
      <a href="/dashboard/micro-stories">
        <small>START · 60 SEC</small>
        <strong>一分钟微故事 <span aria-hidden="true">↗</span></strong>
        <span>从生活场景接着读，理解偏差留到下次复习。</span>
      </a>
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
      <a href="/dashboard/notebook">
        <small>04 · COLLECT</small>
        <strong>
          生词本与收藏 <span aria-hidden="true">↗</span>
        </strong>
        <span>保留原句，统一收藏与复习。</span>
      </a>
      <a href="/dashboard/notebook?tab=reading">
        <small>05 · READ</small>
        <strong>
          生词短文精读 <span aria-hidden="true">↗</span>
        </strong>
        <span>把收藏词放进短文，读懂再做题。</span>
      </a>
      <a href="/dashboard/notebook?tab=grammar">
        <small>06 · GRAMMAR</small>
        <strong>
          语法薄弱项专项 <span aria-hidden="true">↗</span>
        </strong>
        <span>回访表达问题，讲解与变式练习。</span>
      </a>
    </nav>
      ) : null}
    </section>
  );
}
