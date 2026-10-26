'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MicroStoriesPage } from '../../../components/micro-stories/micro-stories-page';
import {
  clearSession,
  readSession,
  refreshSession,
  request,
  saveSession,
  type Session,
} from '../../../lib/api';

export default function MicroStoriesRoute() {
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
  if (!session)
    return (
      <main className="min-h-screen grid place-items-center paper-grain">正在打开微故事…</main>
    );
  return <MicroStoriesPage key={session.user.id} session={session} />;
}
