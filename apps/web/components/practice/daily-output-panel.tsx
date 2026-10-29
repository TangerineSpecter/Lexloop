'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOutput, OutputFeedback, OutputSubmissionView } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import {
  clearOutputDraftSubmissionIfMatches,
  readOutputDraft,
  saveOutputDraft,
} from '../../lib/output-drafts';
import styles from './practice.module.css';
import { FeedbackCard } from './feedback-card';
import { OutputHistoryPanel } from './output-history-panel';
import { ReadingModelDrawer } from '../reading-model-drawer';

export function DailyOutputPanel({ session }: { session: Session }) {
  const [daily, setDaily] = useState<DailyOutput | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const modelSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const answerStartedAt = useRef<number | null>(null);
  const submitting = useRef(false);
  const loadedDraftIdentity = useRef<{ challengeId: string; date: string } | null>(null);
  const finishedRequestIds = useRef(new Set<string>());
  const submissionKey = useRef<{
    userId: string;
    challengeId: string;
    date: string;
    answer: string;
    id: string;
    responseTimeMs: number;
  } | null>(null);
  const finishSubmission = useCallback(
    (
      identity: { userId: string; challengeId: string; date: string },
      finishedAnswer: string,
      clientRequestId: string,
      expired = false,
    ) => {
      const current = submissionKey.current;
      if (
        !current ||
        current.userId !== identity.userId ||
        current.challengeId !== identity.challengeId ||
        current.date !== identity.date ||
        current.answer !== finishedAnswer ||
        current.id !== clientRequestId
      )
        return;
      const submission = {
        answer: current.answer,
        id: current.id,
        responseTimeMs: current.responseTimeMs,
      };
      finishedRequestIds.current.add(current.id);
      submissionKey.current = null;
      answerStartedAt.current = expired ? Date.now() : null;
      if (clearOutputDraftSubmissionIfMatches(identity, submission)) setDraftSaved(true);
    },
    [],
  );
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
          const identity = {
            userId: session.user.id,
            challengeId: result.id,
            date: result.date,
          };
          const restored = readOutputDraft(identity);
          const matchingSubmission = restored.submission
            ? result.submissions.find((item) => item.clientRequestId === restored.submission?.id)
            : undefined;
          const expiredSubmission =
            matchingSubmission?.status === 'FAILED' &&
            /超时|过期/.test(matchingSubmission.error ?? '');
          const restoredSubmissionFinished =
            matchingSubmission?.status === 'COMPLETED' || expiredSubmission;
          if (restoredSubmissionFinished && restored.submission) {
            finishedRequestIds.current.add(restored.submission.id);
            if (clearOutputDraftSubmissionIfMatches(identity, restored.submission))
              setDraftSaved(true);
            answerStartedAt.current = expiredSubmission ? Date.now() : null;
          }
          const previousIdentity = loadedDraftIdentity.current;
          const sameChallenge =
            previousIdentity?.challengeId === result.id && previousIdentity.date === result.date;
          const restoredAnswer = sameChallenge ? answer : restored.answer;
          setAnswer(restoredAnswer);
          setDraftSaved(restored.storageAvailable);
          loadedDraftIdentity.current = { challengeId: result.id, date: result.date };

          const currentKey = submissionKey.current;
          if (restoredSubmissionFinished) {
            submissionKey.current = null;
          } else if (
            currentKey &&
            currentKey.userId === session.user.id &&
            currentKey.challengeId === result.id &&
            currentKey.date === result.date &&
            currentKey.answer === restoredAnswer.trim()
          ) {
            // Keep the in-memory request identity when storage is unavailable.
          } else {
            submissionKey.current = restored.submission
              ? {
                  ...identity,
                  answer: restored.submission.answer,
                  id: restored.submission.id,
                  // Older local drafts did not record timing; do not infer it later.
                  responseTimeMs: restored.submission.responseTimeMs ?? 0,
                }
              : null;
          }
        } else {
          setAnswer('');
          submissionKey.current = null;
          answerStartedAt.current = null;
          loadedDraftIdentity.current = null;
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
  const outputIdentity = daily
    ? { userId: session.user.id, challengeId: daily.id, date: daily.date }
    : null;
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
        const expired = result.status === 'FAILED' && /超时|过期/.test(result.error ?? '');
        if (outputIdentity && (result.status === 'COMPLETED' || expired)) {
          finishSubmission(outputIdentity, result.answer, result.clientRequestId, expired);
        }
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
  }, [
    pending?.id,
    pollRevision,
    session.accessToken,
    session.user.id,
    outputIdentity?.challengeId,
    outputIdentity?.date,
    finishSubmission,
    load,
  ]);

  const changeAnswer = (text: string) => {
    setAnswer(text);
    if (!daily) return;
    const identity = { userId: session.user.id, challengeId: daily.id, date: daily.date };
    const currentKey = submissionKey.current;
    const matchingSubmission =
      currentKey &&
      currentKey.userId === identity.userId &&
      currentKey.challengeId === identity.challengeId &&
      currentKey.date === identity.date &&
      currentKey.answer === text.trim()
        ? {
            answer: currentKey.answer,
            id: currentKey.id,
            responseTimeMs: currentKey.responseTimeMs,
          }
        : null;
    if (!matchingSubmission) {
      answerStartedAt.current =
        currentKey || (answerStartedAt.current === null && text.trim())
          ? Date.now()
          : answerStartedAt.current;
      submissionKey.current = null;
    }
    setDraftSaved(saveOutputDraft(identity, text, matchingSubmission));
  };
  async function submit() {
    if (!daily || busy || submitting.current || pending) return;
    submitting.current = true;
    setBusy(true);
    setMessage('');
    const identity = { userId: session.user.id, challengeId: daily.id, date: daily.date };
    const submittedAnswer = answer.trim();
    let currentKey = submissionKey.current;
    if (
      !currentKey ||
      currentKey.userId !== identity.userId ||
      currentKey.challengeId !== identity.challengeId ||
      currentKey.date !== identity.date ||
      currentKey.answer !== submittedAnswer
    ) {
      const restored = readOutputDraft(identity);
      const submission =
        restored.answer.trim() === submittedAnswer &&
        restored.submission &&
        !finishedRequestIds.current.has(restored.submission.id)
          ? restored.submission
          : null;
      currentKey = {
        ...identity,
        answer: submittedAnswer,
        id: submission?.id ?? crypto.randomUUID(),
        responseTimeMs:
          submission?.responseTimeMs ??
          Math.min(3_600_000, Math.max(0, Date.now() - (answerStartedAt.current ?? Date.now()))),
      };
      submissionKey.current = currentKey;
    }
    const requestIdentity = {
      answer: currentKey.answer,
      id: currentKey.id,
      responseTimeMs: currentKey.responseTimeMs,
    };
    setDraftSaved(saveOutputDraft(identity, answer, requestIdentity));
    try {
      const submitted = await request<OutputSubmissionView>(
        `/practice/output/${daily.id}/submissions`,
        {
          method: 'POST',
          body: JSON.stringify({
            answer: submittedAnswer,
            clientRequestId: currentKey.id,
            responseTimeMs: currentKey.responseTimeMs,
          }),
        },
        session.accessToken,
      );
      const expired = submitted.status === 'FAILED' && /超时|过期/.test(submitted.error ?? '');
      if (submitted.status === 'COMPLETED' || expired) {
        finishSubmission(identity, submitted.answer, submitted.clientRequestId, expired);
      }
      await load();
      if (submitted.status === 'FAILED') {
        setMessage(
          expired
            ? '这份批改任务已超过 15 分钟有效期，原文已保留；再次点击提交会创建新的批改任务。'
            : submitted.error || '这次批改未完成，原文已保留；可以再次提交。',
        );
      }
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const latest = daily?.submissions.find((item) => item.status === 'COMPLETED');
  const needsModelSelection = message.includes('阅读材料模型设置');
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
          <h2 id="output-title">今天，用这些词或短语写一段话。</h2>
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
            onFocus={() => {
              if (!submissionKey.current && answerStartedAt.current === null)
                answerStartedAt.current = Date.now();
            }}
            onChange={(event) => changeAnswer(event.target.value)}
            placeholder="从一个简单的句子开始，再把几个目标词连起来。"
          />
          <div className={styles.formMeta}>
            <span>
              {answer.match(/[a-z]+/gi)?.length ?? 0} 个英文词 · {answer.length}/1800 字符
            </span>
            <span>
              {!draftSaved
                ? '本机保存不可用，刷新后可能丢失'
                : answer
                  ? '草稿保存在本机'
                  : '输入会保存在本机'}
            </span>
          </div>
          {message && (
            <p className={styles.notice} role="alert">
              {message}
            </p>
          )}
          {needsModelSelection && (
            <button
              ref={modelSettingsTriggerRef}
              className={styles.secondary}
              type="button"
              onClick={() => setModelSettingsOpen(true)}
            >
              打开阅读材料模型设置
            </button>
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
      {modelSettingsOpen && (
        <ReadingModelDrawer
          session={session}
          onClose={() => {
            setModelSettingsOpen(false);
            window.requestAnimationFrame(() => {
              if (modelSettingsTriggerRef.current) modelSettingsTriggerRef.current.focus();
              else document.getElementById('output-answer')?.focus();
            });
          }}
          onModelSelected={() => setMessage('')}
        />
      )}
    </section>
  );
}
