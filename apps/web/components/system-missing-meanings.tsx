'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { request } from '../lib/api';

type MissingMeaningBook = { id: string; title: string; missingMeaningCount?: number | null };
type MissingMeaningItem = { position: number; word: string };
type MissingMeaningPage = {
  book: { id: string; title: string };
  items: MissingMeaningItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export function SystemMissingMeanings({
  accessToken,
  book,
  onBack,
}: {
  accessToken: string;
  book: MissingMeaningBook;
  onBack: () => void;
}) {
  const [items, setItems] = useState<MissingMeaningItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const requestId = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadPage = useCallback(
    async (after: string | null, append: boolean) => {
      const currentRequest = ++requestId.current;
      if (append) setLoadingMore(true);
      else setStatus('loading');
      setError('');
      setMoreError('');
      try {
        const params = new URLSearchParams({ pageSize: '50' });
        if (after) params.set('cursor', after);
        const page = await request<MissingMeaningPage>(
          `/vocabulary/system/${encodeURIComponent(book.id)}/missing-meanings?${params.toString()}`,
          {},
          accessToken,
        );
        if (currentRequest !== requestId.current) return;
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        setStatus('ready');
      } catch (reason) {
        if (currentRequest !== requestId.current) return;
        const message = reason instanceof Error ? reason.message : '缺释义词列表暂时无法加载';
        if (append) setMoreError(message);
        else setError(message);
        if (!append) setStatus('error');
      } finally {
        if (currentRequest === requestId.current && append) setLoadingMore(false);
      }
    },
    [accessToken, book.id],
  );

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    void loadPage(null, false);
    return () => {
      requestId.current += 1;
    };
  }, [loadPage]);

  return (
    <section className="book-missing-meanings" aria-labelledby="book-missing-meanings-title">
      <button className="book-missing-back" type="button" onClick={onBack}>
        <ArrowLeft size={17} aria-hidden="true" />
        返回词表列表
      </button>
      <header className="book-missing-heading">
        <div>
          <h3 id="book-missing-meanings-title" ref={headingRef} tabIndex={-1}>
            缺释义词
          </h3>
          <p title={book.title}>{book.title}</p>
        </div>
        {typeof book.missingMeaningCount === 'number' && (
          <span
            className="book-missing-count"
            aria-label={`词表统计 ${book.missingMeaningCount} 条`}
          >
            {book.missingMeaningCount} 条
          </span>
        )}
      </header>
      <p className="book-missing-note">
        这是系统词书的只读定位清单；个人词汇和这里的列表都不会修改共享释义或学习排期。
      </p>

      {status === 'loading' && (
        <div className="book-empty book-missing-state" role="status">
          <strong>正在读取缺释义词…</strong>
        </div>
      )}
      {status === 'error' && (
        <div className="book-empty book-missing-state" role="alert">
          <strong>缺释义词列表加载失败</strong>
          <p>{error}</p>
          <button type="button" onClick={() => void loadPage(null, false)}>
            重试
          </button>
        </div>
      )}
      {status === 'ready' && items.length === 0 && (
        <div className="book-empty book-missing-state" role="status">
          <strong>当前没有返回缺释义词</strong>
          <p>词表数据可能已变化；返回列表刷新统计后再查看。</p>
        </div>
      )}
      {status === 'ready' && items.length > 0 && (
        <>
          <ol className="book-missing-list" aria-label="缺释义词列表">
            {items.map((item) => (
              <li key={`${item.position}-${item.word}`}>
                <span>{item.word}</span>
                <small>词表位置 {item.position}</small>
              </li>
            ))}
          </ol>
          <p className="book-missing-progress" role="status" aria-live="polite">
            已定位 {items.length} 条
            {typeof book.missingMeaningCount === 'number'
              ? ` · 词书卡统计 ${book.missingMeaningCount} 条`
              : ''}
          </p>
          {moreError && (
            <div className="book-missing-more-error" role="alert">
              <span>下一页加载失败；已显示的词条仍保留。{moreError}</span>
              <button type="button" onClick={() => void loadPage(cursor, true)}>
                重试下一页
              </button>
            </div>
          )}
          {hasMore && !moreError && (
            <button
              className="book-missing-more"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadPage(cursor, true)}
            >
              {loadingMore ? '正在读取…' : '继续查看'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
