'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NotebookPage } from '../../../components/learning-lab/notebook-page';
import {
  clearSession,
  readSession,
  refreshSession,
  request,
  saveSession,
  type Session,
} from '../../../lib/api';

export default function NotebookRoute() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    let cancelled = false;
    const saved = readSession();
    const load = saved
      ? request('/auth/me', {}, saved.accessToken)
          .then(() => saved)
          .catch(() => refreshSession())
      : refreshSession();
    load
      .then((next) => {
        if (!cancelled) {
          saveSession(next);
          setSession(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearSession();
          router.replace('/login');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);
  if (!session)
    return (
      <main className="min-h-screen grid place-items-center paper-grain">正在翻开学习笔记…</main>
    );
  return <NotebookPage session={session} />;
}
