'use client';
import { Fragment } from 'react';
import type { LabLessonView } from '@lexloop/types';
import type { Session } from '../../lib/api';
import { CollectWordForm } from './collect-word-form';
import { LessonQuiz } from './lesson-quiz';
import styles from './lab.module.css';

function Highlighted({ text, words }: { text: string; words: string[] }) {
  const escaped = words
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return <>{text}</>;
  const regex = new RegExp(`(?<![a-z])(${escaped.join('|')})(?![a-z])`, 'gi');
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index!;
    parts.push(
      <Fragment key={`text-${offset}`}>{text.slice(offset, index)}</Fragment>,
      <mark key={`word-${index}`}>{match[0]}</mark>,
    );
    offset = index + match[0].length;
  }
  parts.push(<Fragment key="last">{text.slice(offset)}</Fragment>);
  return <>{parts}</>;
}
export function LabLesson({
  session,
  lesson,
  busy,
  pollPaused,
  onResume,
  onSubmit,
}: {
  session: Session;
  lesson: LabLessonView;
  busy: boolean;
  pollPaused: boolean;
  onResume: () => void;
  onSubmit: (answers: number[]) => void;
}) {
  if (lesson.status === 'FAILED')
    return (
      <div className={styles.notice} role="alert">
        {lesson.error ?? '生成失败，请重试。'}可点击上方按钮重新生成。
      </div>
    );
  if (!lesson.content)
    return (
      <div className={styles.notice} role="status">
        <p>
          {pollPaused
            ? '已暂停自动查询，可以继续查看结果。'
            : '内容正在后台准备，可以离开页面，之后从历史中继续。'}
        </p>
        <button className={styles.button} onClick={onResume}>
          继续查看
        </button>
      </div>
    );
  const content = lesson.content;
  return (
    <div className={styles.lesson}>
      <article className={styles.card}>
        <small className={styles.eyebrow}>
          {lesson.kind === 'READING' ? 'CLOSE READING' : 'GRAMMAR NOTES'} ·{' '}
          {new Date(lesson.createdAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}
        </small>
        <h3>{content.title}</h3>
        <p>{content.introduction}</p>
        {lesson.kind === 'READING' ? (
          <>
            <p className={styles.meta}>先通读，再按需展开译文和讲解；黄色标记为选中的目标词。</p>
            {content.sentences.map((sentence, index) => (
              <section className={styles.sentence} key={index}>
                <p className={styles.english} lang="en">
                  <Highlighted
                    text={sentence.english}
                    words={content.targets.map((target) => target.text)}
                  />
                </p>
                <details>
                  <summary>译文与句子讲解</summary>
                  <p>{sentence.chinese}</p>
                  <p className={styles.meta}>{sentence.note}</p>
                </details>
                <CollectWordForm
                  session={session}
                  sourceType="READING"
                  source={content.title}
                  example={sentence.english}
                />
              </section>
            ))}
            <h4>这次重逢的词</h4>
            {content.targets.map((target) => (
              <p key={target.id}>
                <strong lang="en">{target.text}</strong> · {target.meaning}
              </p>
            ))}
          </>
        ) : (
          <>
            <p className={styles.meta}>
              以下为模型根据批改线索整理的练习建议，不代表完整语法诊断。无对应记录的类别标为基础补充。
            </p>
            {content.topics.map((topic) => (
              <section className={styles.topic} key={topic.key}>
                <h4>{topic.title}</h4>
                <span className={styles.badge}>
                  {topic.evidenceIds.length ? `${topic.evidenceIds.length} 条批改线索` : '基础补充'}
                </span>
                <p>{topic.explanation}</p>
                {topic.evidenceIds.length > 0 && (
                  <details>
                    <summary>查看原始批改依据</summary>
                    {topic.evidenceIds.map((id) => {
                      const item = lesson.evidence.find((evidence) => evidence.id === id);
                      return item ? (
                        <blockquote key={id}>
                          <small>{item.source}</small>
                          <p lang="en">原文：{item.original}</p>
                          <p lang="en">参考改写：{item.corrected}</p>
                          <p>{item.feedback}</p>
                        </blockquote>
                      ) : null;
                    })}
                  </details>
                )}
              </section>
            ))}
          </>
        )}
      </article>
      <LessonQuiz
        key={`${session.user.id}:${lesson.id}`}
        lesson={lesson}
        userId={session.user.id}
        busy={busy}
        onSubmit={onSubmit}
      />
    </div>
  );
}
