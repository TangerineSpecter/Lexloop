'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotebookWord } from '@lexloop/types';
import { speakEnglish } from '../english-audio-controls';
import styles from './lab.module.css';

type AnswerState = 'correct' | 'incorrect' | 'revealed';

function normalizeSpelling(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
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
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerState, setAnswerState] = useState<AnswerState | null>(null);
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const current = candidates.find((item) => item.id === currentId) ?? null;
  const active = current !== null;

  function chooseNext() {
    if (!candidates.length) return;
    const choices = candidates.filter((item) => item.id !== currentId);
    const pool = choices.length ? choices : candidates;
    const selected = pool[Math.floor(Math.random() * pool.length)];
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
      setNotice('先写下听到的拼写；也可以直接显示答案并结束本题。');
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
          <h3>听音拼写</h3>
          <p className={styles.meta}>
            从当前页有释义的词中抽一项。先听发音并输入拼写，再对照；这里不保存答案或复习状态。
          </p>
        </div>
        <button
          ref={startButtonRef}
          className={active ? styles.button : styles.primary}
          type="button"
          data-spelling-start
          aria-expanded={active}
          disabled={!candidates.length}
          onClick={chooseNext}
        >
          {active ? (answerState ? '再练一个' : '换一个词') : '开始听音拼写'}
        </button>
      </div>

      {active && current && (
        <div className={styles.spellingQuestion} role="group" aria-label="听音拼写练习">
          <p className={styles.meta}>目标词的中文释义</p>
          <p className={styles.spellingMeaning} lang="zh">
            {current.meaning ?? ''}
          </p>
          <div className={styles.spellingActions}>
            <button className={styles.button} type="button" data-spelling-play onClick={playWord}>
              播放单词发音
            </button>
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
            <label htmlFor="notebook-spelling-answer">输入你听到的英文拼写</label>
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
              忽略大小写和多余空格；标点与拼写须对应原词。
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
                ? '拼写与目标词一致。'
                : answerState === 'incorrect'
                  ? '拼写不一致，先对照标准写法。'
                  : '已显示标准写法。'}{' '}
              <strong data-spelling-revealed lang="en">
                {current.text}
              </strong>
              <span>本练习不计成绩，也不改变复习状态。</span>
            </p>
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
