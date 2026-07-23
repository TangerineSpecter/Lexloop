'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { request, saveSession, type Session } from '../../lib/api';
import { AuthShell } from '../../components/auth-shell';

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
      <form onSubmit={submit} className="auth-form">
        <label>邮箱<input required name="email" type="email" placeholder="you@example.com"/></label>
        <label>密码<input required name="password" type="password" minLength={8} placeholder="至少 8 位"/></label>
        {error && <p className="auth-error">{error}</p>}
        <button disabled={loading} className="auth-submit">{loading ? '正在登录…' : '登录并继续'}</button>
      </form>
      <p className="auth-switch">
        还没有词环？ <Link href="/register">创建账户 ↗</Link>
      </p>
    </AuthShell>
  );
}
