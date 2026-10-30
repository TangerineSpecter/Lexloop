'use client';

import type { ReadingTranslationFeedback } from '@lexloop/types';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { request, type Session, userFacingError } from '../lib/api';

export function ReadingSentenceTranslationPractice({
  id,
  open,
  session,
  sourceSentence,
  referenceTranslation,
}: {
  id: string;
  open: boolean;
  session: Session;
  sourceSentence: string;
  referenceTranslation: string;
}) {
  const [translation, setTranslation] = useState('');
  const [lastSubmission, setLastSubmission] = useState<{
    answer: string;
    feedback: ReadingTranslationFeedback;
  } | null>(null);
  const [referenceVisible, setReferenceVisible] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const activeRequest = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open && controller.current) {
      activeRequest.current += 1;
      controller.current.abort();
      controller.current = null;
      setSubmitting(false);
    }
  }, [open]);

  useEffect(
    () => () => {
      activeRequest.current += 1;
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = translation.trim();
    if (!answer || submitting || controller.current) return;

    const requestId = ++activeRequest.current;
    const abortController = new AbortController();
    controller.current = abortController;
    setSubmitting(true);
    setError('');
    try {
      const result = await request<ReadingTranslationFeedback>(
        '/ai/reading-translation-feedback',
        {
          method: 'POST',
          body: JSON.stringify({ sourceSentence, learnerTranslation: answer }),
          signal: abortController.signal,
        },
        session.accessToken,
      );
      if (abortController.signal.aborted || activeRequest.current !== requestId || !openRef.current)
        return;
      setLastSubmission({ answer, feedback: result });
      setReferenceVisible(true);
    } catch (cause) {
      if (!abortController.signal.aborted && activeRequest.current === requestId) {
        setError(userFacingError(cause, '翻译建议暂时不可用。'));
      }
    } finally {
      if (activeRequest.current === requestId) {
        controller.current = null;
        setSubmitting(false);
      }
    }
  };

  return (
    <section
      id={id}
      className="sentence-rewrite-panel sentence-translation-panel"
      aria-label="先翻译再对照"
      hidden={!open}
    >
      <h3>先用自己的话理解这句</h3>
      <p className="sentence-rewrite-note">
        先写下中文理解，再按需查看建议。只有提交后，英文原句和你的译文才会发送给当前选择的模型；建议不计分、不保存，也不改变复习安排。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor={`${id}-answer`}>你的中文理解</label>
        <textarea
          id={`${id}-answer`}
          aria-label="你的中文理解"
          maxLength={1200}
          value={translation}
          disabled={submitting}
          onChange={(event) => {
            setTranslation(event.target.value);
            setReferenceVisible(false);
            setError('');
          }}
          placeholder="不用逐字翻译，先写下你理解的意思。"
        />
        <div className="sentence-rewrite-actions">
          <button type="submit" disabled={!translation.trim() || submitting}>
            {submitting ? '正在整理建议…' : '提交并对照'}
          </button>
          <span>{translation.length}/1200</span>
        </div>
      </form>
      <button
        type="button"
        className="sentence-translation-reference-toggle"
        aria-expanded={referenceVisible}
        aria-controls={`${id}-reference`}
        onClick={() => setReferenceVisible((visible) => !visible)}
      >
        {referenceVisible ? '收起一种参考译文' : '跳过练习，查看一种参考译文'}
      </button>
      {referenceVisible && (
        <p id={`${id}-reference`} className="sentence-translation-reference" lang="zh-CN">
          {referenceTranslation}
        </p>
      )}
      {error && (
        <p className="sentence-rewrite-error" role="alert">
          {error} 你的输入仍保留；此前成功的建议及其对应版本也仍保留，可检查后重试。
        </p>
      )}
      {lastSubmission && (
        <section className="sentence-rewrite-feedback" aria-label="翻译参考反馈" aria-live="polite">
          <div className="sentence-feedback-submission">
            <strong>这条建议对应的已提交译文</strong>
            <blockquote lang="zh-CN">{lastSubmission.answer}</blockquote>
          </div>
          <h4>理解参考建议</h4>
          <dl>
            <div>
              <dt>意思</dt>
              <dd>{lastSubmission.feedback.meaning}</dd>
            </div>
            <div>
              <dt>中文表达</dt>
              <dd>{lastSubmission.feedback.naturalness}</dd>
            </div>
          </dl>
        </section>
      )}
    </section>
  );
}
