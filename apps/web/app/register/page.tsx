'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { request, saveSession, type Session } from '../../lib/api';
import { AuthShell } from '../../components/auth-shell';

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
      <form onSubmit={submit} className="auth-form">
        <label>昵称 <small>（可选）</small><input name="displayName" placeholder="怎么称呼你？"/></label>
        <label>邮箱<input required name="email" type="email" placeholder="you@example.com"/></label>
        <label>密码<input required name="password" type="password" minLength={8} placeholder="至少 8 位"/></label>
        <label>确认密码<input required name="confirmPassword" type="password" minLength={8} placeholder="再输入一次"/></label>
        {error && <p className="auth-error">{error}</p>}
        <button disabled={loading} className="auth-submit">{loading ? '正在创建…' : '创建我的词环'}</button>
      </form>
      <p className="auth-switch">
        已有账户？ <Link href="/login">去登录 ↗</Link>
      </p>
    </AuthShell>
  );
}
