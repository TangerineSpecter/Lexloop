'use client';

import { useState } from 'react';
import type { DeferredLanguageFeedback } from './travel-deferred-feedback';
import styles from './travel-report-rehearsal.module.css';

type GrammarFrame = { intent: string; natural: string; frame: string; explanation: string };

export function TravelReportRehearsal({
  rewrite,
  grammarFrame,
}: {
  rewrite: DeferredLanguageFeedback | null;
  grammarFrame: GrammarFrame | null;
}) {
  const [attempt, setAttempt] = useState('');
  const [referenceVisible, setReferenceVisible] = useState(false);
  const reference = rewrite?.natural ?? grammarFrame?.natural ?? '';
  const explanation = rewrite?.explanation ?? grammarFrame?.explanation ?? '';

  if (!reference) return null;

  return (
    <section
      className={`${styles.practice} travel-report-rehearsal`}
      aria-labelledby="travel-report-rehearsal-title"
    >
      <div className={styles.heading}>
        <small>4 MIN · TRY IT YOURSELF</small>
        <h3 id="travel-report-rehearsal-title">先改写一句，再对照建议</h3>
      </div>
      {rewrite ? (
        <blockquote className={styles.source}>
          <span>刚才的说法</span>
          <q>{rewrite.original}</q>
        </blockquote>
      ) : grammarFrame ? (
        <div className={styles.prompt}>
          <b>{grammarFrame.intent}</b>
          <span>试着用这个句型说一句符合场景的话：{grammarFrame.frame}</span>
        </div>
      ) : null}
      <label className={styles.label} htmlFor="travel-report-rehearsal-answer">
        先写下你会怎么说
      </label>
      <textarea
        id="travel-report-rehearsal-answer"
        value={attempt}
        onChange={(event) => setAttempt(event.target.value)}
        maxLength={500}
        rows={3}
        spellCheck
        autoComplete="off"
        placeholder="不必写得很长，先试着表达完整意思…"
      />
      {!referenceVisible ? (
        <div className={styles.actions}>
          <button
            type="button"
            disabled={!attempt.trim()}
            onClick={() => setReferenceVisible(true)}
          >
            对照建议
          </button>
          <button
            type="button"
            aria-label="跳过并查看建议"
            className={styles.skip}
            onClick={() => setReferenceVisible(true)}
          >
            跳过，查看建议
          </button>
        </div>
      ) : (
        <article className={styles.reference} aria-live="polite">
          <span>一种自然说法</span>
          <strong>{reference}</strong>
          {explanation && <p>{explanation}</p>}
          <button
            type="button"
            aria-label="收起建议，再试一次"
            className={styles.skip}
            onClick={() => setReferenceVisible(false)}
          >
            收起建议，再试一次
          </button>
        </article>
      )}
      <p className={styles.note}>这是当前页面里的自愿练习，不评分、不保存，也不计入学习进度。</p>
    </section>
  );
}
