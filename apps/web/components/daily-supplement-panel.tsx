'use client';
import { useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import type { LearningPlan } from './dashboard';
import styles from './daily-supplement-panel.module.css';

type Preview = {
  deploymentReady: boolean;
  enabled: boolean;
  enrolled: boolean;
  total: number;
  rows: Array<{
    word: string;
    meaning: string | null;
    state: string;
    attempts: number;
    nextReviewAt: string | null;
  }>;
};
const stateLabels: Record<string, string> = {
  needs_sync: '可同步后新学',
  available: '可新学',
  missing: '暂缺释义',
  mastered: '已掌握，跳过',
  learned_elsewhere: '其他练习已安排或已学，跳过',
  in_supplement: '补充词书中',
};
function parsePreview(data: Preview) {
  if (
    !data ||
    !Array.isArray(data.rows) ||
    typeof data.enabled !== 'boolean' ||
    !Number.isInteger(data.total) ||
    data.rows.some((row) => !row || typeof row.word !== 'string' || typeof row.state !== 'string')
  )
    throw new Error('补充词书暂时无法读取，请稍后重新进入。');
  return data;
}
export function DailySupplementPanel({
  session,
  onCreatePlan,
  existingPlan,
  refreshKey,
}: {
  session: Session;
  onCreatePlan: (plan: LearningPlan) => void;
  existingPlan: LearningPlan | null;
  refreshKey: number;
}) {
  const [state, setState] = useState<{ owner: string; data: Preview | null }>({
    owner: session.user.id,
    data: null,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const data = state.owner === session.user.id ? state.data : null;
  useEffect(() => {
    const current = ++sequence.current;
    setError('');
    setState({ owner: session.user.id, data: null });
    void request<Preview>('/vocabulary/daily-supplement', {}, session.accessToken)
      .then((result) => {
        const data = parsePreview(result);
        if (current === sequence.current) setState({ owner: session.user.id, data });
      })
      .catch(() => {
        if (current === sequence.current) setError('补充词书暂时无法读取，请稍后重新进入。');
      });
    return () => {
      sequence.current++;
    };
  }, [session.user.id, session.accessToken, refreshKey]);
  async function act(kind: 'toggle' | 'practice' | 'sync') {
    if (!data || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const current = sequence.current;
    try {
      if (kind === 'toggle' || kind === 'sync') {
        const next = await request<Preview>(
          '/vocabulary/daily-supplement',
          {
            method: 'PATCH',
            body: JSON.stringify({ enabled: kind === 'sync' || !data.enabled }),
          },
          session.accessToken,
        );
        if (current === sequence.current)
          setState({ owner: session.user.id, data: parsePreview(next) });
      } else {
        const plan = await request<LearningPlan>(
          '/study/plans',
          {
            method: 'POST',
            body: JSON.stringify({ mode: 'individual', selection: 'supplement', newWordCount: 5 }),
          },
          session.accessToken,
        );
        if (current === sequence.current) onCreatePlan(plan);
      }
    } catch (error) {
      if (current === sequence.current)
        setError(error instanceof Error ? error.message : '操作失败，请重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-labelledby="daily-supplement-title">
      <h3 id="daily-supplement-title">日常生活 · 补充词书</h3>
      <p>将已核对的词列作为独立词练习，沿用现有词库释义。旧词书、默认词书和学习记录保持不变。</p>
      {!data && !error && <p role="status">正在读取补充词…</p>}
      {data && (
        <>
          <p role="status">
            {data.enabled ? '已启用' : data.enrolled ? '已暂停' : '尚未启用'} · 可新学{' '}
            {data.rows.filter((row) => row.state === 'available').length} 词 · 已安排、已学或已掌握{' '}
            {
              data.rows.filter((row) => ['learned_elsewhere', 'mastered'].includes(row.state))
                .length
            }{' '}
            词将跳过
          </p>
          {!data.deploymentReady && (
            <p>补充词书尚未开放，等待服务器完成版本升级检查。已有记录保留。</p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy || (!data.enabled && !data.deploymentReady)}
              onClick={() => void act('toggle')}
            >
              {busy ? '正在处理…' : data.enabled ? '暂停补充词书' : '启用补充词书'}
            </button>
            <button
              type="button"
              disabled={busy || !data.deploymentReady || !data.enabled || Boolean(existingPlan)}
              onClick={() => void act('practice')}
            >
              {existingPlan ? '先完成当前计划' : '练习补充词（最多 5 词）'}
            </button>
            {data.enabled && data.rows.some((row) => row.state === 'needs_sync') && (
              <button
                type="button"
                disabled={busy || !data.deploymentReady}
                onClick={() => void act('sync')}
              >
                同步新增可用词
              </button>
            )}
          </div>
          <p>
            仅从此入口安排补充词的未学词和到期复习。暂停后停止安排新计划，已经生成的计划仍可继续；不删除任何学习记录。
          </p>
          <details>
            <summary>查看 {data.total} 个候选词与当前释义</summary>
            <ul className={styles.words}>
              {data.rows.map((row) => (
                <li key={row.word}>
                  <strong>{row.word}</strong>
                  <span>{stateLabels[row.state] ?? '待检查'}</span>
                  <p>{row.meaning || '暂无释义，本次不安排学习'}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
