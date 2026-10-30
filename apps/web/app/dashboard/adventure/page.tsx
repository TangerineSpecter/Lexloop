'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AdventurePage } from '../../../components/adventure/adventure-page';
import { DashboardBootstrapLoading } from '../../../components/dashboard-loading';
import {
  clearSession,
  readSession,
  refreshSession,
  request,
  saveSession,
  type Session,
} from '../../../lib/api';

export default function AdventureRoute() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const saved = readSession();
    const load = saved
      ? request('/auth/me', {}, saved.accessToken)
          .then(() => saved)
          .catch(() => refreshSession())
      : refreshSession();
    load
      .then((next) => {
        saveSession(next as Session);
        setSession(next as Session);
      })
      .catch(() => {
        clearSession();
        router.replace('/login');
      });
  }, [router]);
  if (!session) return <DashboardBootstrapLoading context="adventure" label="正在翻开冒险手账…" />;
  return <AdventurePage session={session} onBack={() => router.push('/dashboard')} />;
}
