'use client';

import { useEffect, useRef, useState } from 'react';
import type { OutputHistoryItem } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import { FeedbackCard } from './feedback-card';
import styles from './practice.module.css';

export function OutputHistoryPanel({ session }: { session: Session }) {
  return <OutputHistoryPanelForUser key={session.user.id} session={session} />;
}

function OutputHistoryPanelForUser({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [attempts, setAttempts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const focusAfterUpdate = useRef<{ itemId: string; target: 'answer' | 'attempt' } | null>(null);
  const [result, setResult] = useState<{ items: OutputHistoryItem[]; hasMore: boolean } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  useEffect(() => {
    const pending = focusAfterUpdate.current;
    if (!pending) return;
    const id =
      pending.target === 'answer'
        ? `output-history-answer-${pending.itemId}`
        : `output-history-attempt-${pending.itemId}`;
    document.getElementById(id)?.focus();
    focusAfterUpdate.current = null;
  }, [attempts, revealed]);
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
  function reveal(itemId: string) {
    focusAfterUpdate.current = { itemId, target: 'answer' };
    setRevealed((current) => ({ ...current, [itemId]: true }));
  }
  function tryAgain(itemId: string) {
    focusAfterUpdate.current = { itemId, target: 'attempt' };
    setRevealed((current) => ({ ...current, [itemId]: false }));
    setAttempts((current) => ({ ...current, [itemId]: '' }));
  }
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
                <p className={styles.historyPrompt}>{item.prompt}</p>
                <div className={styles.targets} role="group" aria-label="本次目标词或短语">
                  {item.targets.map((target) => (
                    <div key={target.bookWordId}>
                      <strong>{target.word}</strong>
                      <span>{target.meaning}</span>
                    </div>
                  ))}
                </div>
                <section className={styles.historyRecall} aria-label="回想练习">
                  <h4>先试着重写（可跳过）</h4>
                  <p className={styles.hint}>
                    试写只暂存在当前页面，刷新或切换账号后清除；不会保存、批改或计入练习次数。
                  </p>
                  {revealed[item.id] ? (
                    <>
                      {attempts[item.id]?.trim() && (
                        <div className={styles.example}>
                          <h4>你的试写</h4>
                          <p lang="en" className={styles.answerText}>
                            {attempts[item.id]}
                          </p>
                        </div>
                      )}
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => tryAgain(item.id)}
                      >
                        再试一次（先隐藏对照）
                      </button>
                    </>
                  ) : (
                    <>
                      <label className={styles.label} htmlFor={`output-history-attempt-${item.id}`}>
                        你的新版本
                      </label>
                      <textarea
                        id={`output-history-attempt-${item.id}`}
                        rows={4}
                        maxLength={1800}
                        value={attempts[item.id] ?? ''}
                        onChange={(event) =>
                          setAttempts((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                        placeholder="试着换一种表达，也可以留空直接查看原记录。"
                      />
                      <div className={styles.historyRecallActions}>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={!attempts[item.id]?.trim()}
                          onClick={() => reveal(item.id)}
                        >
                          试写后查看对照
                        </button>
                        <button
                          type="button"
                          className={styles.secondary}
                          onClick={() => reveal(item.id)}
                        >
                          直接查看原记录
                        </button>
                      </div>
                    </>
                  )}
                </section>
                {revealed[item.id] && (
                  <>
                    <h4 id={`output-history-answer-${item.id}`} tabIndex={-1}>
                      {item.feedback ? '上次回答与反馈' : '上次回答'}
                    </h4>
                    {item.error && <p>{item.error}</p>}
                    {item.feedback ? (
                      <FeedbackCard
                        feedback={item.feedback}
                        originalAnswer={item.answer}
                        daily={{
                          id: item.id,
                          date: item.date,
                          prompt: item.prompt,
                          targets: item.targets,
                          remaining: 0,
                          submissions: [],
                        }}
                      />
                    ) : (
                      <p className={styles.answerText}>{item.answer}</p>
                    )}
                  </>
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
