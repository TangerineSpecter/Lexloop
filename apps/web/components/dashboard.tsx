'use client';
import { BookOpen, BrainCircuit, ChartNoAxesColumnIncreasing, LogOut, Sparkles } from 'lucide-react';
import type { Session } from '../lib/api';

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const name = session.user.displayName || session.user.email.split('@')[0];
  return <main className="min-h-screen paper-grain px-6 py-6 md:px-12"><nav className="mx-auto flex max-w-6xl items-center justify-between"><span className="serif text-2xl font-semibold">词环 <small className="ml-2 text-xs font-normal">LEXLOOP</small></span><button onClick={onLogout} className="flex items-center gap-2 text-sm hover:text-[#c9644b]"><LogOut size={16}/>退出</button></nav><section className="mx-auto max-w-6xl pt-18"><p className="text-sm tracking-[.18em] text-[#56765c]">WELCOME BACK, {name.toUpperCase()}</p><h1 className="serif mt-3 text-5xl md:text-6xl">今天，和记忆<br/>再见一次。</h1><div className="mt-12 grid gap-4 md:grid-cols-3"><Card icon={<BookOpen/>} title="复习队列" value="0" detail="单词学习模块即将开放"/><Card icon={<BrainCircuit/>} title="错题回访" value="0" detail="每次失误都会留下线索"/><Card icon={<ChartNoAxesColumnIncreasing/>} title="连续学习" value="0 天" detail="从今天开始积累"/></div><div className="mt-10 rounded-sm border border-dashed border-[#56765c] bg-white/35 p-7"><Sparkles className="text-[#c9644b]"/><p className="serif mt-4 text-2xl">学习模块正在准备中</p><p className="mt-2 text-sm leading-6 text-[#56765c]">基础账户、学习数据、队列任务和 AI/RAG 接口已经就位。下一阶段将接入词书与首次学习会话。</p></div></section></main>;
}

function Card({ icon, title, value, detail }: { icon: React.ReactNode; title: string; value: string; detail: string }) {
  return <article className="rounded-sm border border-[#18342a] bg-[#f5f0e7]/75 p-5 shadow-[4px_4px_0_#18342a]"><div className="flex items-center justify-between text-[#56765c]"><span className="text-sm">{title}</span>{icon}</div><p className="serif mt-9 text-4xl">{value}</p><p className="mt-2 text-xs text-[#56765c]">{detail}</p></article>;
}
