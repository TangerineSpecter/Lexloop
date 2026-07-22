'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, readSession, refreshSession, request, saveSession, type Session } from '../../lib/api';
import { Dashboard } from '../../components/dashboard';

export default function DashboardPage() {
  const router = useRouter(); const [session, setSession] = useState<Session | null>(null);
  useEffect(() => { const saved = readSession(); if (!saved) { refreshSession().then((nextSession) => { saveSession(nextSession); setSession(nextSession); }).catch(() => router.replace('/login')); return; } request('/auth/me', {}, saved.accessToken).then(() => setSession(saved)).catch(() => refreshSession().then((nextSession) => { saveSession(nextSession); setSession(nextSession); }).catch(() => { clearSession(); router.replace('/login'); })); }, [router]);
  if (!session) return <main className="min-h-screen grid place-items-center paper-grain">正在确认学习身份…</main>;
  return <Dashboard session={session} onLogout={() => { clearSession(); router.replace('/'); }} />;
}
