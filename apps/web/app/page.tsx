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
  if (!verified) return <main className="min-h-screen grid place-items-center paper-grain"><span>正在展开你的词环…</span></main>;
  if (!session) return <Welcome />;
  return <Dashboard session={session} onLogout={() => { clearSession(); setSession(null); }} />;
}

function Welcome() { return <main className="min-h-screen paper-grain px-6 py-6 md:px-12"><nav className="mx-auto flex max-w-6xl items-center justify-between"><span className="serif text-2xl font-semibold tracking-tight">词环 <small className="ml-2 text-xs font-normal">LEXLOOP</small></span><Link className="rounded-full border border-[#18342a] px-4 py-2 text-sm hover:bg-[#18342a] hover:text-[#f5f0e7]" href="/login">登录</Link></nav><section className="mx-auto grid max-w-6xl gap-12 pt-20 md:grid-cols-[1.2fr_.8fr] md:pt-32"><div><p className="mb-5 text-sm tracking-[.22em] text-[#56765c]">LEARN · RETURN · REMEMBER</p><h1 className="serif max-w-3xl text-5xl leading-[1.05] md:text-7xl">每一个单词，<br/><em className="font-normal text-[#c9644b]">都会再见。</em></h1><p className="mt-8 max-w-lg text-base leading-7 text-[#456052]">词环把遗忘变成下一次相遇的理由。背词、刷题、错题与反馈，共同组成你自己的英语学习循环。</p><Link href="/register" className="action mt-9 inline-flex items-center gap-2">开始建立词环 <ArrowUpRight size={18}/></Link></div><div className="relative mx-auto w-full max-w-sm rotate-2 rounded-sm border border-[#18342a] bg-[#d9e4d7] p-7 shadow-[10px_10px_0_#e9aa3c]"><p className="text-xs tracking-[.18em] text-[#56765c]">TODAY’S RETURN</p><p className="serif mt-12 text-5xl">resilient</p><p className="mt-3 text-sm italic">/rɪˈzɪliənt/</p><p className="mt-7 border-t border-[#56765c]/40 pt-4 text-sm leading-6">能够迅速恢复、适应变化的。<br/>「把每次遗忘，看作回来的机会。」</p><div className="mt-12 flex justify-between text-xs"><span>第 3 次相遇</span><span>↺ 记忆强度 72%</span></div></div></section></main>; }
