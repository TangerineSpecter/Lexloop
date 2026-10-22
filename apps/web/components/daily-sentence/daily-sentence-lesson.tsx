import { CollectWordForm } from '../learning-lab/collect-word-form';
import type { Session } from '../../lib/api';
import type { DailySentenceItem } from '@lexloop/types';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import styles from './daily-sentence.module.css';

export function DailySentenceLesson({ item, session, saving, onUpdate }: { session: Session; item: DailySentenceItem; saving: boolean; onUpdate: (update: { favorite?: boolean; difficulty?: 'EASY' | 'RIGHT' | 'HARD' }) => void }) {
  const content = item.content;
  return <article className={styles.lesson}>
    <header className={styles.lessonHeader}>
      <div><p className={styles.meta}>{item.dateKey} · {content.level}</p><h2>{content.focus}</h2></div>
      <button className={styles.button} aria-pressed={item.favorite} disabled={saving} onClick={() => onUpdate({ favorite: !item.favorite })}>{item.favorite ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}{item.favorite ? '已收藏' : '收藏'}</button>
    </header>
    <p className={styles.english} lang="en">{content.english}</p>
    <p>{content.chinese}</p>
    <CollectWordForm session={session} sourceType="DAILY_SENTENCE" source={`每日一句 · ${item.dateKey}`} example={content.english} />
    <section className={styles.section} aria-label="句子结构拆解">
      <h3>先看这句话怎么搭起来</h3>
      <div className={styles.chunks}>{content.chunks.map((chunk, index) => <div className={styles.chunk} key={index}>
        <span className={styles.chunkText} lang="en">{chunk.text}</span>
        <strong>{chunk.role}</strong><small>{chunk.phraseType}</small>
        <p>{chunk.explanation}</p>
      </div>)}</div>
      <p className={styles.note}>主语、谓语、状语说明它在句中做什么；名词短语、介词短语说明它由什么组成。</p>
    </section>
    <section className={styles.section}><h3>为什么这样写？</h3>{content.explanations.map((entry, index) => <div className={styles.explanation} key={index}><h4>{entry.question}</h4><p>{entry.answer}</p></div>)}</section>
    <section className={styles.section}><h3>换个场景，你也可以这样说</h3><p className={styles.pattern}>{content.pattern}</p><p>{content.usage}</p><blockquote><p lang="en">{content.example.english}</p><p>{content.example.chinese}</p></blockquote></section>
    <p className={styles.note}>选句依据：{content.learningReason} · AI 生成解析</p>
    <fieldset className={styles.feedback} disabled={saving}><legend>这句对你来说怎么样？</legend>{([['EASY', '太简单'], ['RIGHT', '刚刚好'], ['HARD', '有点难']] as const).map(([value, label]) => <button type="button" className={styles.button} aria-pressed={item.difficulty === value} key={value} onClick={() => onUpdate({ difficulty: value })}>{label}</button>)}<p className={styles.note}>反馈用于调整后续内容，打开解析不会自动计入掌握。</p></fieldset>
  </article>;
}
