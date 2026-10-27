'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOutput, OutputFeedback, OutputSubmissionView } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import styles from './practice.module.css';
import { FeedbackCard } from './feedback-card';
import { OutputHistoryPanel } from './output-history-panel';

export function DailyOutputPanel({ session }: { session: Session }) {
  const [daily, setDaily] = useState<DailyOutput | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const started = useRef(Date.now());
  const submissionKey = useRef<{ answer: string; id: string } | null>(null);
  const draftKey = `lexloop.output.draft.${session.user.id}`;
  const load = useCallback(async () => {
    const result = await request<DailyOutput | null>(
      '/practice/output/today',
      {},
      session.accessToken,
    );
    setDaily(result);
    return result;
  }, [session.accessToken]);
  useEffect(() => {
    let cancelled = false;
    request<DailyOutput | null>('/practice/output/today', {}, session.accessToken)
      .then((result) => {
        if (cancelled) return;
        setDaily(result);
        setLoaded(true);
        if (result) {
          try {
            const draft = JSON.parse(
              localStorage.getItem(`lexloop.output.draft.${session.user.id}`) ?? 'null',
            );
            setAnswer(
              draft?.date === result.date && typeof draft.answer === 'string'
                ? draft.answer.slice(0, 1800)
                : '',
            );
          } catch {
            /* Storage is optional. */
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(userFacingError(error));
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken, session.user.id]);
  const pending = daily?.submissions.find(
    (item) => item.status === 'QUEUED' || item.status === 'PROCESSING',
  );
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let running = false;
    let count = 0;
    const abort = new AbortController();
    setPaused(false);
    const timer = window.setInterval(async () => {
      if (running || document.visibilityState !== 'visible') return;
      if (count++ >= 40) {
        setPaused(true);
        window.clearInterval(timer);
        return;
      }
      running = true;
      try {
        const result = await request<OutputSubmissionView>(
          `/practice/output/submissions/${pending.id}`,
          { signal: abort.signal },
          session.accessToken,
        );
        if (cancelled) return;
        setDaily((current) =>
          current
            ? {
                ...current,
                submissions: current.submissions.map((item) =>
                  item.id === result.id ? result : item,
                ),
              }
            : current,
        );
        if (result.status === 'COMPLETED' || result.status === 'FAILED') {
          window.clearInterval(timer);
          await load();
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(userFacingError(error));
          setPaused(true);
          window.clearInterval(timer);
        }
      } finally {
        running = false;
      }
    }, 3000);
    return () => {
      cancelled = true;
      abort.abort();
      window.clearInterval(timer);
    };
  }, [pending?.id, pollRevision, session.accessToken, load]);

  const changeAnswer = (text: string) => {
    setAnswer(text);
    try {
      if (draftKey)
        localStorage.setItem(draftKey, JSON.stringify({ date: daily?.date, answer: text }));
    } catch {
      /* Keep the in-memory draft. */
    }
  };
  async function submit() {
    if (!daily || busy || pending) return;
    setBusy(true);
    setMessage('');
    if (!submissionKey.current || submissionKey.current.answer !== answer.trim())
      submissionKey.current = { answer: answer.trim(), id: crypto.randomUUID() };
    try {
      await request(
        `/practice/output/${daily.id}/submissions`,
        {
          method: 'POST',
          body: JSON.stringify({
            answer: answer.trim(),
            clientRequestId: submissionKey.current.id,
            responseTimeMs: Math.min(3_600_000, Date.now() - started.current),
          }),
        },
        session.accessToken,
      );
      await load();
      submissionKey.current = null;
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }
  const latest = daily?.submissions.find((item) => item.status === 'COMPLETED');
  if (!loaded)
    return (
      <p className={styles.empty} role="status">
        正在准备今天的目标词…
      </p>
    );
  if (!daily)
    return (
      <section className={styles.empty}>
        <h2>{message ? '挑战暂时未能加载' : '先选一本词书'}</h2>
        <p>{message || '选好词书或完成一组学习后，系统会从你的学习词汇中准备输出挑战。'}</p>
        <a href="/dashboard">返回首页选择词书 →</a>
        {message && (
          <button
            onClick={() => {
              setLoaded(false);
              void load()
                .then(() => {
                  setLoaded(true);
                  setMessage('');
                })
                .catch((error) => {
                  setLoaded(true);
                  setMessage(userFacingError(error));
                });
            }}
          >
            重新加载
          </button>
        )}
      </section>
    );
  return (
    <section aria-labelledby="output-title">
      <header className={styles.sectionHead}>
        <div>
          <small>{daily.date} · DAILY OUTPUT</small>
          <h2 id="output-title">今天，用这几个词写一段话。</h2>
        </div>
        <span className={styles.badge}>剩余 {daily.remaining} 次</span>
      </header>
      <div className={styles.outputGrid}>
        <section className={styles.card}>
          <div className={styles.targets}>
            {daily.targets.map((target) => (
              <div key={target.bookWordId}>
                <strong>{target.word}</strong>
                <span>{target.meaning}</span>
              </div>
            ))}
          </div>
          <p className={styles.prompt}>{daily.prompt}</p>
          <label className={styles.label} htmlFor="output-answer">
            你的英文表达
          </label>
          <textarea
            id="output-answer"
            value={answer}
            maxLength={1800}
            rows={8}
            disabled={!!pending || busy}
            onChange={(event) => changeAnswer(event.target.value)}
            placeholder="从一个简单的句子开始，再把几个目标词连起来。"
          />
          <div className={styles.formMeta}>
            <span>
              {answer.match(/[a-z]+/gi)?.length ?? 0} 个英文词 · {answer.length}/1800 字符
            </span>
            <span>草稿保存在本机</span>
          </div>
          {message && (
            <p className={styles.notice} role="alert">
              {message}
            </p>
          )}
          {pending ? (
            <div className={styles.notice} role="status">
              <strong>
                {paused
                  ? '回答已保存，批改结果稍后可查看。'
                  : pending.status === 'QUEUED'
                    ? '回答已保存，正在等待批改…'
                    : '正在检查用词、语法和表达…'}
              </strong>
              {paused && (
                <button onClick={() => setPollRevision((value) => value + 1)}>查看批改进度</button>
              )}
            </div>
          ) : (
            <button
              className={styles.primary}
              disabled={
                busy || daily.remaining === 0 || (answer.match(/[a-z]+/gi)?.length ?? 0) < 4
              }
              onClick={() => void submit()}
            >
              {busy ? '正在提交…' : latest ? '提交重写' : '提交批改'}{' '}
              <span aria-hidden="true">↗</span>
            </button>
          )}
          <p className={styles.hint}>
            批改需要已选择可用的 AI 模型。离开页面后仍会继续，回到这里查看结果。
          </p>
        </section>
        <aside>
          {latest?.feedback ? (
            <FeedbackCard
              feedback={latest.feedback}
              daily={daily}
              originalAnswer={latest.answer}
              onRewrite={() => {
                changeAnswer(latest.answer);
                document.getElementById('output-answer')?.focus();
              }}
            />
          ) : (
            <div className={`${styles.card} ${styles.note}`}>
              <small>FROM KNOWING TO USING</small>
              <h3>不只选对，还要写出来。</h3>
              <ol>
                <li>用目标词表达一个完整意思。</li>
                <li>查看每个词的用法与语法建议。</li>
                <li>自己重写，再检查一次。</li>
              </ol>
              <p>反馈会区分“未使用”和“用法待改进”，不会把只出现过的词算作正确运用。</p>
            </div>
          )}
        </aside>
      </div>
      {daily.submissions.length > 0 && (
        <section className={styles.history}>
          <h3>今天的表达记录</h3>
          {daily.submissions.map((item) => (
            <details key={item.id}>
              <summary>
                <span>
                  {new Date(item.createdAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <strong>
                  {item.status === 'COMPLETED'
                    ? `${item.feedback?.score ?? 0} 分`
                    : item.status === 'FAILED'
                      ? '未完成'
                      : '批改中'}
                </strong>
                <span>查看回答与反馈</span>
              </summary>
              {item.error && <p className={styles.notice}>{item.error}</p>}
              {item.feedback ? (
                <FeedbackCard feedback={item.feedback} daily={daily} originalAnswer={item.answer} />
              ) : (
                <p className={styles.answerText}>{item.answer}</p>
              )}
            </details>
          ))}
        </section>
      )}
      <OutputHistoryPanel session={session} />
    </section>
  );
}
