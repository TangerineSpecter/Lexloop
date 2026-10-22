'use client';

import { useEffect, useState } from 'react';
import type { OutputHistoryItem } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import { FeedbackCard } from './feedback-card';
import styles from './practice.module.css';

export function OutputHistoryPanel({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ items: OutputHistoryItem[]; hasMore: boolean } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResult(null);
    setMessage('');
    request<{ items: OutputHistoryItem[]; hasMore: boolean }>(
      `/practice/output/history?page=${page}`,
      {},
      session.accessToken,
    )
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((error) => {
        if (!cancelled) setMessage(userFacingError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, page, revision, session.accessToken]);
  return (
    <section className={styles.history}>
      <button
        className={styles.secondary}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '收起历史输出' : '查看过去的输出记录'}
      </button>
      {open && (
        <div>
          {message ? (
            <p className={styles.notice} role="alert">
              {message} <button onClick={() => setRevision((value) => value + 1)}>重试</button>
            </p>
          ) : !result ? (
            <p role="status">正在读取历史输出…</p>
          ) : !result.items.length ? (
            <p>还没有过去日期的输出记录。</p>
          ) : (
            result.items.map((item) => (
              <details key={item.id}>
                <summary>
                  <span>{item.date}</span>
                  <strong>
                    {item.feedback
                      ? `${item.feedback.score} 分`
                      : item.status === 'FAILED'
                        ? '未完成'
                        : '批改中'}
                  </strong>
                  <span>查看表达与反馈</span>
                </summary>
                <p>{item.prompt}</p>
                <p className={styles.answerText}>{item.answer}</p>
                {item.error && <p>{item.error}</p>}
                {item.feedback && (
                  <FeedbackCard
                    feedback={item.feedback}
                    daily={{
                      id: item.id,
                      date: item.date,
                      prompt: item.prompt,
                      targets: item.targets,
                      remaining: 0,
                      submissions: [],
                    }}
                  />
                )}
              </details>
            ))
          )}
          {result && (page > 1 || result.hasMore) && (
            <div className={styles.resultBar}>
              <button
                className={styles.secondary}
                disabled={page === 1}
                onClick={() => setPage((value) => value - 1)}
              >
                较新记录
              </button>
              <span>第 {page} 页</span>
              <button
                className={styles.secondary}
                disabled={!result.hasMore}
                onClick={() => setPage((value) => value + 1)}
              >
                更早记录
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
