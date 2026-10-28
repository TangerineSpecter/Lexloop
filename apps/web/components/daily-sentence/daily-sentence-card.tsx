'use client';

import type { DailySentenceCurrent } from '@lexloop/types';
import { BookOpen, Bookmark, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { request, type Session, userFacingError } from '../../lib/api';
import { DailySentenceNotebook } from './daily-sentence-notebook';
import styles from './daily-sentence.module.css';

export function DailySentenceCard({
  session,
  layout = 'card',
}: {
  session: Session;
  layout?: 'card' | 'strip';
}) {
  const [data, setData] = useState<DailySentenceCurrent | null>(null);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<'history' | string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(
        await request<DailySentenceCurrent>('/daily-sentences/current', {}, session.accessToken),
      );
      setError('');
    } catch (err) {
      setError(userFacingError(err));
    }
  }, [session.accessToken]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await request<DailySentenceCurrent>(
          '/daily-sentences/current',
          {},
          session.accessToken,
        );
        if (active) {
          setData(result);
          setError('');
        }
      } catch (err) {
        if (active) setError(userFacingError(err));
      }
    };
    void load();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(onFocus, 60_000);
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [session.accessToken]);

  const retry = async () => {
    setRetrying(true);
    setError('');
    try {
      await request('/daily-sentences/retry', { method: 'POST' }, session.accessToken);
      await refresh();
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setRetrying(false);
    }
  };
  const item = data?.item;
  if (data?.state === 'DISABLED') return null;
  const message =
    data?.state === 'MODEL_REQUIRED'
      ? '请先在阅读材料模型设置中选择可用模型，后台会在每日定时检查时准备句子。'
      : data?.state === 'FAILED'
        ? '新句子暂时生成失败，已有内容仍可回顾。请检查模型配置，或稍后重试。'
        : data?.state === 'GENERATING'
          ? '新句子正在准备，完成后会显示在这里。'
          : '每天北京时间 06:00 准备一句；有未读句子时保留原句。';
  const compact = layout === 'strip';
  return (
    <>
      <section
        className={`${styles.card} ${compact ? styles.strip : ''}`}
        aria-labelledby="daily-sentence-heading"
      >
        <header className={styles.header}>
          <h2 id="daily-sentence-heading">
            <BookOpen size={21} />
            每日一句
          </h2>
          {compact && item ? (
            <button
              className={styles.stripPreview}
              onClick={() => setPanel(item.id)}
              aria-label={`查看每日一句解析：${item.content.english}`}
            >
              <span className={styles.english} lang="en">
                {item.content.english}
              </span>
            </button>
          ) : (
            <span className={styles.meta}>
              {item ? `${item.dateKey} · ${item.readAt ? '已读' : '未读'}` : '每天学懂一个用法'}
            </span>
          )}
          <button className={styles.button} onClick={() => setPanel('history')}>
            <Bookmark size={16} />
            {compact ? '回顾' : '回顾与收藏'}
          </button>
        </header>
        {!compact && item ? (
          <button
            className={styles.preview}
            onClick={() => setPanel(item.id)}
            aria-label={`查看每日一句解析：${item.content.english}`}
          >
            <span className={styles.english} lang="en">
              {item.content.english}
            </span>
            <span className={styles.previewFooter}>
              <span>{item.content.focus}</span>
              <span>
                查看解析 <ChevronRight size={16} />
              </span>
            </span>
          </button>
        ) : null}
        {!compact && !item ? (
          <p className={styles.empty}>{!data && !error ? '正在读取每日一句…' : message}</p>
        ) : null}
        {compact && !item ? (
          <p className={styles.empty}>{!data && !error ? '正在读取每日一句…' : message}</p>
        ) : null}
        {!compact && item && <p className={styles.note}>{message}</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {error}{' '}
            <button className={styles.button} onClick={() => void refresh()}>
              重新加载
            </button>
          </p>
        )}
        {data?.canRetry && (
          <button className={styles.button} disabled={retrying} onClick={() => void retry()}>
            {retrying ? '已提交，正在检查…' : '重试生成'}
          </button>
        )}
      </section>
      {panel && (
        <DailySentenceNotebook
          session={session}
          initialId={panel === 'history' ? null : panel}
          onClose={() => {
            setPanel(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </>
  );
}
