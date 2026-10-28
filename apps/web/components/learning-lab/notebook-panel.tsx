'use client';

import { useCallback, useEffect, useState } from 'react';
import type { NotebookPage, NotebookSource, NotebookWord } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import { CollectWordForm } from './collect-word-form';
import styles from './lab.module.css';

const sources: Array<[NotebookSource, string]> = [
  ['TRAVEL', '旅行场景'],
  ['READING', '阅读材料'],
  ['DAILY_SENTENCE', '每日一句'],
  ['MANUAL', '手动收藏'],
  ['WORD', '词汇学习'],
];
const states: Record<string, string> = {
  NEW: '未开始',
  LEARNING: '学习中',
  REVIEWING: '复习中',
  MASTERED: '已掌握',
};
function sourceLabel(word: NotebookWord) {
  const label = sources.find(([key]) => key === word.sourceType)?.[1] ?? '收藏';
  return !word.sourceScenario
    ? label
    : word.sourceScenario.startsWith(label)
      ? word.sourceScenario
      : `${label} · ${word.sourceScenario}`;
}
export function NotebookPanel({
  session,
  selected,
  onSelect,
  onRead,
}: {
  session: Session;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onRead: () => void;
}) {
  const [data, setData] = useState<NotebookPage | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [recallMode, setRecallMode] = useState(false);
  const [revealedMeaningIds, setRevealedMeaningIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setRevealedMeaningIds(new Set());
    const params = new URLSearchParams({
      page: String(page),
      search: query,
      ...(source ? { source } : {}),
    });
    request<NotebookPage>(`/vocabulary/notebook?${params}`, {}, session.accessToken)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err) => {
        if (active) setError(userFacingError(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.user.id, session.accessToken, page, query, source, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  async function action(word: NotebookWord, kind: 'review' | 'master' | 'delete') {
    setBusy(word.id);
    setError('');
    try {
      await request(
        kind === 'delete'
          ? `/vocabulary/personal/items/${word.id}`
          : `/vocabulary/words/${word.id}/${kind}`,
        { method: kind === 'delete' ? 'DELETE' : 'POST' },
        session.accessToken,
      );
      if (kind === 'delete') {
        onSelect(selected.filter((id) => id !== word.id));
        if (data?.items.length === 1 && page > 1) setPage(page - 1);
      }
      refresh();
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-label="个人生词本">
      <header className={styles.head}>
        <div>
          <small className={styles.eyebrow}>MY WORDS</small>
          <h2>把遇见的词留下来</h2>
        </div>
        <span className={styles.badge}>{data?.total ?? '…'} 个词</span>
        <div className={styles.actions}>
          <span>已选 {selected.length}/6</span>
          <button className={styles.primary} disabled={!selected.length} onClick={onRead}>
            用选中词精读 →
          </button>
          <button
            className={styles.button}
            type="button"
            aria-pressed={recallMode}
            data-notebook-recall-mode
            onClick={() => {
              setRecallMode((active) => !active);
              setRevealedMeaningIds(new Set());
            }}
          >
            {recallMode ? '结束回想' : '练习回想'}
          </button>
          <button
            className={styles.button}
            disabled={!selected.length}
            onClick={() => onSelect([])}
          >
            清空选择
          </button>
        </div>
      </header>
      <p className={styles.meta}>
        旅行、阅读和每日一句中的词汇统一保存在这里。新收藏立即加入复习；重复收藏保留首次原句和学习进度。移出收藏会保留学习与复习记录。
      </p>
      {recallMode && (
        <p className={styles.meta} role="status">
          先看英文和原句，在心里回想中文释义，再逐项揭晓；这里不会保存作答或改变复习状态。
        </p>
      )}
      <CollectWordForm session={session} sourceType="MANUAL" source="手动收藏" onSaved={refresh} />
      <form
        className={styles.filters}
        data-notebook-filters
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setQuery(search.trim());
        }}
      >
        <label>
          搜索词汇或词义
          <input
            maxLength={80}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索生词本"
          />
        </label>
        <label>
          来源
          <select
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(1);
            }}
          >
            {[['', '全部来源'], ...sources].map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <button className={styles.button}>搜索</button>
      </form>
      {error && (
        <p className={styles.notice} role="alert">
          {error}
          <button className={styles.button} onClick={refresh}>
            重试
          </button>
        </p>
      )}
      {loading ? (
        <p role="status">正在翻开生词本…</p>
      ) : data?.items.length ? (
        <div className={styles.grid}>
          {data.items.map((word) => {
            const meaningRevealed = !recallMode || revealedMeaningIds.has(word.id);
            return (
              <article className={styles.card} key={word.id} data-notebook-word={word.id}>
                <div className={styles.wordHead}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(word.id)}
                      disabled={!selected.includes(word.id) && selected.length >= 6}
                      onChange={(event) =>
                        onSelect(
                          event.target.checked
                            ? [...selected, word.id]
                            : selected.filter((id) => id !== word.id),
                        )
                      }
                    />
                    <span lang="en" data-notebook-target>
                      {word.text}
                    </span>
                  </label>
                  <span className={styles.state}>{states[word.state] ?? word.state}</span>
                </div>
                {word.meaning ? (
                  <div className={styles.meaningRecall}>
                    <p id={`notebook-meaning-${word.id}`} data-notebook-meaning>
                      {meaningRevealed ? word.meaning : '释义已隐藏。先在心里回想，再揭晓。'}
                    </p>
                    {recallMode && (
                      <button
                        className={styles.button}
                        type="button"
                        data-meaning-recall
                        aria-expanded={revealedMeaningIds.has(word.id)}
                        aria-controls={`notebook-meaning-${word.id}`}
                        onClick={() =>
                          setRevealedMeaningIds((current) => {
                            const next = new Set(current);
                            if (next.has(word.id)) next.delete(word.id);
                            else next.add(word.id);
                            return next;
                          })
                        }
                      >
                        {revealedMeaningIds.has(word.id) ? '再回想一次' : '揭晓释义'}
                      </button>
                    )}
                  </div>
                ) : (
                  <p>这条收藏还没有保存释义。</p>
                )}
                <p className={styles.meta}>{sourceLabel(word)}</p>
                {word.example && (
                  <blockquote className={styles.example} lang="en">
                    {word.example}
                  </blockquote>
                )}
                {word.nextReviewAt && word.state !== 'MASTERED' && (
                  <p className={styles.meta}>
                    复习日期：
                    {new Date(word.nextReviewAt).toLocaleDateString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                    })}
                  </p>
                )}
                <div className={styles.actions}>
                  <button
                    className={styles.button}
                    disabled={busy !== null}
                    onClick={() => void action(word, 'review')}
                  >
                    加入今日复习
                  </button>
                  <button
                    className={styles.button}
                    disabled={busy !== null || word.state === 'MASTERED'}
                    onClick={() => void action(word, 'master')}
                  >
                    标记掌握
                  </button>
                  <button
                    className={styles.button}
                    disabled={busy !== null}
                    onClick={() => void action(word, 'delete')}
                  >
                    {busy === word.id ? '处理中…' : '移除收藏'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty}>
          <h3>{query || source ? '没有匹配的收藏' : '你的生词本还是空白的'}</h3>
          <p>可以在上方手动收藏，也可以在阅读、每日一句和旅行场景中留下词汇。</p>
        </div>
      )}
      <nav className={styles.pager} aria-label="生词本分页">
        <button
          className={styles.button}
          disabled={loading || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          上一页
        </button>
        <span>第 {page} 页</span>
        <button
          className={styles.button}
          disabled={loading || !data?.hasMore}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </nav>
    </section>
  );
}
