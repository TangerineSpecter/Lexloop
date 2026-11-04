'use client';

import { useEffect, useState } from 'react';
import { request, type Session } from '../../lib/api';
import type { LearningPlan } from '../dashboard';
import { DailySupplementPanel } from '../daily-supplement-panel';
import { ProgressivePracticePanel } from '../progressive-practice-panel';
import styles from './practice.module.css';

export type WordPracticeContext = {
  bookId: string | null;
  bookStatus: 'loading' | 'ready' | 'failed';
  onChooseBook: () => void;
  onRetryBook: () => void;
  plans: LearningPlan[];
  planStatus: 'loading' | 'ready' | 'error';
  onRetryPlans: () => void;
  refreshKey: number;
  onCreatePlan: (plan: LearningPlan) => void;
  onOpenExistingPlan: (plan: LearningPlan) => void;
  onNavigate: () => void;
};

export function WordPracticePanel({
  session,
  kind,
  context,
}: {
  session: Session;
  kind: 'progressive' | 'supplement';
  context: WordPracticeContext;
}) {
  const { bookId, bookStatus, plans, planStatus, refreshKey } = context;
  const scope = `${session.user.id}:${bookId ?? ''}`;
  const [wordsState, setWordsState] = useState<{
    scope: string;
    status: 'loading' | 'ready' | 'error';
  }>({ scope, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (kind !== 'progressive' || bookStatus !== 'ready' || !bookId) return;
    let active = true;
    setWordsState({ scope, status: 'loading' });
    const params = new URLSearchParams({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    void request(`/vocabulary/dashboard-words?${params}`, {}, session.accessToken)
      .then(() => {
        if (active) setWordsState({ scope, status: 'ready' });
      })
      .catch(() => {
        if (active) setWordsState({ scope, status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [kind, bookId, bookStatus, scope, session.accessToken, refreshKey, attempt]);

  const bookReady =
    bookStatus === 'ready' &&
    bookId !== null &&
    wordsState.scope === scope &&
    wordsState.status === 'ready';
  const existingPlan = plans.find((plan) => plan.blocksNewPlanCreation) ?? null;
  return (
    <div>
      {planStatus !== 'ready' && (
        <div className={styles.card} role={planStatus === 'error' ? 'alert' : 'status'}>
          <p>
            {planStatus === 'error'
              ? '已有计划暂时无法读取。确认当前计划后才能开始新练习。'
              : '正在读取已有计划…'}
          </p>
          {planStatus === 'error' && (
            <button type="button" className={styles.secondary} onClick={context.onRetryPlans}>
              重试读取计划
            </button>
          )}
        </div>
      )}
      {planStatus === 'ready' &&
        existingPlan &&
        (kind === 'supplement' || existingPlan.purpose !== 'progressive') && (
          <div className={styles.card}>
            <p>先继续当前学习计划，完成后再开始新的练习。</p>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => context.onOpenExistingPlan(existingPlan)}
            >
              {existingPlan.status === 'FAILED' ? '打开并重试当前计划' : '继续当前计划'}
            </button>
          </div>
        )}
      {kind === 'progressive' ? (
        <>
          {bookStatus !== 'ready' || !bookId ? (
            <div className={styles.card} role={bookStatus === 'failed' ? 'alert' : 'status'}>
              <p>
                {bookStatus === 'loading'
                  ? '正在读取当前词表…'
                  : bookStatus === 'failed'
                    ? '当前词表暂时无法读取。'
                    : '先选择一个词表，再按阶段练习。'}
              </p>
              {bookStatus !== 'loading' && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={bookStatus === 'failed' ? context.onRetryBook : context.onChooseBook}
                >
                  {bookStatus === 'failed' ? '重试读取词表' : '选择词表'}
                </button>
              )}
            </div>
          ) : !bookReady ? (
            <div className={styles.card} role={wordsState.status === 'error' ? 'alert' : 'status'}>
              <p>
                {wordsState.status === 'error'
                  ? '练习词汇暂时无法读取，请重试。'
                  : '正在确认当前词表与到期词…'}
              </p>
              {wordsState.status === 'error' && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  重试读取词汇
                </button>
              )}
            </div>
          ) : null}
          <ProgressivePracticePanel
            session={session}
            bookReady={bookReady}
            planListReady={planStatus === 'ready'}
            existingPlan={existingPlan}
            knownPlans={plans.filter((plan) => plan.purpose === 'progressive')}
            refreshKey={refreshKey}
            onCreatePlan={context.onCreatePlan}
            onOpenExistingPlan={context.onOpenExistingPlan}
          />
        </>
      ) : (
        <DailySupplementPanel
          session={session}
          existingPlan={existingPlan}
          planListReady={planStatus === 'ready'}
          refreshKey={refreshKey}
          onCreatePlan={context.onCreatePlan}
        />
      )}
    </div>
  );
}
