'use client';

import { useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import type { LearningPlan } from './dashboard';

type Evidence = {
  replacedPlanId?: string | null;
  words: Array<{
    id: string;
    word: string;
    completed: boolean;
    selectedAnswer?: string[];
    question?: { correctAnswers?: string[]; explanation?: string };
  }>;
};

export function ProgressiveRecoveryPanel({
  plan,
  session,
  onReplaced,
}: {
  plan: Pick<
    LearningPlan,
    'id' | 'status' | 'answerKeyRecoveryAvailable' | 'replacementPlanId' | 'replacedPlanId'
  >;
  session: Session;
  onReplaced: (plan: LearningPlan) => void;
}) {
  const scope = `${session.user.id}:${plan.id}`;
  const current = useRef<string | null>(scope);
  current.current = scope;
  useEffect(
    () => () => {
      current.current = null;
    },
    [],
  );
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState<{ scope: string; value: Evidence } | null>(null);
  const load = async (replace: boolean, evidenceId?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (replace) {
        const result = await request<LearningPlan>(
          plan.replacementPlanId
            ? `/study/plans/${plan.replacementPlanId}`
            : `/study/plans/${plan.id}/replace-invalid`,
          plan.replacementPlanId ? {} : { method: 'POST' },
          session.accessToken,
        );
        if (current.current === scope) onReplaced(result);
      } else {
        const result = await request<Evidence>(
          `/study/plans/${evidenceId ?? plan.replacedPlanId ?? plan.id}/review`,
          {},
          session.accessToken,
        );
        if (current.current === scope) setEvidence({ scope, value: result });
      }
    } catch (cause) {
      if (current.current === scope)
        setError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
    } finally {
      pending.current = false;
      if (current.current === scope) setBusy(false);
    }
  };
  const invalid = plan.answerKeyRecoveryAvailable || plan.status === 'INVALIDATED';
  return (
    <section className="plan-empty" aria-label="异常练习恢复">
      {invalid && (
        <>
          <strong>
            {plan.status === 'INVALIDATED'
              ? '这份练习已保留为原始记录'
              : '这份练习有无法可靠判分的答案结构'}
          </strong>
          <p>
            未完成题不计分。已完成的答题记录和复习排期保留；剩余词会进入另一份练习，原题不会被覆盖，也不会因此解锁阶段。
          </p>
          <button disabled={busy} onClick={() => void load(true)}>
            {busy ? '处理中…' : plan.replacementPlanId ? '继续替代练习' : '为剩余词创建替代练习'}
          </button>
          <p>此操作只创建计划。后续生成会先尝试公共题库，缺少材料时按当前模型设置生成。</p>
        </>
      )}
      {(plan.replacedPlanId || plan.status === 'INVALIDATED') && (
        <button disabled={busy} onClick={() => void load(false)}>
          查看保留的原练习记录
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {evidence?.scope === scope && (
        <div>
          {evidence.value.replacedPlanId && (
            <button
              disabled={busy}
              onClick={() => void load(false, evidence.value.replacedPlanId!)}
            >
              查看更早的原练习记录
            </button>
          )}
          {evidence.value.words.map((word) => (
            <article key={word.id}>
              <strong>
                {word.word} · {word.completed ? '已提交' : '未计分'}
              </strong>
              {word.completed ? (
                <>
                  <p>你的答案：{word.selectedAnswer?.join('、') || '未保存具体选择'}</p>
                  <p>本题参考答案：{word.question?.correctAnswers?.join('、') || '未保存'}</p>
                  <p>{word.question?.explanation || '未保存可用解析。'}</p>
                </>
              ) : (
                <p>原题和草稿保留，不作为答错或掌握证据。</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
