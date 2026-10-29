'use client';
import { useEffect, useState } from 'react';
import type { DailySentenceHistory } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import { DailySentenceNotebook } from '../daily-sentence/daily-sentence-notebook';
import styles from './lab.module.css';

type FavoritesLoadState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'success'; data: DailySentenceHistory }
  | { key: string; status: 'error'; error: string };

export function SentenceFavoritesPanel({ session }: { session: Session }) {
  const [loadState, setLoadState] = useState<FavoritesLoadState | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const loadKey = JSON.stringify([session.user.id, page, revision]);
  const currentLoad = loadState?.key === loadKey ? loadState : null;
  const data = currentLoad?.status === 'success' ? currentLoad.data : null;
  const loading = !currentLoad || currentLoad.status === 'loading';
  const loadError = currentLoad?.status === 'error' ? currentLoad.error : '';
  useEffect(() => {
    let active = true;
    setLoadState({ key: loadKey, status: 'loading' });
    request<DailySentenceHistory>(
      `/daily-sentences?favorites=true&page=${page}`,
      {},
      session.accessToken,
    )
      .then((value) => {
        if (active) setLoadState({ key: loadKey, status: 'success', data: value });
      })
      .catch((err) => {
        if (active) setLoadState({ key: loadKey, status: 'error', error: userFacingError(err) });
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, page, revision, loadKey]);
  return (
    <section>
      <header className={styles.head}>
        <h2>收藏的每日一句</h2>
        <span>原句 · 拆解 · 用法</span>
        <button className={styles.button} onClick={() => setRevision((value) => value + 1)}>
          刷新
        </button>
      </header>
      {loadError && (
        <p className={styles.notice} role="alert">
          {loadError}
          <button className={styles.button} onClick={() => setRevision((value) => value + 1)}>
            重试读取
          </button>
        </p>
      )}
      {loading ? (
        <p role="status">正在读取句子收藏…</p>
      ) : loadError ? (
        <p className={styles.meta} role="status">
          暂时无法确认当前页的收藏；重试成功后再判断是否有记录。
        </p>
      ) : data?.items.length ? (
        <div className={styles.grid}>
          {data.items.map((item) => (
            <article className={styles.card} key={item.id}>
              <small>
                {item.dateKey} · {item.content.focus}
              </small>
              <p className={styles.english} lang="en">
                {item.content.english}
              </p>
              <p>{item.content.chinese}</p>
              <button className={styles.button} onClick={() => setSelected(item.id)}>
                打开拆解与词汇收藏
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <h3>还没有收藏的句子</h3>
          <p>在首页「每日一句」打开解析后，点击收藏即可在这里回顾。</p>
          <a href="/dashboard">返回首页</a>
        </div>
      )}
      <nav className={styles.pager} aria-label="句子收藏分页">
        <button
          className={styles.button}
          disabled={loading || page === 1}
          onClick={() => setPage(page - 1)}
        >
          上一页
        </button>
        <span>第 {page} 页</span>
        <button
          className={styles.button}
          disabled={loading || Boolean(loadError) || !data?.hasMore}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </nav>
      {selected && (
        <DailySentenceNotebook
          session={session}
          initialId={selected}
          onClose={() => {
            setSelected(null);
            setRevision((value) => value + 1);
          }}
          onChanged={() => setRevision((value) => value + 1)}
        />
      )}
    </section>
  );
}
