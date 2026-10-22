'use client';
import { useEffect, useState } from 'react';
import type { Session } from '../../lib/api';
import { NotebookPanel } from './notebook-panel';
import { SentenceFavoritesPanel } from './sentence-favorites-panel';
import { LearningPanel } from './learning-panel';
import styles from './lab.module.css';

type Tab = 'words' | 'sentences' | 'reading' | 'grammar';
const tabs: Array<[Tab, string]> = [
  ['words', '个人生词本'],
  ['sentences', '句子收藏'],
  ['reading', '生词短文精读'],
  ['grammar', '语法薄弱项专项'],
];
export function NotebookPage({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>('words');
  const [selected, setSelected] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const next = params.get('tab');
      setTab(tabs.some(([id]) => id === next) ? (next as Tab) : 'words');
      setSelected(
        [
          ...new Set(
            (params.get('words') ?? '').split(',').filter((id) => /^[a-z0-9]+$/i.test(id)),
          ),
        ].slice(0, 6),
      );
      setReady(true);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  function navigate(next: Tab, ids = selected) {
    setTab(next);
    const params = new URLSearchParams({ tab: next });
    if (ids.length) params.set('words', ids.join(','));
    window.history.pushState(null, '', `/dashboard/notebook?${params}`);
  }
  function choose(ids: string[]) {
    setSelected(ids);
    const params = new URLSearchParams({ tab });
    if (ids.length) params.set('words', ids.join(','));
    window.history.replaceState(null, '', `/dashboard/notebook?${params}`);
  }
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.heading}>
          <div>
            <small>COLLECT · READ · PRACTICE</small>
            <h1>让收藏，接上下一次学习。</h1>
            <p>留住原句，在新的语境里读懂，再把卡住的语法练明白。</p>
          </div>
          <a href="/dashboard">← 返回词环</a>
        </header>
        <nav className={styles.tabs} aria-label="生词与学习笔记">
          {tabs.map(([id, title]) => (
            <button
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              {title}
            </button>
          ))}
        </nav>
        {ready &&
          (tab === 'words' ? (
            <NotebookPanel
              session={session}
              selected={selected}
              onSelect={choose}
              onRead={() => navigate('reading')}
            />
          ) : tab === 'sentences' ? (
            <SentenceFavoritesPanel session={session} />
          ) : (
            <LearningPanel
              key={tab}
              session={session}
              kind={tab === 'reading' ? 'READING' : 'GRAMMAR'}
              selected={selected}
              onChooseWords={() => navigate('words')}
            />
          ))}
      </div>
    </main>
  );
}
