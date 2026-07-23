'use client';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clearSession, readSession, refreshSession, request, saveSession, type Session } from '../lib/api';
import { Dashboard } from '../components/dashboard';

export default function HomePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [verified, setVerified] = useState(false);
  useEffect(() => { const saved = readSession(); if (!saved) { refreshSession().then((session) => { saveSession(session); setSession(session); }).catch(clearSession).finally(() => setVerified(true)); return; } request('/auth/me', {}, saved.accessToken).then(() => setSession(saved)).catch(() => refreshSession().then((session) => { saveSession(session); setSession(session); }).catch(clearSession)).finally(() => setVerified(true)); }, []);
  if (!verified) return <main className="min-h-screen grid place-items-center bg-[var(--soft)] text-[var(--border-color)] font-bold text-lg"><span>正在展开你的词环…</span></main>;
  if (!session) return <Welcome />;
  return <Dashboard session={session} onLogout={() => { clearSession(); setSession(null); }} />;
}

function Welcome() {
  const progress = [
    { label: '今日复习', value: '12', height: '39%', color: 'blue' },
    { label: '新学单词', value: '18', height: '58%', color: 'orange' },
    { label: '本周掌握', value: '42', height: '78%', color: 'paper' },
    { label: '记忆强度', value: '86%', height: '92%', color: 'yellow' },
  ];
  return (
    <main className="welcome-page">
      <nav className="welcome-nav">
        <Link href="/" className="welcome-brand" aria-label="词环首页">词环 <i>LEXLOOP</i></Link>
        <div className="welcome-nav-actions"><Link href="/login" className="ink-link">登录</Link><Link href="/register" className="nav-signup">开始学习 <ArrowUpRight size={16} /></Link></div>
      </nav>
      <section className="welcome-hero">
        <div className="hero-copy">
          <p className="scribble-label">YOUR MEMORY, IN MOTION</p>
          <h1>把每一次<br />遗忘，<em>画成进步。</em></h1>
          <p className="hero-intro">词环为你记录单词的每一次回来。复习、新词、掌握度——所有努力，都看得见。</p>
          <div className="hero-buttons"><Link href="/register" className="begin-button">开始建立词环 <ArrowUpRight size={21} strokeWidth={2.8} /></Link><a href="#memory-chart" className="quiet-button">看看学习轨迹 ↓</a></div>
          <div className="hero-note"><span>✦</span><p>不是刷过就算，<br />是让记忆留下来。</p></div>
        </div>
        <div className="hero-art" id="memory-chart" aria-label="学习进度手绘图表">
          <div className="unit-stamp">单位：<b>词汇印象</b></div>
          <div className="chart-spark spark-one">✦</div><div className="chart-spark spark-two">⌁</div>
          <div className="memory-chart">
            <div className="chart-y"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
            <div className="chart-area">
              <div className="chart-lines"><i /><i /><i /><i /></div>
              <div className="chart-bars">{progress.map((item, index) => <div className="chart-column" key={item.label} style={{ '--delay': `${index * 130}ms` } as React.CSSProperties}><strong>{item.value}</strong><div className={`marker-bar ${item.color}`} style={{ height: item.height }} /><span>{item.label}</span></div>)}</div>
            </div>
          </div>
          <div className="chart-caption"><span className="caption-swatch blue" />每天都有一点点 <b>向上</b><span>↗</span></div>
        </div>
      </section>
      <section className="welcome-footer"><span>Learn · Return · Remember</span><span>2026 / 每个单词都值得再见</span></section>
    </main>
  );
}
