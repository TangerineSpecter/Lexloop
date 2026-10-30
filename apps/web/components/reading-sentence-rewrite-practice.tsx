'use client';

import type { ReadingSentenceRewriteFeedback } from '@lexloop/types';
import { useState, type FormEvent } from 'react';
import type { Session } from '../lib/api';
import { useFormativeFeedbackRequest } from './use-formative-feedback-request';

export function ReadingSentenceRewritePractice({
  id,
  open,
  session,
  sourceSentence,
}: {
  id: string;
  open: boolean;
  session: Session;
  sourceSentence: string;
}) {
  const [rewrite, setRewrite] = useState('');
  const [lastSubmission, setLastSubmission] = useState<{
    answer: string;
    feedback: ReadingSentenceRewriteFeedback;
  } | null>(null);
  const [error, setError] = useState('');
  const { submitting, submit: submitFeedback } = useFormativeFeedbackRequest({ open });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = rewrite.trim();
    if (!answer || submitting) return;
    setError('');
    const result = await submitFeedback<ReadingSentenceRewriteFeedback>(
      '/ai/reading-rewrite-feedback',
      { sourceSentence, learnerRewrite: answer },
      session.accessToken,
      '改写反馈暂时不可用。',
    );
    if (result.status === 'success') setLastSubmission({ answer, feedback: result.feedback });
    if (result.status === 'error') setError(result.message);
  };

  return (
    <section id={id} className="sentence-rewrite-panel" aria-label="单句改写练习" hidden={!open}>
      <h3>保留原意，换一种英文表达</h3>
      <p className="sentence-rewrite-note">
        只在提交后把原句和你的改写发送给当前选择的模型；不会保存作答、计分或调整复习计划。反馈是参考建议。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor={`${id}-answer`}>你的改写</label>
        <textarea
          id={`${id}-answer`}
          aria-label="你的英文改写"
          maxLength={1200}
          value={rewrite}
          disabled={submitting}
          onChange={(event) => {
            setRewrite(event.target.value);
            setError('');
          }}
          placeholder="先写下你的表达，再提交查看意思、语法和自然度建议。"
        />
        <div className="sentence-rewrite-actions">
          <button type="submit" disabled={!rewrite.trim() || submitting}>
            {submitting ? (lastSubmission ? '正在更新建议…' : '正在整理建议…') : '提交并查看建议'}
          </button>
          <span>{rewrite.length}/1200</span>
        </div>
      </form>
      {error && (
        <p className="sentence-rewrite-error" role="alert">
          {error} {lastSubmission ? '上次成功的反馈（对应下方所示版本）仍保留。' : ''}
          再次提交会重新请求所选模型。
        </p>
      )}
      {lastSubmission && (
        <section className="sentence-rewrite-feedback" aria-label="改写参考反馈" aria-live="polite">
          <div className="sentence-feedback-submission">
            <strong>这条建议对应的已提交改写</strong>
            <blockquote lang="en">{lastSubmission.answer}</blockquote>
          </div>
          <h4>改写参考反馈</h4>
          <dl>
            <div>
              <dt>意思</dt>
              <dd>{lastSubmission.feedback.meaning}</dd>
            </div>
            <div>
              <dt>语法</dt>
              <dd>{lastSubmission.feedback.grammar}</dd>
            </div>
            <div>
              <dt>自然度</dt>
              <dd>{lastSubmission.feedback.naturalness}</dd>
            </div>
            {lastSubmission.feedback.alternative && (
              <div>
                <dt>另一种表达</dt>
                <dd lang="en">{lastSubmission.feedback.alternative}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </section>
  );
}
