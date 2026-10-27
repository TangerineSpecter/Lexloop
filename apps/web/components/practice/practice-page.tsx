'use client';

import { useEffect, useState } from 'react';
import type { PracticeTab } from '@lexloop/types';
import type { Session } from '../../lib/api';
import { DailyOutputPanel } from './daily-output-panel';
import { ConfusionPanel } from './confusion-panel';
import { WeeklyPanel } from './weekly-panel';
import styles from './practice.module.css';

const tabs: Array<{ id: PracticeTab; title: string }> = [
  { id: 'output', title: '每日输出挑战' },
  { id: 'confusion', title: '易混词对比训练' },
  { id: 'weekly', title: '每周学习处方' },
];
export function PracticePage({ session }: { session: Session }) {
  const [tab, setTab] = useState<PracticeTab>('output');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const read = () => {
      const value = new URLSearchParams(window.location.search).get('tab');
      setTab(value === 'confusion' || value === 'weekly' ? value : 'output');
      setReady(true);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  function navigate(value: PracticeTab) {
    setTab(value);
    window.history.pushState(null, '', `/dashboard/practice?tab=${value}`);
  }
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.heading}>
          <div>
            <p>PUT YOUR WORDS TO WORK</p>
            <h1>让学过的词，用起来。</h1>
            <span>表达、辨析与计划，让每次学习接上下一步。</span>
          </div>
          <a href="/dashboard">← 返回词环</a>
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
        {ready &&
          (tab === 'output' ? (
            <DailyOutputPanel key={session.user.id} session={session} />
          ) : tab === 'confusion' ? (
            <ConfusionPanel session={session} />
          ) : (
            <WeeklyPanel session={session} onNavigate={navigate} />
          ))}
      </div>
    </main>
  );
}
