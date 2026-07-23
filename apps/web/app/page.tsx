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
  return (
    <main className="min-h-screen px-6 py-6 md:px-12 bg-[var(--soft)] text-[var(--border-color)]">
      <nav className="mx-auto flex max-w-6xl items-center justify-between">
        <span className="serif text-2xl font-bold tracking-tight text-[var(--border-color)]">
          词环 <small className="ml-2 text-xs font-bold text-[var(--border-color)] opacity-70">LEXLOOP</small>
        </span>
        <Link
          className="rounded-lg border-4 border-[var(--border-color)] bg-[var(--gold)] px-6 py-2.5 text-sm font-black text-[var(--border-color)] transition-all hover:-translate-y-1 hover:-translate-x-1 hover:shadow-[6px_6px_0_var(--border-color)] shadow-[4px_4px_0_var(--border-color)] active:translate-y-0 active:translate-x-0 active:shadow-[0_0_0_var(--border-color)]"
          href="/login"
        >
          登录
        </Link>
      </nav>
      <section className="mx-auto grid max-w-6xl gap-12 pt-20 md:grid-cols-[1.2fr_.8fr] md:pt-32">
        <div>
          <p className="mb-5 text-sm font-black tracking-[.22em] text-[var(--teal)] uppercase">Learn · Return · Remember</p>
          <h1 className="serif max-w-3xl text-5xl font-black leading-[1.05] text-[var(--border-color)] md:text-7xl" style={{ textShadow: '4px 4px 0 var(--gold)' }}>
            每一个单词，<br />
            <em className="font-black not-italic text-[var(--coral)]" style={{ textShadow: '2px 2px 0 var(--border-color)' }}>都会再见。</em>
          </h1>
          <p className="mt-8 max-w-lg text-lg font-bold leading-7 text-[var(--border-color)] opacity-80">
            词环把遗忘变成下一次相遇的理由。背词、刷题、错题与反馈，共同组成你自己的英语学习循环。
          </p>
          <Link href="/register" className="action mt-9 inline-flex items-center gap-2 text-lg px-8 py-4">
            开始建立词环 <ArrowUpRight size={22} strokeWidth={3} />
          </Link>
        </div>
        <div className="relative mx-auto w-full max-w-sm rotate-3 rounded-2xl border-4 border-[var(--border-color)] bg-white p-8 shadow-[8px_8px_0_var(--border-color)] transition-all hover:rotate-0 hover:scale-105 hover:shadow-[12px_12px_0_var(--border-color)] hover:-translate-y-2 hover:-translate-x-2">
          <p className="text-xs font-black tracking-[.18em] text-[var(--border-color)] uppercase bg-[var(--gold)] inline-block px-3 py-1 border-2 border-[var(--border-color)] rounded-md shadow-[2px_2px_0_var(--border-color)]">Today's Return</p>
          <p className="serif mt-12 text-5xl font-black text-[var(--border-color)]" style={{ textShadow: '2px 2px 0 var(--teal)' }}>resilient</p>
          <p className="mt-3 text-sm font-bold italic text-[var(--border-color)] opacity-70">/rɪˈzɪliənt/</p>
          <p className="mt-7 border-t-4 border-dashed border-[var(--border-color)] pt-6 text-sm font-bold leading-6 text-[var(--border-color)]">
            能够迅速恢复、适应变化的。<br />
            「把每次遗忘，看作回来的机会。」
          </p>
          <div className="mt-12 flex justify-between text-xs font-black text-[var(--border-color)] bg-[var(--soft)] p-3 rounded-lg border-2 border-[var(--border-color)] shadow-[2px_2px_0_var(--border-color)]">
            <span>第 3 次相遇</span>
            <span className="text-[var(--coral)]">↺ 记忆强度 72%</span>
          </div>
        </div>
      </section>
    </main>
  );
}
