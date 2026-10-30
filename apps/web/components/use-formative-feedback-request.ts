'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { request, userFacingError } from '../lib/api';

type RequestResult<T> =
  | { status: 'success'; feedback: T }
  | { status: 'error'; message: string }
  | { status: 'inactive' };

/** Shares request safety while leaving each practice's draft and feedback history local. */
export function useFormativeFeedbackRequest({
  open,
  cancelOnClose = false,
  cancelOnUnmount = false,
}: {
  open: boolean;
  cancelOnClose?: boolean;
  cancelOnUnmount?: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  const activeController = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      if (cancelOnUnmount) activeController.current?.abort();
      activeController.current = null;
    };
  }, [cancelOnUnmount]);

  const cancelActiveRequest = useCallback(() => {
    requestSequence.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    if (mounted.current) setSubmitting(false);
  }, []);

  useEffect(() => {
    if (!open && cancelOnClose) cancelActiveRequest();
  }, [open, cancelOnClose, cancelActiveRequest]);

  const submit = useCallback(
    async <T>(
      endpoint: string,
      body: unknown,
      accessToken: string,
      fallbackMessage: string,
    ): Promise<RequestResult<T>> => {
      if (activeController.current) return { status: 'inactive' };

      const sequence = ++requestSequence.current;
      const controller = new AbortController();
      activeController.current = controller;
      setSubmitting(true);

      try {
        const feedback = await request<T>(
          endpoint,
          { method: 'POST', body: JSON.stringify(body), signal: controller.signal },
          accessToken,
        );
        if (
          !mounted.current ||
          controller.signal.aborted ||
          requestSequence.current !== sequence ||
          (cancelOnClose && !openRef.current)
        ) {
          return { status: 'inactive' };
        }
        return { status: 'success', feedback };
      } catch (cause) {
        if (
          !mounted.current ||
          controller.signal.aborted ||
          requestSequence.current !== sequence ||
          (cancelOnClose && !openRef.current)
        ) {
          return { status: 'inactive' };
        }
        return { status: 'error', message: userFacingError(cause, fallbackMessage) };
      } finally {
        if (requestSequence.current === sequence) {
          activeController.current = null;
          if (mounted.current) setSubmitting(false);
        }
      }
    },
    [cancelOnClose],
  );

  return { submitting, submit };
}
