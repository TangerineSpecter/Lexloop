'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  clearSession,
  readSession,
  refreshSession,
  request,
  saveSession,
  type Session,
} from '../lib/api';
import { DashboardBootstrapLoading } from './dashboard-loading';

const Dashboard = dynamic(() => import('./dashboard').then((module) => module.Dashboard), {
  loading: () => <DashboardBootstrapLoading />,
});

export function DashboardRoute() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    let active = true;
    const saved = readSession();
    const load = saved
      ? request('/auth/me', {}, saved.accessToken)
          .then(() => saved)
          .catch(() => refreshSession())
      : refreshSession();
    load
      .then((next) => {
        if (!active) return;
        saveSession(next);
        setSession(next);
      })
      .catch(() => {
        if (!active) return;
        clearSession();
        router.replace('/login');
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (!session) return <DashboardBootstrapLoading />;
  return (
    <Dashboard
      session={session}
      onLogout={() => {
        clearSession();
        router.replace('/');
      }}
    />
  );
}
