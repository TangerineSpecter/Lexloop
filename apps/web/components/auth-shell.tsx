import Link from 'next/link';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-story" aria-hidden="true">
        <Link href="/" className="auth-brand">词环 <i>LEXLOOP</i></Link>
        <div className="auth-story-copy"><p>MEMORY NOTE · 01</p><h2>让单词，<br /><em>一次次回来。</em></h2><span>↗</span></div>
        <div className="auth-mini-chart"><b>今日印象</b><div><i /><i /><i /><i /></div><p><span>复习</span><span>新词</span><span>掌握</span><span>回见</span></p></div>
        <small>LEARN · RETURN · REMEMBER</small>
      </section>
      <section className="auth-form-side">
        <div className="auth-form-card">
          <Link href="/" className="auth-mobile-brand">词环 <i>LEXLOOP</i></Link>
          <p className="auth-kicker">YOUR VOCABULARY LOOP</p>
          <h1>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>
          <div className="auth-form-content">{children}</div>
        </div>
      </section>
    </main>
  );
}
