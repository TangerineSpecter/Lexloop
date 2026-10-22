'use client';

import { useEffect, useState } from 'react';
import type { PracticeTab, WeeklyPrescription } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import styles from './practice.module.css';

export function WeeklyPanel({
  session,
  onNavigate,
}: {
  session: Session;
  onNavigate: (tab: PracticeTab) => void;
}) {
  const [plan, setPlan] = useState<WeeklyPrescription | null>(null);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setMessage('');
    request<WeeklyPrescription>('/practice/weekly', {}, session.accessToken)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((error) => {
        if (!cancelled) setMessage(userFacingError(error));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken, revision]);
  if (!plan)
    return (
      <section className={styles.empty} role="status">
        <p>{message || '正在根据学习记录准备本周任务…'}</p>
        {message && <button onClick={() => setRevision((value) => value + 1)}>重新加载</button>}
      </section>
    );
  const stats = plan.summary;
  return (
    <section aria-labelledby="weekly-title">
      <header className={styles.sectionHead}>
        <div>
          <small>
            {plan.weekStart} — {plan.weekEnd} · WEEKLY PLAN
          </small>
          <h2 id="weekly-title">这一周，先做好这三件事。</h2>
        </div>
        <button
          className={styles.secondary}
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          {busy ? '更新中…' : '刷新处方'}
        </button>
      </header>
      {message && (
        <p className={styles.notice} role="alert">
          {message}
        </p>
      )}
      <div className={styles.weekSummary}>
        <div>
          <strong>{stats.attempts}</strong>
          <span>词汇作答</span>
        </div>
        <div>
          <strong>{stats.accuracy === null ? '—' : `${stats.accuracy}%`}</strong>
          <span>正确率</span>
        </div>
        <div>
          <strong>{stats.outputs}</strong>
          <span>输出挑战</span>
        </div>
        <div>
          <strong>{stats.contrasts}</strong>
          <span>对比训练</span>
        </div>
      </div>
      <p className={styles.hint}>
        依据 {plan.evidenceStart} 至 {plan.evidenceEnd} 的近 7
        天记录，以及当前到期复习和薄弱项。完成练习后可刷新调整。
      </p>
      <div className={styles.prescriptions}>
        {plan.actions.map((action, index) => (
          <article key={action.id} className={styles.card}>
            <div className={styles.actionMeta}>
              <span>0{index + 1}</span>
              <small>约 {action.minutes} 分钟</small>
            </div>
            <h3>{action.title}</h3>
            <p className={styles.reason}>{action.reason}</p>
            <p>{action.instruction}</p>
            <a
              className={styles.primary}
              href={action.href}
              onClick={(event) => {
                if (action.id === 'output') {
                  event.preventDefault();
                  onNavigate('output');
                }
              }}
            >
              开始这项练习 →
            </a>
          </article>
        ))}
      </div>
      <section className={styles.weekNote}>
        <h3>用学习证据决定下一步</h3>
        <p>
          处方由规则根据真实记录生成，不需要额外调用
          AI。记录不足时从小任务开始，不推测能力等级，也不把未测的能力当作薄弱项。
        </p>
        <span>
          当前到期复习 {stats.dueReviews} 词 · 待巩固 {stats.weaknesses} 项
        </span>
      </section>
    </section>
  );
}
