'use client';

import type { DailySentenceHistory, DailySentenceItem } from '@lexloop/types';
import { ArrowLeft, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type Session, userFacingError } from '../../lib/api';
import { DailySentenceLesson } from './daily-sentence-lesson';
import styles from './daily-sentence.module.css';

export function DailySentenceNotebook({ session, initialId, onClose, onChanged }: { session: Session; initialId: string | null; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState(initialId);
  const [item, setItem] = useState<DailySentenceItem | null>(null);
  const [history, setHistory] = useState<DailySentenceItem[]>([]);
  const [favorites, setFavorites] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal(); document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = previousOverflow; previousFocus?.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const load = async () => {
      try {
        if (selectedId) {
          const result = await request<DailySentenceItem>(`/daily-sentences/${selectedId}`, {}, session.accessToken);
          if (active) setItem(result);
        } else {
          const result = await request<DailySentenceHistory>(`/daily-sentences?page=${page}&favorites=${favorites}`, {}, session.accessToken);
          if (active) { setHistory(current => page === 1 ? result.items : [...current, ...result.items.filter(next => !current.some(old => old.id === next.id))]); setHasMore(result.hasMore); }
        }
      } catch (err) { if (active) setError(userFacingError(err)); }
      finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [selectedId, favorites, page, revision, session.accessToken]);

  // Mark read only once the requested detail has loaded and is on screen.
  const markRead = useCallback(async (id: string) => {
    try {
      const result = await request<DailySentenceItem>(`/daily-sentences/${id}/read`, { method: 'POST' }, session.accessToken);
      setItem(current => current?.id === id ? { ...current, readAt: result.readAt } : current);
      onChangedRef.current();
    } catch { if (selectedIdRef.current === id) setError('解析已打开，但已读状态未保存。请重新打开这条解析重试。'); }
  }, [session.accessToken]);
  useEffect(() => { if (!loading && item && item.id === selectedId && !item.readAt) void markRead(item.id); }, [loading, item?.id, selectedId, markRead]);

  const update = async (data: { favorite?: boolean; difficulty?: 'EASY' | 'RIGHT' | 'HARD' }) => {
    if (!item || saving) return;
    const id = item.id;
    setSaving(true); setError('');
    try {
      const result = await request<DailySentenceItem>(`/daily-sentences/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, session.accessToken);
      setItem(current => current?.id === id ? { ...result, readAt: result.readAt ?? current.readAt } : current);
      onChangedRef.current();
    }
    catch (err) { if (selectedIdRef.current === id) setError(userFacingError(err)); }
    finally { setSaving(false); }
  };

  return <dialog ref={dialog} className={styles.dialog} aria-label={selectedId ? '每日一句解析' : '每日一句回顾与收藏'} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.dialogToolbar}>
      {selectedId ? <button className={styles.button} onClick={() => { setSelectedId(null); setItem(null); setPage(1); }}><ArrowLeft size={16} />回顾与收藏</button> : <h2>一句一句，慢慢学懂</h2>}
      <button autoFocus className={styles.close} onClick={onClose} aria-label="关闭每日一句"><X size={22} /></button>
    </div>
    {error && <p className={styles.error} role="alert">{error}<button className={styles.button} onClick={() => setRevision(value => value + 1)}>重新加载</button></p>}
    {selectedId ? loading ? <p role="status">正在读取解析…</p> : item && item.id === selectedId && <DailySentenceLesson item={item} saving={saving} onUpdate={data => void update(data)} /> : <>
      <p className={styles.note}>成功生成的句子会保存在这里，回顾不会生成新内容。</p>
      <div className={styles.filters} role="group" aria-label="回顾筛选"><button className={styles.button} aria-pressed={!favorites} onClick={() => { setFavorites(false); setPage(1); }}>全部句子</button><button className={styles.button} aria-pressed={favorites} onClick={() => { setFavorites(true); setPage(1); }}>已收藏</button></div>
      {loading && page === 1 ? <p role="status">正在读取回顾…</p> : <>
        {!history.length && !error && <p className={styles.empty}>{favorites ? '还没有收藏。打开喜欢的句子，点击“收藏”即可留在这里。' : '还没有句子。后台会在定时检查时准备第一句，有未读内容时会为你保留。'}</p>}
        <div className={styles.history}>{history.map(entry => <button className={styles.historyItem} key={entry.id} onClick={() => setSelectedId(entry.id)}><span className={styles.meta}>{entry.dateKey} · {entry.readAt ? '已读' : '未读'}{entry.favorite ? ' · 已收藏' : ''}</span><strong lang="en">{entry.content.english}</strong><span>{entry.content.focus}</span></button>)}</div>
        {hasMore && <button className={styles.button} disabled={loading} onClick={() => setPage(value => value + 1)}>{loading ? '正在读取…' : '查看更多'}</button>}
      </>}
    </>}
  </dialog>;
}
