'use client';

import { useEffect, useState } from 'react';
import { request, type Session, userFacingError } from '../../lib/api';
import { CollectWordForm } from '../learning-lab/collect-word-form';
import {
  clearReviewDraft,
  clearStoryDraft,
  readReviewDraft,
  readStoryDraft,
  saveReviewDraft,
  saveStoryDraft,
} from '../../lib/micro-story-drafts';
import styles from './micro-stories.module.css';
import { EnglishAudioControls } from '../english-audio-controls';
import { LocalSpeakingPractice } from './local-speaking-practice';

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
  focusPhrase?: string;
  focusMeaning?: string;
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
type CompletedStoryPreview = Pick<Lesson, 'key' | 'series' | 'part' | 'level' | 'english'>;
type CompletedStoryAnswer = CompletedStoryPreview & {
  reference: string;
  explanation: string;
  frame: string;
  example: string;
  focusPhrase: string;
  focusMeaning: string;
};

export function MicroStoriesPage({ session }: { session: Session }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [interpretation, setInterpretation] = useState('');
  const [ownSentence, setOwnSentence] = useState('');
  const [reviewAttempt, setReviewAttempt] = useState('');
  const [transcriptHidden, setTranscriptHidden] = useState(false);
  const [mismatch, setMismatch] = useState<boolean | null>(null);
  const [reviewShown, setReviewShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorCards, setErrorCards] = useState<ErrorCard[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [completedStories, setCompletedStories] = useState<CompletedStoryPreview[] | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [selectedCompletedStory, setSelectedCompletedStory] =
    useState<CompletedStoryPreview | null>(null);
  const [completedAttempt, setCompletedAttempt] = useState('');
  const [completedAnswer, setCompletedAnswer] = useState<CompletedStoryAnswer | null>(null);

  function applyCurrent(next: Current) {
    setCurrent(next);
    setTranscriptHidden(false);
    const storyDraft = readStoryDraft(session.user.id, next.lesson?.key ?? null);
    setInterpretation(next.lesson?.interpretation ?? storyDraft?.interpretation ?? '');
    setOwnSentence(storyDraft?.ownSentence ?? '');
    setReviewAttempt(next.review ? readReviewDraft(session.user.id, next.review.id) : '');
    setMismatch(null);
    setReviewShown(false);
  }

  async function load() {
    const next = await request<Current>('/micro-stories/current', {}, session.accessToken);
    applyCurrent(next);
    if (showErrors)
      setErrorCards(await request<ErrorCard[]>('/micro-stories/errors', {}, session.accessToken));
    if (showCompleted) {
      try {
        setCompletedStories(
          await request<CompletedStoryPreview[]>(
            '/micro-stories/completed',
            {},
            session.accessToken,
          ),
        );
      } catch (cause) {
        setError(`已完成故事列表暂时无法刷新：${userFacingError(cause)}`);
      }
    }
  }
  useEffect(() => {
    let active = true;
    request<Current>('/micro-stories/current', {}, session.accessToken)
      .then((next) => {
        if (!active) return;
        applyCurrent(next);
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
      clearStoryDraft(session.user.id);
      setCompletedStories(null);
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
      clearReviewDraft(session.user.id, current.review.id);
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

  async function toggleCompleted() {
    if (showCompleted) {
      setShowCompleted(false);
      return;
    }
    if (completedStories) {
      setShowCompleted(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      setCompletedStories(
        await request<CompletedStoryPreview[]>('/micro-stories/completed', {}, session.accessToken),
      );
      setShowCompleted(true);
    } catch (cause) {
      setError(userFacingError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revealCompletedStory() {
    if (!selectedCompletedStory) return;
    const key = selectedCompletedStory.key;
    setBusy(true);
    setError('');
    try {
      const answer = await request<CompletedStoryAnswer>(
        `/micro-stories/completed/${key}`,
        {},
        session.accessToken,
      );
      setCompletedAnswer(answer);
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
            <EnglishAudioControls
              key={reviewCard.id}
              text={reviewCard.english}
              context="到期复习句"
            />
            {!reviewShown ? (
              <>
                <label className={styles.label} htmlFor="review-attempt">
                  先不看上次记录，用自己的话重新写下这句话的意思
                </label>
                <textarea
                  id="review-attempt"
                  maxLength={500}
                  rows={2}
                  value={reviewAttempt}
                  onChange={(event) => {
                    const attempt = event.target.value;
                    setReviewAttempt(attempt);
                    saveReviewDraft(session.user.id, reviewCard.id, attempt);
                  }}
                  placeholder="先回想句子的意思，再和上次的理解比较"
                />
                <div className={styles.actions}>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busy || !reviewAttempt.trim()}
                    onClick={() => setReviewShown(true)}
                  >
                    先试着回想，查看上次偏差
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busy}
                    onClick={() => setReviewShown(true)}
                  >
                    跳过本次回想，查看上次偏差
                  </button>
                  {reviewAttempt && (
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setReviewAttempt('');
                        clearReviewDraft(session.user.id, reviewCard.id);
                      }}
                    >
                      清除本机回想草稿
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className={styles.answer}>
                  {reviewAttempt.trim() && (
                    <p>
                      <strong>这次我的回想：</strong>
                      {reviewAttempt}
                    </p>
                  )}
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
            {!lesson.reference && (
              <button
                className={styles.secondary}
                type="button"
                aria-pressed={transcriptHidden}
                onClick={() => setTranscriptHidden((hidden) => !hidden)}
              >
                {transcriptHidden ? '显示英文原文' : '先听后看原文'}
              </button>
            )}
            {transcriptHidden && !lesson.reference ? (
              <p className={styles.listenPrompt} role="status">
                先听原文，再用自己的话写下理解；查看解释后会显示英文原文。
              </p>
            ) : (
              <p className={styles.english} lang="en">
                {lesson.english}
              </p>
            )}
            <EnglishAudioControls key={lesson.key} text={lesson.english} context="微故事原文" />
            <LocalSpeakingPractice
              key={`${session.user.id}:${lesson.key}`}
              storyKey={`${session.user.id}-${lesson.key}`}
            />
            {!lesson.reference ? (
              <>
                <label className={styles.label} htmlFor="story-meaning">
                  {transcriptHidden
                    ? '听完后，你理解的意思是什么？'
                    : '你理解的意思是什么？可以只写一句中文。'}
                </label>
                <textarea
                  id="story-meaning"
                  maxLength={500}
                  rows={2}
                  value={interpretation}
                  onChange={(event) => {
                    const value = event.target.value;
                    setInterpretation(value);
                    saveStoryDraft(session.user.id, {
                      storyKey: lesson.key,
                      interpretation: value,
                      ownSentence,
                    });
                  }}
                  placeholder={
                    transcriptHidden
                      ? '先听一遍，用中文写下你听懂的内容'
                      : '先写下你的理解，再看参考解释'
                  }
                />
                {transcriptHidden && (
                  <>
                    <label className={styles.label} htmlFor="own-sentence-before-reveal">
                      用英语写一句你听到的内容（可跳过，不会自动评分）
                    </label>
                    <input
                      id="own-sentence-before-reveal"
                      maxLength={280}
                      value={ownSentence}
                      onChange={(event) => {
                        const value = event.target.value;
                        setOwnSentence(value);
                        saveStoryDraft(session.user.id, {
                          storyKey: lesson.key,
                          interpretation,
                          ownSentence: value,
                        });
                      }}
                      placeholder="先试着表达，再看句型参考"
                    />
                  </>
                )}
                {(interpretation.trim() || ownSentence.trim()) && (
                  <div className={styles.actions}>
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setInterpretation('');
                        setOwnSentence('');
                        clearStoryDraft(session.user.id);
                      }}
                    >
                      清除本机草稿
                    </button>
                  </div>
                )}
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
                  {ownSentence.trim() && (
                    <p>
                      <strong>你的英文尝试：</strong>
                      <span lang="en">{ownSentence}</span>
                    </p>
                  )}
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
                {ownSentence.trim() && (
                  <div className={styles.actions}>
                    <button
                      className={styles.secondary}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setOwnSentence('');
                        clearStoryDraft(session.user.id);
                      }}
                    >
                      清除本机英文尝试草稿
                    </button>
                  </div>
                )}
                <div className={styles.pattern}>
                  <span>今天只练一个句型</span>
                  <strong lang="en">{lesson.frame}</strong>
                  <small>
                    例如：<span lang="en">{lesson.example}</span>
                  </small>
                </div>
                {lesson.focusPhrase && lesson.focusMeaning && (
                  <CollectWordForm
                    session={session}
                    sourceType="READING"
                    source={`微故事 · ${lesson.series} · 第 ${lesson.part} 段`}
                    text={lesson.focusPhrase}
                    meaning={lesson.focusMeaning}
                    example={lesson.english}
                    summary={`＋ 收藏重点表达「${lesson.focusPhrase}」并加入复习`}
                  />
                )}
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
                      onChange={(event) => {
                        const value = event.target.value;
                        setOwnSentence(value);
                        saveStoryDraft(session.user.id, {
                          storyKey: lesson.key,
                          interpretation: lesson.interpretation ?? interpretation,
                          ownSentence: value,
                        });
                      }}
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
        <section className={styles.history} aria-labelledby="completed-heading">
          <div className={styles.cardHead}>
            <h2 id="completed-heading">重读已完成故事</h2>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => void toggleCompleted()}
              aria-expanded={showCompleted}
            >
              {showCompleted ? '收起' : '选择故事'}
            </button>
          </div>
          <p>重读完整场景，先回想再看解析；这次练习不会改动进度或复习安排。</p>
          {showCompleted && (
            <div className={styles.historyList}>
              {completedStories === null && <p>正在读取已完成的故事…</p>}
              {completedStories?.length === 0 && <p>完成第一段故事后，可以在这里重读。</p>}
              {completedStories?.map((story) => (
                <article key={story.key}>
                  <strong>
                    {story.series} · 第 {story.part} 小段 · {story.level}
                  </strong>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      aria-pressed={selectedCompletedStory?.key === story.key}
                      onClick={() => {
                        setSelectedCompletedStory(story);
                        setCompletedAttempt('');
                        setCompletedAnswer(null);
                      }}
                    >
                      重读这段
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {showCompleted && selectedCompletedStory && (
            <article className={styles.revisit}>
              <h3>
                {selectedCompletedStory.series} · 第 {selectedCompletedStory.part} 小段
              </h3>
              <p className={styles.english} lang="en">
                {selectedCompletedStory.english}
              </p>
              <EnglishAudioControls
                key={`completed-${selectedCompletedStory.key}`}
                text={selectedCompletedStory.english}
                context="已完成故事"
              />
              {!completedAnswer ? (
                <>
                  <label className={styles.label} htmlFor="completed-attempt">
                    可以先用自己的话回想这段意思，也可以直接跳过
                  </label>
                  <textarea
                    id="completed-attempt"
                    maxLength={500}
                    rows={2}
                    value={completedAttempt}
                    onChange={(event) => setCompletedAttempt(event.target.value)}
                    placeholder="这次回想只在当前页面显示，不会保存或计入进度"
                  />
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy || !completedAttempt.trim()}
                      onClick={() => void revealCompletedStory()}
                    >
                      查看解析
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void revealCompletedStory()}
                    >
                      跳过回想，查看解析
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {completedAttempt.trim() && (
                    <p>
                      <strong>这次回想（未保存）：</strong>
                      {completedAttempt}
                    </p>
                  )}
                  <div className={styles.answer}>
                    <p>
                      <strong>参考意思：</strong>
                      {completedAnswer.reference}
                    </p>
                    <p>{completedAnswer.explanation}</p>
                    <p>
                      <strong>句型：</strong>
                      <span lang="en">{completedAnswer.frame}</span>
                    </p>
                    <p>
                      <strong>例如：</strong>
                      <span lang="en">{completedAnswer.example}</span>
                    </p>
                  </div>
                  <CollectWordForm
                    session={session}
                    sourceType="READING"
                    source={`微故事 · ${completedAnswer.series} · 第 ${completedAnswer.part} 段`}
                    text={completedAnswer.focusPhrase}
                    meaning={completedAnswer.focusMeaning}
                    example={completedAnswer.english}
                    summary={`＋ 收藏重点表达「${completedAnswer.focusPhrase}」并加入复习`}
                  />
                </>
              )}
            </article>
          )}
        </section>
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
