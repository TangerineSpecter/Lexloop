'use client';

import { useEffect, useState } from 'react';
import { request, type Session, userFacingError } from '../../lib/api';
import styles from './micro-stories.module.css';

type Lesson = {
  key: string;
  series: string;
  part: number;
  level: 'A1' | 'A2';
  english: string;
  interpretation: string | null;
  reference?: string;
  explanation?: string;
  frame?: string;
  example?: string;
};
type Review = {
  id: string;
  key: string;
  english: string;
  interpretation: string;
  reference: string;
  explanation: string;
  ownSentence: string | null;
  reviewCount: number;
};
type Current = { completed: number; total: number; lesson: Lesson | null; review: Review | null };
type ErrorCard = Pick<
  Review,
  'id' | 'english' | 'interpretation' | 'reference' | 'explanation' | 'ownSentence'
> & { dueAt: string };

export function MicroStoriesPage({ session }: { session: Session }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [interpretation, setInterpretation] = useState('');
  const [ownSentence, setOwnSentence] = useState('');
  const [mismatch, setMismatch] = useState<boolean | null>(null);
  const [reviewShown, setReviewShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorCards, setErrorCards] = useState<ErrorCard[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  async function load() {
    const next = await request<Current>('/micro-stories/current', {}, session.accessToken);
    setCurrent(next);
    if (showErrors)
      setErrorCards(await request<ErrorCard[]>('/micro-stories/errors', {}, session.accessToken));
    setInterpretation(next.lesson?.interpretation ?? '');
    setOwnSentence('');
    setMismatch(null);
    setReviewShown(false);
  }
  useEffect(() => {
    let active = true;
    request<Current>('/micro-stories/current', {}, session.accessToken)
      .then((next) => {
        if (!active) return;
        setCurrent(next);
        setInterpretation(next.lesson?.interpretation ?? '');
      })
      .catch((cause) => {
        if (active) setError(userFacingError(cause));
      });
    return () => {
      active = false;
    };
  }, [session.accessToken]);

  async function reveal() {
    const lesson = current?.lesson;
    if (!lesson || !interpretation.trim()) return;
    setBusy(true);
    setError('');
    try {
      const answer = await request<Lesson>(
        `/micro-stories/${lesson.key}/interpret`,
        {
          method: 'POST',
          body: JSON.stringify({ interpretation: interpretation.trim() }),
        },
        session.accessToken,
      );
      setCurrent((previous) => (previous ? { ...previous, lesson: answer } : previous));
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    const lesson = current?.lesson;
    if (!lesson || mismatch === null) return;
    setBusy(true);
    setError('');
    try {
      await request(
        `/micro-stories/${lesson.key}/complete`,
        {
          method: 'POST',
          body: JSON.stringify({ mismatch, ownSentence: ownSentence.trim() }),
        },
        session.accessToken,
      );
      await load();
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function review(remembered: boolean) {
    if (!current?.review) return;
    setBusy(true);
    setError('');
    try {
      await request(
        `/micro-stories/reviews/${current.review.id}`,
        {
          method: 'POST',
          body: JSON.stringify({ remembered }),
        },
        session.accessToken,
      );
      await load();
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function toggleErrors() {
    if (showErrors) {
      setShowErrors(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      setErrorCards(await request<ErrorCard[]>('/micro-stories/errors', {}, session.accessToken));
      setShowErrors(true);
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      setBusy(false);
    }
  }

  const lesson = current?.lesson;
  const reviewCard = current?.review;
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.heading}>
          <div>
            <small>ONE SCENE · ONE MINUTE</small>
            <h1>生活缝隙里的英语故事</h1>
            <p>读两句，写下理解，马上看偏差。下次打开再接着读。</p>
          </div>
          <a href="/dashboard">← 返回词环</a>
        </header>
        {error && (
          <p className={styles.error} role="alert">
            {error}{' '}
            <button
              type="button"
              onClick={() => {
                setError('');
                void load().catch((cause) => setError(userFacingError(cause)));
              }}
            >
              重新读取
            </button>
          </p>
        )}
        {!current && !error && <p className={styles.status}>正在读取故事…</p>}

        {reviewCard && (
          <section className={styles.card} aria-labelledby="review-heading">
            <div className={styles.cardHead}>
              <h2 id="review-heading">先回想一句</h2>
              <span className={styles.tag}>到期复习</span>
            </div>
            <p className={styles.english} lang="en">
              {reviewCard.english}
            </p>
            {!reviewShown ? (
              <button
                className={styles.secondary}
                type="button"
                onClick={() => setReviewShown(true)}
              >
                想好意思了，查看上次偏差
              </button>
            ) : (
              <>
                <div className={styles.answer}>
                  <p>
                    <strong>上次我的理解：</strong>
                    {reviewCard.interpretation}
                  </p>
                  <p>
                    <strong>实际意思：</strong>
                    {reviewCard.reference}
                  </p>
                  <p>{reviewCard.explanation}</p>
                  {reviewCard.ownSentence && (
                    <p>
                      <strong>上次造句：</strong>
                      <span lang="en">{reviewCard.ownSentence}</span>
                    </p>
                  )}
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => void review(false)}
                  >
                    还没记住，明天再看
                  </button>
                  <button
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => void review(true)}
                  >
                    想起来了
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {lesson ? (
          <section className={styles.card} aria-labelledby="story-heading">
            <div className={styles.cardHead}>
              <h2 id="story-heading">
                {lesson.series} · 第 {lesson.part} 小段
              </h2>
              <span className={styles.tag}>
                {lesson.level} · {current.completed + 1}/{current.total}
              </span>
            </div>
            <p className={styles.english} lang="en">
              {lesson.english}
            </p>
            {!lesson.reference ? (
              <>
                <label className={styles.label} htmlFor="story-meaning">
                  你理解的意思是什么？可以只写一句中文。
                </label>
                <textarea
                  id="story-meaning"
                  maxLength={500}
                  rows={2}
                  value={interpretation}
                  onChange={(event) => setInterpretation(event.target.value)}
                  placeholder="先写下你的理解，再看参考解释"
                />
                <div className={styles.actions}>
                  <button
                    className={styles.primary}
                    disabled={busy || !interpretation.trim()}
                    onClick={() => void reveal()}
                  >
                    查看解释
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.answer}>
                  <p>
                    <strong>你的理解：</strong>
                    {lesson.interpretation}
                  </p>
                  <p>
                    <strong>参考意思：</strong>
                    {lesson.reference}
                  </p>
                  <p>{lesson.explanation}</p>
                </div>
                <div className={styles.pattern}>
                  <span>今天只练一个句型</span>
                  <strong lang="en">{lesson.frame}</strong>
                  <small>
                    例如：<span lang="en">{lesson.example}</span>
                  </small>
                </div>
                <fieldset className={styles.choice}>
                  <legend>刚才的理解有偏差吗？</legend>
                  <label>
                    <input
                      type="radio"
                      name="mismatch"
                      checked={mismatch === true}
                      onChange={() => setMismatch(true)}
                    />{' '}
                    有偏差，存入复习
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mismatch"
                      checked={mismatch === false}
                      onChange={() => setMismatch(false)}
                    />{' '}
                    理解对了
                  </label>
                </fieldset>
                {mismatch !== null && (
                  <>
                    <label className={styles.label} htmlFor="own-sentence">
                      用句型说一句自己的话（可跳过）
                    </label>
                    <input
                      id="own-sentence"
                      maxLength={280}
                      value={ownSentence}
                      onChange={(event) => setOwnSentence(event.target.value)}
                      placeholder="例如：I missed the train."
                    />
                    <div className={styles.actions}>
                      <button
                        className={styles.primary}
                        disabled={busy}
                        onClick={() => void complete()}
                      >
                        读下一段 →
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        ) : (
          current && (
            <section className={styles.card}>
              <h2>这一组故事读完了</h2>
              <p>你已经读完 {current.total} 段。理解偏差会继续在到期时出现，随时回来复习。</p>
            </section>
          )
        )}
        {current && (
          <section className={styles.history} aria-labelledby="errors-heading">
            <div className={styles.cardHead}>
              <h2 id="errors-heading">理解偏差本</h2>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => void toggleErrors()}
                aria-expanded={showErrors}
              >
                {showErrors ? '收起' : '翻看记录'}
              </button>
            </div>
            {showErrors && (
              <div className={styles.historyList}>
                {!errorCards?.length && <p>还没有标记过的理解偏差。</p>}
                {errorCards?.map((card) => (
                  <article key={card.id}>
                    <strong lang="en">{card.english}</strong>
                    <p>我原来理解：{card.interpretation}</p>
                    <p>参考意思：{card.reference}</p>
                    <small>{card.explanation}</small>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
