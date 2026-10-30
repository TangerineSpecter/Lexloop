import { BookOpen } from 'lucide-react';

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
