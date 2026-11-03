'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProgressivePracticeStage } from '@lexloop/types';
import { AlertTriangle, BookOpen, Check, LockKeyhole, RotateCcw } from 'lucide-react';
import { request, type Session } from '../lib/api';
import type { LearningPlan } from './dashboard';
import styles from './progressive-practice-panel.module.css';

const STAGES: Array<{
  id: ProgressivePracticeStage;
  title: string;
  focus: string;
}> = [
  { id: 'foundation', title: '短句辨义', focus: '用直白线索识别词义' },
  { id: 'context', title: '语境辨析', focus: '结合搭配和情境判断用法' },
  { id: 'transfer', title: '跨句推断', focus: '从短文中的多条线索推断' },
];

type ProgressivePath = {
  trackVersion: number;
  highestUnlockedStage: ProgressivePracticeStage;
  currentPlan: LearningPlan | null;
};

type LoadState =
  | { ownerId: string; status: 'loading'; path: null }
  | { ownerId: string; status: 'ready'; path: ProgressivePath }
  | { ownerId: string; status: 'failed'; path: null; message: string };

function isStage(value: unknown): value is ProgressivePracticeStage {
  return STAGES.some((stage) => stage.id === value);
}

function stageRank(stage: ProgressivePracticeStage) {
  return STAGES.findIndex((item) => item.id === stage);
}

function parsePath(value: unknown): ProgressivePath {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('渐进练习进度暂时无法读取。');
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.trackVersion) ||
    !isStage(candidate.highestUnlockedStage) ||
    (candidate.currentPlan !== null &&
      (!candidate.currentPlan || typeof candidate.currentPlan !== 'object'))
  ) {
    throw new Error('渐进练习进度暂时无法读取。');
  }
  return candidate as ProgressivePath;
}

export function ProgressivePracticePanel({
  session,
  bookReady,
  planListReady,
  existingPlan,
  refreshKey,
  onCreatePlan,
  onOpenExistingPlan,
}: {
  session: Session;
  bookReady: boolean;
  planListReady: boolean;
  existingPlan: LearningPlan | null;
  refreshKey: number;
  onCreatePlan: (plan: LearningPlan) => void;
  onOpenExistingPlan: (plan: LearningPlan) => void;
}) {
  const requestSequence = useRef(0);
  const creatingRef = useRef(false);
  const [loadState, setLoadState] = useState<LoadState>({
    ownerId: session.user.id,
    status: 'loading',
    path: null,
  });
  const [selectedStage, setSelectedStage] = useState<ProgressivePracticeStage>('foundation');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const visibleState =
    loadState.ownerId === session.user.id
      ? loadState
      : ({ ownerId: session.user.id, status: 'loading', path: null } as const);

  const loadProgress = useCallback(async () => {
    const requestId = ++requestSequence.current;
    const ownerId = session.user.id;
    setLoadState({ ownerId, status: 'loading', path: null });
    try {
      const result = await request<unknown>('/study/progressive-path', {}, session.accessToken);
      if (requestSequence.current !== requestId) return;
      const path = parsePath(result);
      setSelectedStage(path.highestUnlockedStage);
      setLoadState({ ownerId, status: 'ready', path });
    } catch (error) {
      if (requestSequence.current !== requestId) return;
      setLoadState({
        ownerId,
        status: 'failed',
        path: null,
        message: error instanceof Error ? error.message : '渐进练习进度暂时无法读取。',
      });
    }
  }, [session.accessToken, session.user.id]);

  useEffect(() => {
    void loadProgress();
    return () => {
      requestSequence.current++;
    };
  }, [loadProgress, refreshKey]);

  const startSelectedStage = async () => {
    if (creatingRef.current || visibleState.status !== 'ready') return;
    if (existingPlan) {
      setActionError('请先完成当前学习计划，再开始渐进练习。');
      return;
    }
    if (!planListReady || !bookReady) return;
    creatingRef.current = true;
    setCreating(true);
    setActionError('');
    const ownerId = session.user.id;
    const requestId = requestSequence.current;
    try {
      const plan = await request<LearningPlan>(
        '/study/progressive-path/plans',
        {
          method: 'POST',
          body: JSON.stringify({ stage: selectedStage }),
        },
        session.accessToken,
      );
      if (session.user.id !== ownerId || requestSequence.current !== requestId) return;
      onCreatePlan(plan);
    } catch (error) {
      if (session.user.id !== ownerId || requestSequence.current !== requestId) return;
      setActionError(error instanceof Error ? error.message : '创建渐进练习失败，请重试。');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const path = visibleState.status === 'ready' ? visibleState.path : null;
  const highestUnlocked = path?.highestUnlockedStage ?? 'foundation';
  const currentPlan = path?.currentPlan ?? null;
  const isBlocked = Boolean(existingPlan);
  return (
    <section className={styles.panel} aria-labelledby="progressive-practice-title">
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon} aria-hidden="true">
            <BookOpen size={19} />
          </span>
          <div>
            <h3 id="progressive-practice-title">渐进练习</h3>
            <p>按题目要求逐步练习</p>
          </div>
        </div>
        <span className={styles.version}>内部练习路径 v{path?.trackVersion ?? 1}</span>
      </header>

      <p className={styles.disclaimer}>
        完成一组非空练习后解锁下一阶段；答错不会降级。阶段描述题目要求，不代表 CEFR
        认证或掌握度诊断。
      </p>

      {visibleState.status === 'loading' && (
        <p className={styles.notice} role="status">
          正在读取阶段进度…
        </p>
      )}
      {visibleState.status === 'failed' && (
        <div className={styles.error} role="alert">
          <span>
            <AlertTriangle size={16} aria-hidden="true" />
            {visibleState.message}
          </span>
          <button type="button" onClick={() => void loadProgress()}>
            重试
          </button>
        </div>
      )}

      {path && currentPlan && (
        <div className={styles.currentPlan}>
          <div>
            <strong>
              {STAGES.find((stage) => stage.id === currentPlan.progressiveStage)?.title ??
                '渐进练习'}
              {currentPlan.status === 'FAILED'
                ? ' · 生成失败'
                : currentPlan.status === 'GENERATING'
                  ? ' · 正在生成'
                  : ' · 待继续'}
            </strong>
            <p>
              {currentPlan.completed}/{currentPlan.wordCount}{' '}
              个词已提交；继续这份计划不会创建新练习。
            </p>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => onOpenExistingPlan(currentPlan)}
          >
            {currentPlan.status === 'FAILED' ? <RotateCcw size={16} /> : <BookOpen size={16} />}
            {currentPlan.status === 'FAILED' ? '打开并重试' : '继续当前练习'}
          </button>
        </div>
      )}

      {path && !currentPlan && (
        <>
          <div className={styles.stages} role="group" aria-label="选择已解锁的练习阶段">
            {STAGES.map((stage) => {
              const unlocked = stageRank(stage.id) <= stageRank(highestUnlocked);
              const selected = selectedStage === stage.id;
              return (
                <button
                  key={stage.id}
                  type="button"
                  className={`${styles.stage} ${selected ? styles.selected : ''} ${!unlocked ? styles.locked : ''}`}
                  aria-pressed={selected}
                  aria-disabled={!unlocked}
                  onClick={() => {
                    if (unlocked) {
                      setSelectedStage(stage.id);
                      setActionError('');
                    }
                  }}
                >
                  <span className={styles.stageTitle}>
                    {unlocked ? (
                      <Check size={15} aria-hidden="true" />
                    ) : (
                      <LockKeyhole size={15} aria-hidden="true" />
                    )}
                    {stage.title}
                  </span>
                  <span>{stage.focus}</span>
                  {!unlocked && <small>完成上一阶段后解锁</small>}
                  {unlocked && stage.id === highestUnlocked && <small>当前已解锁</small>}
                </button>
              );
            })}
          </div>
          <div className={styles.actions}>
            <p>
              每次从当前到期复习词和新词中选取，最多 5
              词。已有计划时需先完成，不会因选阶段改动词条排期。
            </p>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void startSelectedStage()}
              disabled={creating || !planListReady || !bookReady || isBlocked}
            >
              {creating ? '正在创建练习…' : isBlocked ? '先完成当前学习计划' : '开始所选阶段'}
            </button>
          </div>
          {!bookReady && visibleState.status === 'ready' && (
            <p className={styles.notice} role="status">
              先选择一个有可练词条的词表。
            </p>
          )}
          {actionError && (
            <p className={styles.errorText} role="alert">
              {actionError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
