'use client';
import { useEffect, useState } from 'react';
import type { Session } from '../../lib/api';
import { NotebookPanel } from './notebook-panel';
import { SentenceFavoritesPanel } from './sentence-favorites-panel';
import { LearningPanel } from './learning-panel';
import styles from './lab.module.css';
import { DashboardBackButton } from '../dashboard-back-button';

type Tab = 'words' | 'sentences' | 'reading' | 'grammar';
const tabs: Array<[Tab, string]> = [
  ['words', '个人生词本'],
  ['sentences', '句子收藏'],
  ['reading', '生词短文精读'],
  ['grammar', '语法薄弱项专项'],
];
function tabFromLocation(): Tab {
  if (typeof window === 'undefined') return 'words';
  const value = new URLSearchParams(window.location.search).get('tab');
  return tabs.some(([id]) => id === value) ? (value as Tab) : 'words';
}
export function NotebookPage({
  session,
  embedded = false,
  onBack,
}: {
  session: Session;
  embedded?: boolean;
  onBack?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(tabFromLocation);
  const [selected, setSelected] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    return [
      ...new Set(
        (new URLSearchParams(window.location.search).get('words') ?? '')
          .split(',')
          .filter((id) => /^[a-z0-9]+$/i.test(id)),
      ),
    ].slice(0, 6);
  });
  const [ready, setReady] = useState(true);
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
    window.addEventListener('lexloop-dashboard-navigate', read);
    return () => {
      window.removeEventListener('popstate', read);
      window.removeEventListener('lexloop-dashboard-navigate', read);
    };
  }, []);
  function navigate(next: Tab, ids = selected) {
    setTab(next);
    const params = new URLSearchParams({ tab: next });
    if (ids.length) params.set('words', ids.join(','));
    window.history.pushState(
      { ...window.history.state, lexloopDashboardPage: 'notebook' },
      '',
      `/dashboard/notebook?${params}`,
    );
    window.dispatchEvent(new Event('lexloop-dashboard-navigate'));
  }
  function choose(ids: string[]) {
    setSelected(ids);
    const params = new URLSearchParams({ tab });
    if (ids.length) params.set('words', ids.join(','));
    window.history.replaceState(
      { ...window.history.state, lexloopDashboardPage: 'notebook' },
      '',
      `/dashboard/notebook?${params}`,
    );
  }
  return (
    <div
      className={['dashboard-route-content', styles.page, embedded ? styles.embedded : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.shell}>
        <header
          className={[styles.heading, embedded ? styles.embeddedHeading : '']
            .filter(Boolean)
            .join(' ')}
        >
          <DashboardBackButton onClick={onBack ?? (() => window.location.assign('/dashboard'))}>
            返回学习进度
          </DashboardBackButton>
          <div>
            <small>COLLECT · READ · PRACTICE</small>
            <h1>让收藏，接上下一次学习。</h1>
            <p>留住原句，在新的语境里读懂，再把卡住的语法练明白。</p>
          </div>
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
        {ready && (
          <div key={tab} className="dashboard-local-transition">
            {tab === 'words' ? (
              <NotebookPanel
                key={session.user.id}
                session={session}
                selected={selected}
                onSelect={choose}
                onRead={() => navigate('reading')}
              />
            ) : tab === 'sentences' ? (
              <SentenceFavoritesPanel session={session} />
            ) : (
              <LearningPanel
                key={`${session.user.id}:${tab}`}
                session={session}
                kind={tab === 'reading' ? 'READING' : 'GRAMMAR'}
                selected={selected}
                onChooseWords={() => navigate('words')}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
