'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { request, saveSession, type Session } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      saveSession(await request<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) }));
      router.push('/dashboard');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="欢迎回来" subtitle="继续你的词汇循环。">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">邮箱<input required name="email" type="email" className="field mt-2" placeholder="you@example.com"/></label>
        <label className="block mt-4">密码<input required name="password" type="password" minLength={8} className="field mt-2" placeholder="至少 8 位"/></label>
        {error && <p className="text-sm font-black text-[var(--coral)]">{error}</p>}
        <button disabled={loading} className="action w-full mt-6">{loading ? '正在登录…' : '登录'}</button>
      </form>
      <p className="mt-8 text-sm font-bold text-[var(--border-color)] opacity-80">
        还没有词环？ <Link className="font-black text-[var(--teal)] underline underline-offset-4 hover:text-[#03b0ac]" href="/register">创建账户</Link>
      </p>
    </AuthShell>
  );
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center p-6 bg-[var(--soft)] text-[var(--border-color)]">
      <section className="w-full max-w-md rounded-2xl border-4 border-[var(--border-color)] bg-white p-7 shadow-[8px_8px_0_var(--border-color)] transition-all hover:-translate-y-1 hover:-translate-x-1 hover:shadow-[12px_12px_0_var(--border-color)] md:p-9">
        <Link href="/" className="serif text-2xl font-bold text-[var(--border-color)]">
          词环 <small className="ml-1 text-xs font-bold text-[var(--border-color)] opacity-70">LEXLOOP</small>
        </Link>
        <h1 className="serif mt-12 mb-4 text-4xl font-black text-[var(--border-color)]">
          <span className="relative inline-block z-0">
            <span className="relative z-10">{title}</span>
            <span className="absolute bottom-0 left-[-4px] right-[-4px] h-[14px] bg-[var(--gold)] z-0 -rotate-1 rounded-sm skew-x-6" />
          </span>
        </h1>
        <p className="mt-2 text-sm font-black text-[var(--teal)] uppercase tracking-wide">{subtitle}</p>
        <div className="mt-8 text-[var(--border-color)] font-bold">{children}</div>
      </section>
    </main>
  );
}
