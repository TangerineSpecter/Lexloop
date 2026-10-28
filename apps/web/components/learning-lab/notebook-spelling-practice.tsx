'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotebookWord } from '@lexloop/types';
import { speakEnglish } from '../english-audio-controls';
import { buildNotebookContextPrompt } from '../../lib/target-word-highlighting';
import {
  compareSpelling,
  normalizeSpelling,
  type SpellingDiffPart,
  type SpellingIssue,
} from './spelling-difference';
import styles from './lab.module.css';

type AnswerState = 'correct' | 'incorrect' | 'revealed';
type PracticeMode = 'spelling' | 'context';

function SpellingDiffText({
  parts,
  side,
}: {
  parts: SpellingDiffPart[];
  side: 'answer' | 'target';
}) {
  return parts.map((part, index) => {
    if (part.kind === 'match') return part.value;
    const label =
      part.kind === 'extra'
        ? `多写的字符 ${part.value}`
        : part.kind === 'missing'
          ? `漏写的字符 ${part.value}`
          : side === 'answer'
            ? `错字 ${part.value}`
            : `错字应为 ${part.value}`;
    const className =
      part.kind === 'extra'
        ? styles.spellingDiffExtra
        : part.kind === 'missing'
          ? styles.spellingDiffMissing
          : styles.spellingDiffSubstitution;
    return (
      <mark
        key={`${side}-${index}`}
        className={className}
        data-spelling-diff-kind={part.kind}
        aria-label={label}
      >
        {part.value}
      </mark>
    );
  });
}

function SpellingIssueText({ issue }: { issue: SpellingIssue }) {
  if (issue.kind === 'substitution') {
    return (
      <>
        <strong>错字：</strong>
        <code>{issue.entered}</code>，<strong>应为：</strong>
        <code>{issue.expected}</code>
      </>
    );
  }
  if (issue.kind === 'extra') {
    return (
      <>
        <strong>多写：</strong>
        <code>{issue.entered}</code>
      </>
    );
  }
  return (
    <>
      <strong>漏写：</strong>
      <code>{issue.expected}</code>
    </>
  );
}

export function NotebookSpellingPractice({
  items,
  onActiveChange,
}: {
  items: NotebookWord[];
  onActiveChange: (active: boolean) => void;
}) {
  const candidates = useMemo(
    () => items.filter((item) => item.text.trim() && item.meaning?.trim()),
    [items],
  );
  const contextCandidates = useMemo(
    () => candidates.filter((item) => buildNotebookContextPrompt(item.example, item.text) !== null),
    [candidates],
  );
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerState, setAnswerState] = useState<AnswerState | null>(null);
  const [mode, setMode] = useState<PracticeMode>('spelling');
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const current = candidates.find((item) => item.id === currentId) ?? null;
  const active = current !== null;
  const contextPrompt = useMemo(
    () =>
      mode === 'context' && current
        ? buildNotebookContextPrompt(current.example, current.text)
        : null,
    [current, mode],
  );
  const spellingDifference = useMemo(
    () => (answerState === 'incorrect' && current ? compareSpelling(answer, current.text) : null),
    [answer, answerState, current],
  );

  function chooseNext(nextMode: PracticeMode) {
    const available = nextMode === 'context' ? contextCandidates : candidates;
    if (!available.length) return;
    const choices = available.filter((item) => item.id !== currentId);
    const pool = choices.length ? choices : available;
    const selected = pool[Math.floor(Math.random() * pool.length)];
    setMode(nextMode);
    setCurrentId(selected.id);
    setAnswer('');
    setAnswerState(null);
    setNotice('');
    onActiveChange(true);
  }

  const finish = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setCurrentId(null);
    setAnswer('');
    setAnswerState(null);
    setNotice('');
    onActiveChange(false);
    requestAnimationFrame(() => startButtonRef.current?.focus());
  }, [onActiveChange]);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active, currentId]);

  useEffect(() => {
    if (!active) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [active, finish]);

  useEffect(
    () => () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    [currentId],
  );

  function submitAnswer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || answerState) return;
    if (!answer.trim()) {
      setNotice(
        mode === 'context'
          ? '先写下句中缺失的词或短语；也可以直接显示答案并结束本题。'
          : '先写下听到的拼写；也可以直接显示答案并结束本题。',
      );
      return;
    }
    setAnswerState(
      normalizeSpelling(answer) === normalizeSpelling(current.text) ? 'correct' : 'incorrect',
    );
    setNotice('本练习只供自查，不记录成绩或改变复习状态。');
  }

  function playWord() {
    if (!current) return;
    const result = speakEnglish(current.text);
    setNotice(
      result === 'played'
        ? '已请求浏览器播放英语发音。'
        : result === 'no-voice'
          ? '当前设备没有可用的英语语音；可显示答案并结束本题。'
          : '当前浏览器不支持语音播放；可显示答案并结束本题。',
    );
  }

  return (
    <section className={styles.spellingPractice} data-notebook-spelling-practice>
      <div className={styles.spellingHeading}>
        <div>
          <h3>生词主动回想</h3>
          <p className={styles.meta}>
            用当前页的收藏做一次短练习。答案只在本页对照，不保存作答、成绩或复习状态。
          </p>
        </div>
        <div className={styles.spellingStarts}>
          <button
            ref={startButtonRef}
            className={active ? styles.button : styles.primary}
            type="button"
            data-spelling-start
            aria-expanded={active}
            disabled={!candidates.length}
            onClick={() => chooseNext(active ? mode : 'spelling')}
          >
            {active ? (answerState ? '再练一个' : '换一个词') : '开始听音拼写'}
          </button>
          {!active && (
            <button
              className={styles.button}
              type="button"
              data-context-start
              disabled={!contextCandidates.length}
              onClick={() => chooseNext('context')}
            >
              按原句补词
            </button>
          )}
        </div>
      </div>
      {!active && candidates.length > 0 && contextCandidates.length === 0 && (
        <p className={styles.meta} data-context-unavailable role="status">
          当前页没有含完整目标词的已存原句；可以继续使用听音拼写。
        </p>
      )}

      {active && current && (
        <div
          className={styles.spellingQuestion}
          role="group"
          aria-label={mode === 'context' ? '原句补词练习' : '听音拼写练习'}
          data-practice-mode={mode}
        >
          <p className={styles.meta}>目标词的中文释义</p>
          <p className={styles.spellingMeaning} lang="zh">
            {current.meaning ?? ''}
          </p>
          {mode === 'context' && contextPrompt && (
            <>
              <p className={styles.meta}>按你收藏时保存的原句，回想缺失的词或短语。</p>
              <blockquote className={styles.spellingContext} data-context-prompt lang="en">
                {answerState
                  ? current.example
                  : contextPrompt.parts.map((part) =>
                      part.kind === 'text' ? (
                        part.value
                      ) : (
                        <span
                          key={part.key}
                          className={styles.contextBlank}
                          data-context-blank
                          role="note"
                          aria-label="缺失的词或短语"
                        >
                          ______
                        </span>
                      ),
                    )}
              </blockquote>
            </>
          )}
          <div className={styles.spellingActions}>
            {mode === 'spelling' && (
              <button className={styles.button} type="button" data-spelling-play onClick={playWord}>
                播放单词发音
              </button>
            )}
            <button
              className={styles.button}
              type="button"
              data-spelling-reveal
              onClick={() => {
                setAnswerState('revealed');
                setNotice('已显示答案；本练习不记录成绩或改变复习状态。');
              }}
            >
              显示答案并结束本题
            </button>
            <button className={styles.button} type="button" data-spelling-end onClick={finish}>
              结束练习
            </button>
          </div>
          <form className={styles.spellingForm} onSubmit={submitAnswer}>
            <label htmlFor="notebook-spelling-answer">
              {mode === 'context' ? '写下句中缺失的表达' : '输入你听到的英文拼写'}
            </label>
            <input
              id="notebook-spelling-answer"
              ref={inputRef}
              data-spelling-answer-input
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={answer}
              disabled={answerState !== null}
              onChange={(event) => {
                setAnswer(event.target.value);
                setNotice('');
              }}
              aria-describedby="notebook-spelling-guidance"
            />
            <p id="notebook-spelling-guidance" className={styles.meta}>
              {mode === 'context'
                ? '按原句填入完整词或短语；这里只比对拼写，不评价整句用法。'
                : '忽略大小写和多余空格；标点与拼写须对应原词。'}
            </p>
            <button
              className={styles.primary}
              type="submit"
              data-spelling-submit
              disabled={answerState !== null}
            >
              对照拼写
            </button>
          </form>
          {answerState && (
            <p className={styles.spellingResult} data-spelling-result role="status">
              {answerState === 'correct'
                ? mode === 'context'
                  ? '拼写与原句中的目标表达一致。'
                  : '拼写与目标词一致。'
                : answerState === 'incorrect'
                  ? mode === 'context'
                    ? '拼写与原句中的目标表达不一致。黄色标记错字或漏字，橙色删除线标记多写。'
                    : '拼写不一致。黄色标记错字或漏字，橙色删除线标记多写。'
                  : '已显示标准写法。'}{' '}
              <strong data-spelling-revealed lang="en">
                {current.text}
              </strong>
              <span>本练习不计成绩，也不改变复习状态。</span>
            </p>
          )}
          {answerState === 'incorrect' && spellingDifference && (
            <div
              className={styles.spellingDifference}
              data-spelling-difference
              role="group"
              aria-label="拼写差异"
            >
              {spellingDifference.alignable ? (
                <>
                  <p className={styles.spellingDifferenceRow}>
                    <strong>你的拼写（忽略大小写和多余空格）</strong>
                    <code>
                      <SpellingDiffText parts={spellingDifference.answerParts} side="answer" />
                    </code>
                  </p>
                  <p className={styles.spellingDifferenceRow}>
                    <strong>标准拼写</strong>
                    <code>
                      <SpellingDiffText parts={spellingDifference.targetParts} side="target" />
                    </code>
                  </p>
                  {spellingDifference.issues.length > 0 && (
                    <ul className={styles.spellingIssueList}>
                      {spellingDifference.issues.map((issue, index) => (
                        <li key={`${issue.kind}-${index}`} data-spelling-issue-kind={issue.kind}>
                          <SpellingIssueText issue={issue} />
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className={styles.meta} data-spelling-difference-limit role="status">
                  输入较长，暂不逐字符标注；上方已显示标准写法，也可以重播发音。
                </p>
              )}
            </div>
          )}
          {notice && (
            <p className={styles.meta} data-spelling-notice role="status">
              {notice}
            </p>
          )}
        </div>
      )}
      {!candidates.length && (
        <p className={styles.meta}>当前页没有同时包含英文词条和中文释义的项目。</p>
      )}
    </section>
  );
}
