'use client';

import { BookOpen } from 'lucide-react';
import { DashboardBackButton } from './dashboard-back-button';

export function LearningLoadingMark({ className }: { className?: string }) {
  return (
    <span
      className={['learning-loading-mark', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  );
}

export function DashboardBootstrapLoading({
  label = '正在展开你的词环…',
  context = 'dashboard',
}: {
  label?: string;
  context?: 'dashboard' | 'adventure';
}) {
  return (
    <main
      className="dashboard-bootstrap"
      data-dashboard-bootstrap-loading="true"
      data-loading-context={context}
    >
      <aside className="dashboard-bootstrap-sidebar" aria-hidden="true">
        <div className="dashboard-bootstrap-brand">
          <span className="dashboard-bootstrap-brand-mark">
            <BookOpen size={19} />
          </span>
          <span>Lexloop · 词环</span>
        </div>
        <div className="dashboard-bootstrap-line" />
        <div className="dashboard-bootstrap-line" />
        <div className="dashboard-bootstrap-line" />
      </aside>
      <section className="dashboard-bootstrap-main" aria-busy="true">
        <div className="dashboard-bootstrap-topbar" aria-hidden="true" />
        <div className="dashboard-bootstrap-status" role="status" aria-live="polite">
          <LearningLoadingMark className="dashboard-bootstrap-status-mark" />
          <span>{label}</span>
        </div>
        <div className="dashboard-bootstrap-line dashboard-bootstrap-title" aria-hidden="true" />
        <div className="dashboard-bootstrap-grid" aria-hidden="true">
          <div className="dashboard-bootstrap-block" />
          <div className="dashboard-bootstrap-block" />
          <div className="dashboard-bootstrap-block" />
        </div>
      </section>
    </main>
  );
}

export function DashboardLoadingCard({
  label,
  announce = false,
}: {
  label: string;
  announce?: boolean;
}) {
  return (
    <div
      className="dashboard-chunk-loading-card"
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy={announce ? 'true' : undefined}
    >
      <LearningLoadingMark className="dashboard-chunk-loading-mark" />
      <p>{label}</p>
      <div className="dashboard-chunk-skeleton" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export function DashboardPageLoading({
  page,
  title,
  label = '正在打开栏目…',
  onBack,
}: {
  page:
    | 'travel'
    | 'mistakes'
    | 'history'
    | 'statistics'
    | 'settings'
    | 'notebook'
    | 'micro-stories'
    | 'practice';
  title: string;
  label?: string;
  onBack?: () => void;
}) {
  return (
    <div
      className="study-content dashboard-chunk-loading"
      data-dashboard-page={page}
      aria-busy="true"
      role="status"
      aria-live="polite"
    >
      {onBack && <DashboardBackButton onClick={onBack}>返回学习进度</DashboardBackButton>}
      <h1>{title}</h1>
      <DashboardLoadingCard label={label} />
    </div>
  );
}
