'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LabHistory, LabKind, LabLessonView } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';

type LabHistoryLoadState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'success'; data: LabHistory }
  | { key: string; status: 'error'; error: string };

export function useLabLessons(session: Session, kind: LabKind) {
  const [lesson, setLesson] = useState<LabLessonView | null>(null);
  const [historyLoadState, setHistoryLoadState] = useState<LabHistoryLoadState | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [pollRound, setPollRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollPaused, setPollPaused] = useState(false);
  const pendingRequest = useRef<{ signature: string; id: string } | null>(null);
  const active = useRef(true);
  const historyLoadKey = JSON.stringify([session.user.id, kind, page, revision]);
  const currentHistoryLoad = historyLoadState?.key === historyLoadKey ? historyLoadState : null;
  const history = currentHistoryLoad?.status === 'success' ? currentHistoryLoad.data : null;
  const historyLoading = !currentHistoryLoad || currentHistoryLoad.status === 'loading';
  const historyError = currentHistoryLoad?.status === 'error' ? currentHistoryLoad.error : '';
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setHistoryLoadState({ key: historyLoadKey, status: 'loading' });
    request<LabHistory>(`/learning-lab/lessons?kind=${kind}&page=${page}`, {}, session.accessToken)
      .then((value) => {
        if (cancelled) return;
        setHistoryLoadState({ key: historyLoadKey, status: 'success', data: value });
        if (page === 1) setLesson((current) => current ?? value.items[0] ?? null);
      })
      .catch((err) => {
        if (!cancelled)
          setHistoryLoadState({
            key: historyLoadKey,
            status: 'error',
            error: userFacingError(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken, kind, page, revision, historyLoadKey]);
  useEffect(() => {
    if (!lesson || !['QUEUED', 'PROCESSING'].includes(lesson.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    setPollPaused(false);
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(() => void poll(), 3000);
        return;
      }
      if (++attempts > 40) {
        setPollPaused(true);
        return;
      }
      try {
        const value = await request<LabLessonView>(
          `/learning-lab/lessons/${lesson.id}`,
          {},
          session.accessToken,
        );
        if (cancelled) return;
        setLesson(value);
        if (!['QUEUED', 'PROCESSING'].includes(value.status)) {
          setRevision((value) => value + 1);
          return;
        }
        timer = setTimeout(() => void poll(), 3000);
      } catch (err) {
        if (!cancelled) {
          setError(userFacingError(err));
          setPollPaused(true);
        }
      }
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session.accessToken, lesson?.id, lesson?.status, pollRound]);

  const create = async (wordIds: string[] = [], level = 'B1') => {
    if (busy) return;
    setBusy(true);
    setError('');
    const signature = JSON.stringify({ kind, wordIds, level });
    if (pendingRequest.current?.signature !== signature)
      pendingRequest.current = {
        signature,
        id:
          crypto.randomUUID?.() ??
          Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join(''),
      };
    try {
      const value = await request<LabLessonView>(
        '/learning-lab/lessons',
        {
          method: 'POST',
          body: JSON.stringify({
            kind,
            wordIds,
            level,
            clientRequestId: pendingRequest.current.id,
          }),
        },
        session.accessToken,
      );
      if (!active.current) return;
      pendingRequest.current = null;
      setLesson(value);
      setPage(1);
      setRevision((value) => value + 1);
    } catch (err) {
      if (active.current) setError(userFacingError(err));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const submit = async (answers: number[]) => {
    if (!lesson || busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await request<LabLessonView>(
        `/learning-lab/lessons/${lesson.id}/answers`,
        { method: 'POST', body: JSON.stringify({ answers }) },
        session.accessToken,
      );
      if (active.current) {
        setLesson(value);
        setRevision((value) => value + 1);
      }
    } catch (err) {
      if (active.current) setError(userFacingError(err));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const resume = useCallback(() => {
    setError('');
    setPollRound((value) => value + 1);
    setRevision((value) => value + 1);
  }, []);
  const reloadHistory = useCallback(() => setRevision((value) => value + 1), []);
  return {
    lesson,
    history,
    historyLoading,
    historyError,
    page,
    setPage,
    busy,
    error,
    pollPaused,
    create,
    submit,
    resume,
    reloadHistory,
    open: (value: LabLessonView) => {
      setLesson(value);
      setError('');
      setPollRound((round) => round + 1);
    },
  };
}
