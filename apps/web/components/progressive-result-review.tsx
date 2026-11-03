'use client';

import { useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import styles from './progressive-result-review.module.css';

type ReviewWord = {
  id: string;
  word: string;
  groupIndex: number;
  result?: boolean;
  selectedAnswer?: string[];
  nextReviewAt?: string | null;
  currentReviewStatus?: string;
  question?: {
    prompt?: string;
    options?: string[];
    correctAnswers?: string[];
    explanation?: string;
  } | null;
};
type Review = {
  id: string;
  status: string;
  words: ReviewWord[];
  content?: { groups?: Array<{ index: number; sentences?: Array<{ english: string }> }> } | null;
};
function validReview(value: Review, planId: string) {
  const strings = (input: unknown) =>
    input === undefined ||
    (Array.isArray(input) && input.every((item) => typeof item === 'string'));
  return (
    value &&
    value.id === planId &&
    value.status === 'COMPLETED' &&
    Array.isArray(value.words) &&
    value.words.every(
      (word) =>
        word &&
        typeof word.id === 'string' &&
        typeof word.word === 'string' &&
        Number.isInteger(word.groupIndex) &&
        strings(word.selectedAnswer) &&
        (word.nextReviewAt == null || typeof word.nextReviewAt === 'string') &&
        (!word.question ||
          (strings(word.question.options) &&
            strings(word.question.correctAnswers) &&
            (word.question.prompt === undefined || typeof word.question.prompt === 'string') &&
            (word.question.explanation === undefined ||
              typeof word.question.explanation === 'string'))),
    ) &&
    (!value.content ||
      (Array.isArray(value.content.groups) &&
        value.content.groups.every(
          (group) =>
            group &&
            Number.isInteger(group.index) &&
            (group.sentences === undefined ||
              (Array.isArray(group.sentences) &&
                group.sentences.every(
                  (sentence) => sentence && typeof sentence.english === 'string',
                ))),
        )))
  );
}

function reviewArrangement(word: ReviewWord) {
  switch (word.currentReviewStatus) {
    case 'MASTERED':
      return '已标记掌握，不进入普通到期复习队列。';
    case 'MISSING_MEANING':
      return '当前缺少可用释义，暂不能从渐进队列选入新练习。';
    case 'OUTSIDE_QUEUE':
      return '来自补充词书，不在渐进练习的普通选词队列中。';
    case 'UNSCHEDULED':
      return '当前没有可用于到期复习的排期。';
    case 'DUE':
      return '已到期；正式练习按队列顺序和数量上限选词，不保证下一组入选。';
    case 'SCHEDULED': {
      const date = word.nextReviewAt ? new Date(word.nextReviewAt) : null;
      return date && Number.isFinite(date.getTime())
        ? `下次复习：${date.toLocaleString()}。尚未到期，无需为了回看提前提交新练习。`
        : '已排期，具体时间暂未提供。';
    }
    default:
      return '当前复习安排暂未提供；不据此判断已经到期或掌握。';
  }
}

export function ProgressiveResultReview({ session, planId }: { session: Session; planId: string }) {
  const scope = `${session.user.id}:${planId}`;
  const owner = useRef<string | null>(scope);
  owner.current = scope;
  const sequence = useRef(0);
  useEffect(
    () => () => {
      owner.current = null;
      sequence.current++;
    },
    [],
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<{ scope: string; review: Review; readAt: string } | null>(
    null,
  );
  const visible = loaded?.scope === scope ? loaded : null;
  const load = async () => {
    const requestId = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const review = await request<Review>(
        `/study/plans/${encodeURIComponent(planId)}/review`,
        {},
        session.accessToken,
      );
      if (!validReview(review, planId)) throw new Error('上次练习记录暂时无法读取，请重试。');
      if (owner.current === scope && sequence.current === requestId)
        setLoaded({ scope, review, readAt: new Date().toLocaleString() });
    } catch (cause) {
      if (owner.current === scope && sequence.current === requestId)
        setError(cause instanceof Error ? cause.message : '读取失败，请重试。');
    } finally {
      if (owner.current === scope && sequence.current === requestId) setBusy(false);
    }
  };
  return (
    <section className={styles.review} aria-label="上次渐进练习回看">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !visible && !busy) void load();
        }}
      >
        {open ? '收起上次作答' : '回看上次作答与复习安排'}
      </button>
      {open && (
        <>
          <p>
            先读原文回想，再展开原作答。这里只回看已完成记录，不提交新答案、不生成题目，也不改复习时间或阶段。
          </p>
          {busy && <p role="status">正在读取…</p>}
          {error && (
            <p role="alert">
              {error}
              {visible ? ' 以下仍为上次读取结果。' : ''}
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void load()}>
            {visible ? '刷新当前安排' : '重新读取记录'}
          </button>
          {visible && (
            <>
              <p>
                读取于 {visible.readAt}。当前安排不是完成时快照；正式选词以创建练习时的状态为准。
              </p>
              {!visible.review.words.length && <p>这份记录中已没有可回看的题目。</p>}
              {visible.review.words.map((word) => {
                const sentences = visible.review.content?.groups?.find(
                  (group) => group.index === word.groupIndex,
                )?.sentences;
                return (
                  <article className={styles.card} key={word.id}>
                    <strong>{word.word}</strong>
                    {sentences?.length ? (
                      <div lang="en" className={styles.passage}>
                        {sentences.map((sentence, index) => (
                          <p key={index}>{sentence.english}</p>
                        ))}
                      </div>
                    ) : (
                      <p>未保存原组英文材料，不能据此核对原文依据。</p>
                    )}
                    <p lang="en">{word.question?.prompt || '原题干未保存。'}</p>
                    {word.question?.options?.length ? (
                      <ol>
                        {word.question.options.map((option, index) => (
                          <li key={index}>{option}</li>
                        ))}
                      </ol>
                    ) : (
                      <p>原选项未保存。</p>
                    )}
                    <details>
                      <summary>展开原作答与参考解析</summary>
                      <p>
                        {word.result === true
                          ? '当时与参考答案一致。'
                          : word.result === false
                            ? '当时与参考答案不一致。'
                            : '这条记录没有保存判分结果。'}
                      </p>
                      <p>你的答案：{word.selectedAnswer?.join('、') || '未保存具体选择'}</p>
                      <p>本题参考答案：{word.question?.correctAnswers?.join('、') || '未保存'}</p>
                      <p>{word.question?.explanation || '未保存可用解析。'}</p>
                      <p>
                        参考答案与解析未经过独立语义核验；请结合原文检查是否存在多解或依据不足。
                      </p>
                    </details>
                    <p className={styles.arrangement}>{reviewArrangement(word)}</p>
                  </article>
                );
              })}
            </>
          )}
        </>
      )}
    </section>
  );
}
