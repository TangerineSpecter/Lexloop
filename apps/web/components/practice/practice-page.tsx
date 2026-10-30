'use client';

import { useEffect, useState } from 'react';
import type { PracticeTab } from '@lexloop/types';
import type { Session } from '../../lib/api';
import { DailyOutputPanel } from './daily-output-panel';
import { ConfusionPanel } from './confusion-panel';
import { WeeklyPanel } from './weekly-panel';
import styles from './practice.module.css';
import { DashboardBackButton } from '../dashboard-back-button';

const tabs: Array<{ id: PracticeTab; title: string }> = [
  { id: 'output', title: '每日输出挑战' },
  { id: 'confusion', title: '易混词对比训练' },
  { id: 'weekly', title: '每周学习处方' },
];
function tabFromLocation(): PracticeTab {
  if (typeof window === 'undefined') return 'output';
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'confusion' || value === 'weekly' ? value : 'output';
}
export function PracticePage({
  session,
  embedded = false,
  onBack,
}: {
  session: Session;
  embedded?: boolean;
  onBack?: () => void;
}) {
  const [tab, setTab] = useState<PracticeTab>(tabFromLocation);
  const [ready, setReady] = useState(true);
  useEffect(() => {
    const read = () => {
      const value = new URLSearchParams(window.location.search).get('tab');
      setTab(value === 'confusion' || value === 'weekly' ? value : 'output');
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
  function navigate(value: PracticeTab) {
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
            {tab === 'output' ? (
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
