'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { request, saveSession, type Session } from '../../lib/api';
import { AuthShell } from '../login/page';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password'));
    if (password !== data.get('confirmPassword')) {
      setError('两次输入的密码不一致');
      setLoading(false);
      return;
    }
    try {
      saveSession(await request<Session>('/auth/register', { method: 'POST', body: JSON.stringify({ displayName: data.get('displayName') || undefined, email: data.get('email'), password }) }));
      router.push('/dashboard');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '注册失败');
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthShell title="建立你的词环" subtitle="从一个词开始，循序相见。">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">昵称（可选）<input name="displayName" className="field mt-2" placeholder="怎么称呼你？"/></label>
        <label className="block mt-4">邮箱<input required name="email" type="email" className="field mt-2" placeholder="you@example.com"/></label>
        <label className="block mt-4">密码<input required name="password" type="password" minLength={8} className="field mt-2" placeholder="至少 8 位"/></label>
        <label className="block mt-4">确认密码<input required name="confirmPassword" type="password" minLength={8} className="field mt-2" placeholder="再输入一次"/></label>
        {error && <p className="text-sm font-black text-[var(--coral)]">{error}</p>}
        <button disabled={loading} className="action w-full mt-6">{loading ? '正在创建…' : '创建账户'}</button>
      </form>
      <p className="mt-8 text-sm font-bold text-[var(--border-color)] opacity-80">
        已有账户？ <Link className="font-black text-[var(--teal)] underline underline-offset-4 hover:text-[#03b0ac]" href="/login">去登录</Link>
      </p>
    </AuthShell>
  );
}
