'use client';

import { useEffect, useRef, useState } from 'react';
import type { ContrastGroup, ContrastResult } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import styles from './practice.module.css';

type HistoryRow = {
  id: string;
  groupId: string;
  correctCount: number;
  total: number;
  answers: ContrastResult['results'];
  createdAt: string;
};
export function ConfusionPanel({ session }: { session: Session }) {
  const [groups, setGroups] = useState<ContrastGroup[]>([]);
  const [groupId, setGroupId] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ContrastResult | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [message, setMessage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const started = useRef(Date.now());
  const requestKey = useRef<{ payload: string; id: string } | null>(null);
  const group = groups.find((item) => item.id === groupId);
  useEffect(() => {
    let cancelled = false;
    setMessage('');
    Promise.all([
      request<ContrastGroup[]>('/practice/confusion', {}, session.accessToken),
      request<HistoryRow[]>('/practice/confusion/history', {}, session.accessToken),
    ])
      .then(([items, records]) => {
        if (cancelled) return;
        setGroups(items);
        setHistory(records);
        setLoaded(true);
        const focus = new URLSearchParams(window.location.search).get('group');
        setGroupId(
          (current) => current || items.find((item) => item.id === focus)?.id || items[0]?.id || '',
        );
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
  }, [session.accessToken, revision]);
  function choose(id: string) {
    if (busy) return;
    setGroupId(id);
    setAnswers({});
    setResult(null);
    setShowNotes(false);
    setMessage('');
    requestKey.current = null;
    started.current = Date.now();
  }
  async function submit() {
    if (!group || busy || result) return;
    const payload = group.questions.map((q) => ({ questionId: q.id, selected: answers[q.id] }));
    const signature = JSON.stringify({ groupId, payload });
    if (!requestKey.current || requestKey.current.payload !== signature)
      requestKey.current = { payload: signature, id: crypto.randomUUID() };
    setBusy(true);
    setMessage('');
    try {
      const saved = await request<ContrastResult>(
        `/practice/confusion/${group.id}/attempts`,
        {
          method: 'POST',
          body: JSON.stringify({
            answers: payload,
            clientRequestId: requestKey.current.id,
            responseTimeMs: Math.min(3_600_000, Date.now() - started.current),
          }),
        },
        session.accessToken,
      );
      setResult(saved);
      setShowNotes(true);
      setHistory((current) =>
        [
          {
            id: saved.id,
            groupId: saved.groupId,
            correctCount: saved.correctCount,
            total: saved.total,
            answers: saved.results,
            createdAt: new Date().toISOString(),
          },
          ...current.filter((row) => row.id !== saved.id),
        ].slice(0, 20),
      );
      setGroups((current) =>
        current.map((item) => (item.id === groupId ? { ...item, practiced: true } : item)),
      );
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }
  if (!loaded)
    return (
      <p className={styles.empty} role="status">
        正在整理适合你的对比词组…
      </p>
    );
  if (!groups.length)
    return (
      <section className={styles.empty}>
        <p>{message || '暂时没有可用词组'}</p>
        <button
          onClick={() => {
            setLoaded(false);
            setRevision((value) => value + 1);
          }}
        >
          重新加载
        </button>
      </section>
    );
  return (
    <section aria-labelledby="confusion-title">
      <header className={styles.sectionHead}>
        <div>
          <small>COMPARE IN CONTEXT</small>
          <h2 id="confusion-title">差一点的意思，要放进句子里分清。</h2>
        </div>
        <span>{groups.length} 组 · 每组约 4 分钟</span>
      </header>
      <div className={styles.contrastGrid}>
        <aside className={styles.groupList} aria-label="对比词组">
          {groups.map((item) => (
            <button
              aria-pressed={item.id === groupId}
              onClick={() => choose(item.id)}
              disabled={busy}
              key={item.id}
            >
              <strong>{item.title}</strong>
              <span>
                {item.recommendation} {item.practiced ? '· 已练习' : ''}
              </span>
            </button>
          ))}
        </aside>
        {group && (
          <div>
            <section className={styles.card}>
              <header className={styles.sectionHead}>
                <div>
                  <small>{group.recommendation}</small>
                  <h3>{group.title}</h3>
                </div>
                <button
                  className={styles.textButton}
                  onClick={() => setShowNotes((value) => !value)}
                >
                  {showNotes ? '收起笔记' : '查看对比笔记'}
                </button>
              </header>
              <p className={styles.hint}>{group.note}</p>
              {showNotes && (
                <div className={styles.comparison}>
                  {group.words.map((word) => (
                    <article key={word.word}>
                      <h4>{word.word}</h4>
                      <strong>{word.meaning}</strong>
                      <p>{word.rule}</p>
                      <p className={styles.example}>{word.example}</p>
                    </article>
                  ))}
                </div>
              )}
              {group.questions.map((question, index) => {
                const graded = result?.results.find((row) => row.questionId === question.id);
                return (
                  <fieldset
                    className={styles.question}
                    key={question.id}
                    disabled={busy || !!result}
                  >
                    <legend>
                      <span>{String(index + 1).padStart(2, '0')}</span> {question.sentence}
                    </legend>
                    <div className={styles.options}>
                      {question.options.map((option) => (
                        <label
                          key={option}
                          className={
                            graded
                              ? option === graded.answer
                                ? styles.correctOption
                                : option === graded.selected
                                  ? styles.wrongOption
                                  : ''
                              : ''
                          }
                        >
                          <input
                            type="radio"
                            name={question.id}
                            checked={answers[question.id] === option}
                            value={option}
                            onChange={() =>
                              setAnswers((current) => ({ ...current, [question.id]: option }))
                            }
                          />
                          <span>{option}</span>
                        </label>
                      ))}
                    </div>
                    {graded && (
                      <p className={styles.explanation}>
                        {graded.correct ? '✓ 正确' : `↺ 正确答案：${graded.answer}`} ·{' '}
                        {graded.explanation}
                      </p>
                    )}
                  </fieldset>
                );
              })}
              {message && (
                <p className={styles.notice} role="alert">
                  {message}
                </p>
              )}
              {result ? (
                <div className={styles.resultBar}>
                  <strong>
                    本组答对 {result.correctCount}/{result.total}
                  </strong>
                  <button className={styles.secondary} onClick={() => choose(group.id)}>
                    再练一轮 →
                  </button>
                </div>
              ) : (
                <button
                  className={styles.primary}
                  disabled={busy || group.questions.some((q) => !answers[q.id])}
                  onClick={() => void submit()}
                >
                  {busy ? '正在保存…' : '提交并查看解析'}
                </button>
              )}
            </section>
            <p className={styles.hint}>
              关联到已学习词汇的作答会进入错题和复习；其他词组保存在训练记录中。
            </p>
          </div>
        )}
      </div>
      {history.length > 0 && (
        <section className={styles.history}>
          <h3>最近的对比训练</h3>
          {history.slice(0, 10).map((item) => (
            <details key={item.id}>
              <summary>
                <span>
                  {groups.find((group) => group.id === item.groupId)?.title ?? item.groupId}
                </span>
                <strong>
                  {item.correctCount}/{item.total}
                </strong>
                <span>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>
              </summary>
              {item.answers.map((row) => (
                <p key={row.questionId}>
                  {row.correct ? '✓' : '↺'} 你的答案：{row.selected} · 正确答案：{row.answer}
                  <br />
                  {row.explanation}
                </p>
              ))}
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
