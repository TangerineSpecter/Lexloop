'use client';

import type { NotebookWord, NotebookWordAttempt, NotebookWordAttemptPage } from '@lexloop/types';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { request, userFacingError, type Session } from '../../lib/api';
import styles from './notebook-word-history-dialog.module.css';

const questionTypes: Record<string, string> = {
  MEANING_RECOGNITION: '辨认词义',
  CONTEXT_CHOICE: '语境选择',
  SPELLING: '拼写',
  FILL_BLANK: '补全句子',
  OUTPUT: '表达练习',
  CONFUSION: '易混词辨析',
};

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function readableSnapshot(snapshot: unknown): Array<[string, string]> {
  if (typeof snapshot === 'string') return [['当时题目', snapshot]];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    return [['当时题目快照', valueText(snapshot)]];

  const fields = snapshot as Record<string, unknown>;
  const lines: Array<[string, string]> = [];
  const add = (keys: string[], label: string) => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim()) {
        lines.push([label, value]);
        return;
      }
    }
  };
  add(['prompt', 'instruction', 'question', 'english', 'sentence', 'title'], '题目');
  add(['word'], '词条');
  add(['meaning'], '当时语境义');
  for (const key of ['options', 'choices']) {
    if (Array.isArray(fields[key]) && fields[key].length) {
      lines.push(['选项', fields[key].map(valueText).join('\n')]);
      break;
    }
  }
  for (const key of ['correctAnswers', 'referenceAnswer', 'answer']) {
    if (fields[key] !== undefined && fields[key] !== null) {
      lines.push(['参考答案', valueText(fields[key])]);
      break;
    }
  }
  add(['explanation', 'note', 'message'], '当时说明');
  if (!lines.length) lines.push(['当时题目快照', valueText(snapshot)]);
  return lines;
}

function timestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

export function NotebookWordHistoryDialog({
  session,
  word,
  onClose,
}: {
  session: Session;
  word: NotebookWord;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const loadingMoreRef = useRef(false);
  const [items, setItems] = useState<NotebookWordAttempt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mounted.current = true;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      mounted.current = false;
      if (element.open) element.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setMoreError('');
    setItems([]);
    setCursor(null);
    setHasMore(false);
    const load = async () => {
      try {
        const result = await request<NotebookWordAttemptPage>(
          `/vocabulary/personal/items/${encodeURIComponent(word.id)}/history?pageSize=20`,
          {},
          session.accessToken,
        );
        if (active) {
          setItems(result.items);
          setCursor(result.nextCursor);
          setHasMore(result.hasMore);
        }
      } catch (err) {
        if (active) setError(userFacingError(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [session.accessToken, session.user.id, word.id, revision]);

  const loadMore = async () => {
    if (!cursor || loadingMoreRef.current || !hasMore) return;
    const requestedCursor = cursor;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError('');
    try {
      const params = new URLSearchParams({ pageSize: '20', cursor: requestedCursor });
      const result = await request<NotebookWordAttemptPage>(
        `/vocabulary/personal/items/${encodeURIComponent(word.id)}/history?${params}`,
        {},
        session.accessToken,
      );
      if (!mounted.current) return;
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !known.has(item.id))];
      });
      setCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      if (mounted.current) setMoreError(userFacingError(err));
    } finally {
      loadingMoreRef.current = false;
      if (mounted.current) setLoadingMore(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="notebook-word-history-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className={styles.header}>
        <div>
          <small>WORD HISTORY</small>
          <h2 id="notebook-word-history-title">{word.text} · 学习记录</h2>
          <p>只显示这个词条的已保存作答；旧题快照缺失时会明确标出。</p>
        </div>
        <button className={styles.close} type="button" onClick={onClose} aria-label="关闭学习记录">
          <X size={20} />
        </button>
      </header>

      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button
            className={styles.button}
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}
      {loading ? (
        <p className={styles.state} role="status">
          正在读取这个词条的学习记录…
        </p>
      ) : error ? null : items.length === 0 ? (
        <p className={styles.state} role="status">
          这个词条还没有已保存的作答记录。
        </p>
      ) : (
        <ol className={styles.list} aria-label={`${word.text} 的作答记录`}>
          {items.map((item) => (
            <li className={styles.attempt} key={item.id} data-history-attempt>
              <div className={styles.attemptHeader}>
                <strong className={item.isCorrect ? styles.correct : styles.incorrect}>
                  {item.isCorrect ? '答对' : '答错'}
                </strong>
                <span>
                  {item.questionType
                    ? (questionTypes[item.questionType] ?? item.questionType)
                    : '题型未记录'}
                </span>
                <time dateTime={item.createdAt}>{timestamp(item.createdAt)}</time>
              </div>
              {item.questionSnapshot === null ? (
                <p className={styles.missingSnapshot}>这条旧记录没有保存当时的题目快照。</p>
              ) : (
                <dl className={styles.snapshot}>
                  {readableSnapshot(item.questionSnapshot).map(([label, text], index) => (
                    <div key={`${label}-${index}`}>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className={styles.answer}>
                <strong>我的作答：</strong> {valueText(item.selectedAnswer)}
              </p>
            </li>
          ))}
        </ol>
      )}
      {moreError && (
        <div className={styles.error} role="alert">
          <span>{moreError}</span>
          <button className={styles.button} type="button" onClick={() => void loadMore()}>
            重试加载
          </button>
        </div>
      )}
      {!loading && !error && items.length > 0 && hasMore && (
        <button
          className={styles.button}
          type="button"
          data-history-load-more
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? '正在读取…' : '加载更早记录'}
        </button>
      )}
    </dialog>
  );
}
