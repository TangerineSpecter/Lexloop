'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './quick-review-session.module.css';
import {
  clearQuickReviewDraft,
  readQuickReviewDraft,
  saveQuickReviewDraft,
  type QuickReviewDraft,
} from '../lib/quick-review-drafts';
import { hasUsableWordMeaning } from '../lib/word-meaning-availability';

export type QuickReviewWord = {
  id: string;
  word: string;
  part: string;
  meaning: string;
  meanings?: Array<{ part: string; text: string }>;
  ukPhonetic?: string | null;
  usPhonetic?: string | null;
};

type Props = {
  userId: string;
  words: QuickReviewWord[];
  onChooseBook: () => void;
};

function countChoices(dueCount: number) {
  if (dueCount < 1) return [];
  const maximum = Math.min(10, dueCount);
  return [...new Set([1, Math.min(3, maximum), Math.min(5, maximum), maximum])].sort(
    (left, right) => left - right,
  );
}

function completedCount(draft: QuickReviewDraft) {
  return draft.currentIndex + (draft.revealed ? 1 : 0);
}

export function QuickReviewSession({ userId, words, onChooseBook }: Props) {
  const usableWords = useMemo(() => words.filter(hasUsableWordMeaning), [words]);
  const missingMeaningCount = words.length - usableWords.length;
  const currentDueWordIds = useMemo(
    () => usableWords.slice(0, 10).map((word) => word.id),
    [usableWords],
  );
  const dueSignature = useMemo(() => JSON.stringify(currentDueWordIds), [currentDueWordIds]);
  const choices = countChoices(usableWords.length);
  const countGroupId = useId();
  const [view, setView] = useState<'loading' | 'setup' | 'active' | 'complete'>('loading');
  const [selectedCount, setSelectedCount] = useState(3);
  const [draft, setDraft] = useState<QuickReviewDraft | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [notice, setNotice] = useState('');
  const activeHeadingRef = useRef<HTMLHeadingElement>(null);
  const completeHeadingRef = useRef<HTMLHeadingElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const setupFocusRef = useRef<'resume' | 'start' | null>(null);

  useEffect(() => {
    setView('loading');
    const restored = readQuickReviewDraft(userId, currentDueWordIds);
    setDraft(restored.draft);
    setStorageAvailable(restored.storageAvailable);
    setNotice(
      restored.stale
        ? '当前可回想词候选已经变化，上一份练习未结算，已清除旧进度。'
        : restored.storageAvailable
          ? ''
          : '浏览器本地存储不可用；本次仍可练习，但离开后可能无法恢复。',
    );
    const availableCounts = countChoices(currentDueWordIds.length);
    setSelectedCount((current) =>
      availableCounts.includes(current) ? current : (availableCounts[0] ?? 1),
    );
    setView('setup');
  }, [currentDueWordIds, dueSignature, userId]);

  useEffect(() => {
    if (view === 'active') activeHeadingRef.current?.focus();
    if (view === 'complete') completeHeadingRef.current?.focus();
    if (view === 'setup' && setupFocusRef.current) {
      const target = setupFocusRef.current === 'resume' ? resumeButtonRef : startButtonRef;
      target.current?.focus();
      setupFocusRef.current = null;
    }
  }, [draft?.currentIndex, draft?.revealed, view]);

  const currentWord = draft
    ? words.find((word) => word.id === draft.wordIds[draft.currentIndex])
    : undefined;
  const selectedCountValue = choices.includes(selectedCount) ? selectedCount : (choices[0] ?? 1);

  const saveProgress = (next: QuickReviewDraft) => {
    const saved = saveQuickReviewDraft(next);
    setStorageAvailable(saved);
    setNotice(saved ? '' : '本地进度保存失败；本次仍可继续，但离开后可能无法恢复。');
    setDraft(next);
  };

  const start = () => {
    const count = Math.min(selectedCountValue, usableWords.length, 10);
    if (!count) return;
    const next: QuickReviewDraft = {
      version: 1,
      userId,
      wordIds: currentDueWordIds.slice(0, count),
      currentIndex: 0,
      revealed: false,
    };
    saveProgress(next);
    setView('active');
  };

  const reveal = () => {
    if (!draft || draft.revealed) return;
    saveProgress({ ...draft, revealed: true });
  };

  const pause = () => {
    setupFocusRef.current = 'resume';
    setView('setup');
  };

  const discard = () => {
    const cleared = clearQuickReviewDraft(userId);
    setStorageAvailable(cleared);
    setDraft(null);
    setNotice(cleared ? '' : '未能清除本地练习进度；请检查浏览器存储后重试。');
    setupFocusRef.current = 'start';
    setView('setup');
  };

  const next = () => {
    if (!draft || !draft.revealed) return;
    if (draft.currentIndex === draft.wordIds.length - 1) {
      const cleared = clearQuickReviewDraft(userId);
      setStorageAvailable(cleared);
      if (!cleared) setNotice('本次已看完；浏览器未能清除本地进度，请稍后重试清理。');
      setView('complete');
      return;
    }
    saveProgress({ ...draft, currentIndex: draft.currentIndex + 1, revealed: false });
  };

  if (view === 'loading') {
    return (
      <section className={styles.panel} data-quick-review role="status" aria-busy="true">
        <p>正在恢复本次少量练习…</p>
      </section>
    );
  }

  if (view === 'complete' && draft) {
    return (
      <section
        className={styles.panel}
        data-quick-review
        data-quick-review-done
        aria-labelledby={`${countGroupId}-done`}
      >
        <h2 id={`${countGroupId}-done`} ref={completeHeadingRef} tabIndex={-1}>
          本次少量练习已看完
        </h2>
        <p>
          本次看完了 {completedCount(draft)} 个有可用释义的词卡。共有 {words.length} 个到期词；
          {missingMeaningCount > 0
            ? `其中 ${missingMeaningCount} 个暂无可用释义，未纳入本次练习，仍保留原排期。`
            : '未选入本次练习的词仍保留原排期。'}
        </p>
        <p className={styles.boundary}>
          这只表示本次词卡已看完，不代表今日正式复习已完成；它不会更新学习历史、统计或 SRS。
        </p>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => {
            setDraft(null);
            setNotice('');
            setupFocusRef.current = 'start';
            setView('setup');
          }}
        >
          返回词表
        </button>
      </section>
    );
  }

  if (view === 'active' && draft && currentWord) {
    const total = draft.wordIds.length;
    const attempted = completedCount(draft);
    const isLast = draft.currentIndex === total - 1;
    return (
      <section
        className={styles.panel}
        data-quick-review
        data-quick-review-active
        aria-labelledby={`${countGroupId}-question`}
      >
        <div className={styles.sessionMeta} aria-live="polite">
          <strong>少量回想练习</strong>
          <span>
            第 {draft.currentIndex + 1}/{total} 题 · 已回想 {attempted}/{total}
          </span>
        </div>
        <p className={styles.prompt}>先回想这个词的意思，再选择“我想好了，显示释义”。</p>
        {notice && (
          <p className={styles.notice} role="status" aria-live="polite">
            {notice}
          </p>
        )}
        <article className={styles.question}>
          <p className={styles.wordLabel}>到期词 · 回想中文释义</p>
          <h2 id={`${countGroupId}-question`} ref={activeHeadingRef} tabIndex={-1} lang="en">
            {currentWord.word}
          </h2>
          {(currentWord.ukPhonetic || currentWord.usPhonetic) && (
            <p className={styles.phonetic} lang="en">
              {currentWord.ukPhonetic || currentWord.usPhonetic}
            </p>
          )}
          {draft.revealed ? (
            <div className={styles.meaning} aria-live="polite">
              <span>{currentWord.part}</span>
              <strong>{currentWord.meaning}</strong>
            </div>
          ) : (
            <p className={styles.hiddenMeaning}>释义已隐藏</p>
          )}
        </article>
        <div className={styles.actions}>
          {!draft.revealed ? (
            <button type="button" className={styles.primaryButton} onClick={reveal}>
              我想好了，显示释义
            </button>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={next}>
              {isLast ? '结束本次练习' : '下一题'}
            </button>
          )}
          <button type="button" className={styles.secondaryButton} onClick={pause}>
            暂停，稍后继续
          </button>
        </div>
        <p className={styles.boundary}>
          本练习只保存本机恢复位置，不保存答案或正确率，不改变原计划和复习排期。
        </p>
      </section>
    );
  }

  return (
    <section className={styles.panel} data-quick-review aria-labelledby={`${countGroupId}-title`}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>自选练习 · 到期词</p>
          <h2 id={`${countGroupId}-title`}>少量回想练习</h2>
        </div>
        <span className={styles.dueCount}>
          到期 {words.length} · 可回想 {usableWords.length}
        </span>
      </header>
      <p className={styles.intro}>
        只从有可用释义的到期词中按当前排期顺序选题。选题量，不估算分钟；不创建学习计划，也不生成新内容。
      </p>
      {missingMeaningCount > 0 && (
        <p className={styles.notice} role="status">
          {missingMeaningCount}{' '}
          个到期词暂无可用释义，未纳入本次候选，也不会记作已复习；词条与原排期保留不变。
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {draft ? (
        <div className={styles.resumeCard}>
          <div>
            <strong>有一份尚未看完的练习</strong>
            <p>
              已回想 {completedCount(draft)}/{draft.wordIds.length} 题；恢复后会接着显示原词表顺序。
            </p>
          </div>
          <div className={styles.actions}>
            <button
              ref={resumeButtonRef}
              type="button"
              className={styles.primaryButton}
              onClick={() => setView('active')}
            >
              继续练习
            </button>
            <button type="button" className={styles.secondaryButton} onClick={discard}>
              放弃本次练习
            </button>
          </div>
        </div>
      ) : usableWords.length === 0 ? (
        <div className={styles.noCandidates}>
          <p>
            当前到期词都缺少可用释义，暂时无法回想。可切换到其他词表练习，或补充这些词的释义后再来；本练习没有更改它们的排期。
          </p>
          <button type="button" className={styles.primaryButton} onClick={onChooseBook}>
            选择其他词表
          </button>
        </div>
      ) : (
        <>
          <fieldset className={styles.countFieldset}>
            <legend>本次题数</legend>
            <div className={styles.countChoices}>
              {choices.map((count) => {
                const id = `${countGroupId}-${count}`;
                return (
                  <label
                    key={count}
                    htmlFor={id}
                    className={selectedCountValue === count ? styles.selectedCount : ''}
                  >
                    <input
                      id={id}
                      type="radio"
                      name={countGroupId}
                      value={count}
                      checked={selectedCountValue === count}
                      onChange={() => setSelectedCount(count)}
                    />
                    {count} 题
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className={styles.orderNote}>
            题目按 API 返回的到期顺序，从有可用释义的词中取前 {selectedCountValue} 个。
          </p>
          <button
            ref={startButtonRef}
            type="button"
            className={styles.primaryButton}
            onClick={start}
            disabled={!selectedCountValue}
          >
            开始练习（{selectedCountValue} 题）
          </button>
        </>
      )}
      <p className={styles.boundary}>
        这是可跳过的本地回想练习，不会写入作答或今日复习进度；完成这组词卡不等于完成正式复习。
      </p>
      {!storageAvailable && !notice && (
        <p className={styles.notice} role="status">
          浏览器本地存储不可用；离开后可能无法恢复本次练习。
        </p>
      )}
    </section>
  );
}
