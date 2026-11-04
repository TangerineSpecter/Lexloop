'use client';

import { useEffect, useState } from 'react';
import type { PracticeTab } from '@lexloop/types';
import type { Session } from '../../lib/api';
import { DailyOutputPanel } from './daily-output-panel';
import { ConfusionPanel } from './confusion-panel';
import { WeeklyPanel } from './weekly-panel';
import styles from './practice.module.css';
import { DashboardBackButton } from '../dashboard-back-button';
import { WordPracticePanel, type WordPracticeContext } from './word-practice-panel';

type PracticePageTab = PracticeTab | 'progressive' | 'supplement';
const tabs: Array<{ id: PracticePageTab; title: string }> = [
  { id: 'progressive', title: '渐进练习' },
  { id: 'supplement', title: '补充词书' },
  { id: 'output', title: '每日输出挑战' },
  { id: 'confusion', title: '易混词对比训练' },
  { id: 'weekly', title: '每周学习处方' },
];
function tabFromLocation(): PracticePageTab {
  if (typeof window === 'undefined') return 'output';
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'confusion' ||
    value === 'weekly' ||
    value === 'progressive' ||
    value === 'supplement'
    ? value
    : 'output';
}
export function PracticePage({
  session,
  embedded = false,
  onBack,
  wordPractice,
}: {
  session: Session;
  embedded?: boolean;
  onBack?: () => void;
  wordPractice: WordPracticeContext;
}) {
  const [tab, setTab] = useState<PracticePageTab>(tabFromLocation);
  const [ready, setReady] = useState(true);
  useEffect(() => {
    const read = () => {
      setTab(tabFromLocation());
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
  function navigate(value: PracticePageTab) {
    if (tab === value) return;
    wordPractice.onNavigate();
    setTab(value);
    window.history.pushState(
      { ...window.history.state, lexloopDashboardPage: 'practice' },
      '',
      `/dashboard/practice?tab=${value}`,
    );
    window.dispatchEvent(new Event('lexloop-dashboard-navigate'));
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
            <p>PUT YOUR WORDS TO WORK</p>
            <h1>让学过的词，用起来。</h1>
            <span>表达、辨析与计划，让每次学习接上下一步。</span>
          </div>
        </header>
        <nav className={styles.tabs} aria-label="学习专项">
          {tabs.map((item) => (
            <button
              key={item.id}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              {item.title}
            </button>
          ))}
        </nav>
        {ready && (
          <div key={tab} className="dashboard-local-transition">
            {tab === 'progressive' || tab === 'supplement' ? (
              <WordPracticePanel session={session} kind={tab} context={wordPractice} />
            ) : tab === 'output' ? (
              <DailyOutputPanel key={session.user.id} session={session} />
            ) : tab === 'confusion' ? (
              <ConfusionPanel session={session} />
            ) : (
              <WeeklyPanel session={session} onNavigate={navigate} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
