'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const SESSION_STORAGE_KEY = 'lexloop.session';

function sessionUserId(raw: string | null) {
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as { user?: { id?: unknown } };
    return typeof session.user?.id === 'string' && session.user.id.length > 0
      ? session.user.id
      : null;
  } catch {
    return null;
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }),
  );

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key !== SESSION_STORAGE_KEY && event.key !== null) return;

      const currentSession = window.localStorage.getItem(SESSION_STORAGE_KEY);
      const nextUserId = sessionUserId(currentSession);
      if (event.key === SESSION_STORAGE_KEY && sessionUserId(event.oldValue) === nextUserId) {
        return;
      }

      const isAuthPage =
        window.location.pathname === '/login' || window.location.pathname === '/register';
      if (nextUserId) {
        window.document.documentElement.style.visibility = 'hidden';
        if (isAuthPage) window.location.replace('/');
        else window.location.reload();
      } else if (window.location.pathname !== '/login') {
        window.document.documentElement.style.visibility = 'hidden';
        window.location.replace('/login');
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
