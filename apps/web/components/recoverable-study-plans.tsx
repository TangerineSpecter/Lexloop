'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  LoaderCircle,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { request, userFacingError, type Session } from '../lib/api';
import styles from './recoverable-study-plans.module.css';

type RecoverableStudyPlan = {
  id: string;
  mode: 'group' | 'individual' | 'exam';
  purpose: 'normal' | 'weakness' | 'progressive';
  progressiveStage?: 'foundation' | 'context' | 'transfer' | null;
  progressiveVersion?: number | null;
  status: 'GENERATING' | 'ACTIVE' | 'FAILED';
  createdAt: string;
  generationError: string | null;
  generationPhase: string | null;
  generationStartedAt: string | null;
  wordCount: number;
  completed: number;
};

type RecoverableStudyPlanPage = {
  items: RecoverableStudyPlan[];
  hasMore: boolean;
  nextCursor: string | null;
};

type LoadedPage = RecoverableStudyPlanPage & { ownerId: string };
type LatestPlanState = {
  id: string;
  status: RecoverableStudyPlan['status'] | 'COMPLETED';
  generationError?: string | null;
  generationPhase?: string | null;
  generationStartedAt?: string | null;
  wordCount: number;
  completed: number;
};

function parseRecoverableStudyPlanPage(value: unknown): RecoverableStudyPlanPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('未完成计划列表暂时无法读取，请重试。');
  }
  const page = value as Record<string, unknown>;
  if (
    !Array.isArray(page.items) ||
    typeof page.hasMore !== 'boolean' ||
    (page.nextCursor !== null && typeof page.nextCursor !== 'string')
  ) {
    throw new Error('未完成计划列表暂时无法读取，请重试。');
  }
  const validItems = page.items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const plan = item as Record<string, unknown>;
    return (
      typeof plan.id === 'string' &&
      ['group', 'individual', 'exam'].includes(String(plan.mode)) &&
      ['normal', 'weakness', 'progressive'].includes(String(plan.purpose)) &&
      (plan.progressiveStage === undefined ||
        plan.progressiveStage === null ||
        ['foundation', 'context', 'transfer'].includes(String(plan.progressiveStage))) &&
      (plan.progressiveVersion === undefined ||
        plan.progressiveVersion === null ||
        (Number.isInteger(plan.progressiveVersion) && Number(plan.progressiveVersion) > 0)) &&
      ['GENERATING', 'ACTIVE', 'FAILED'].includes(String(plan.status)) &&
      typeof plan.createdAt === 'string' &&
      (plan.generationError === null || typeof plan.generationError === 'string') &&
      typeof plan.wordCount === 'number' &&
      typeof plan.completed === 'number'
    );
  });
  if (!validItems) throw new Error('未完成计划列表暂时无法读取，请重试。');
  return page as RecoverableStudyPlanPage;
}

const modeLabel: Record<RecoverableStudyPlan['mode'], string> = {
  group: '分组学习',
  individual: '单词逐个学',
  exam: '应试语境',
};
const progressiveStageLabel: Record<
  NonNullable<RecoverableStudyPlan['progressiveStage']>,
  string
> = {
  foundation: '短句辨义',
  context: '语境辨析',
  transfer: '跨句推断',
};
const phaseLabel: Record<string, string> = {
  PREPARING: '正在准备学习材料',
  WAITING_PUBLIC_CACHE: '正在查找可复用材料',
  WAITING_MODEL: '正在等待材料生成',
  VALIDATING: '正在检查学习材料',
  REPAIRING: '正在补齐未通过检查的内容',
  SAVING: '正在保存学习材料',
};

function formatCreatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '创建时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function RecoverableStudyPlans({
  session,
  knownPlans,
  onOpenPlan,
}: {
  session: Session;
  knownPlans: LatestPlanState[];
  onOpenPlan: (planId: string) => Promise<'opened' | 'completed'>;
}) {
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<LoadedPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const knownPlanById = new Map(knownPlans.map((plan) => [plan.id, plan]));
  const displayedPlans = page?.items.flatMap((plan) => {
    const latest = knownPlanById.get(plan.id);
    if (latest?.status === 'COMPLETED') return [];
    if (!latest) return [plan];
    return [
      {
        ...plan,
        status: latest.status,
        generationError: latest.generationError ?? plan.generationError,
        generationPhase: latest.generationPhase ?? null,
        generationStartedAt: latest.generationStartedAt ?? null,
        wordCount: latest.wordCount,
        completed: latest.completed,
      },
    ];
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setPage(null);
    setMoreError('');
    void request<unknown>('/study/plans/recovery?pageSize=20', {}, session.accessToken)
      .then((result) => {
        if (active) setPage({ ...parseRecoverableStudyPlanPage(result), ownerId: session.user.id });
      })
      .catch((error: unknown) => {
        if (active) setLoadError(userFacingError(error, '未完成计划加载失败，请重试。'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision, session.accessToken, session.user.id]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loadingMore || page.ownerId !== session.user.id) return;
    const cursor = page.nextCursor;
    setLoadingMore(true);
    setMoreError('');
    try {
      const result = parseRecoverableStudyPlanPage(
        await request<unknown>(
          `/study/plans/recovery?pageSize=20&cursor=${encodeURIComponent(cursor)}`,
          {},
          session.accessToken,
        ),
      );
      setPage((current) => {
        if (!current || current.ownerId !== session.user.id) return current;
        const knownIds = new Set(current.items.map((plan) => plan.id));
        return {
          ...result,
          ownerId: current.ownerId,
          items: [...current.items, ...result.items.filter((plan) => !knownIds.has(plan.id))],
        };
      });
    } catch (error) {
      setMoreError(userFacingError(error, '更多计划加载失败，请重试。'));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, page, session.accessToken, session.user.id]);

  const openPlan = useCallback(
    async (plan: RecoverableStudyPlan) => {
      if (openingId || page?.ownerId !== session.user.id) return;
      setOpeningId(plan.id);
      setActionError(null);
      try {
        await onOpenPlan(plan.id);
        setRevision((value) => value + 1);
      } catch (error) {
        setActionError({
          id: plan.id,
          message: userFacingError(error, '暂时无法打开这个计划，请重试。'),
        });
      } finally {
        setOpeningId(null);
      }
    },
    [onOpenPlan, openingId, page?.ownerId, session.user.id],
  );

  return (
    <section
      className={styles.section}
      aria-labelledby="recoverable-study-plans-title"
      aria-busy={loading || loadingMore}
    >
      <header className={styles.heading}>
        <div>
          <h2 id="recoverable-study-plans-title">需要继续处理的计划</h2>
          <p>显示仍在学习、生成中或生成失败的计划。只有你点击后才会打开或重试。</p>
        </div>
      </header>

      {loading ? (
        <p className={styles.state} role="status">
          <LoaderCircle size={18} aria-hidden="true" />
          正在读取未完成计划…
        </p>
      ) : loadError ? (
        <div className={styles.stateError} role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{loadError}</span>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : !displayedPlans?.length ? (
        <p className={styles.empty}>目前没有需要恢复的计划。</p>
      ) : (
        <>
          <div className={styles.list}>
            {displayedPlans.map((plan) => {
              const failed = plan.status === 'FAILED';
              const generating = plan.status === 'GENERATING';
              const statusText = failed ? '生成失败' : generating ? '生成中' : '学习中';
              const progressText = plan.wordCount
                ? `${plan.completed}/${plan.wordCount} 组已完成`
                : '尚无可显示的题目进度';
              return (
                <article className={styles.card} key={plan.id} data-plan-id={plan.id}>
                  <div className={styles.cardMain}>
                    <div className={styles.labels}>
                      <strong className={failed ? styles.failed : styles.active}>
                        {failed ? (
                          <AlertTriangle size={16} aria-hidden="true" />
                        ) : (
                          <BookOpen size={16} aria-hidden="true" />
                        )}
                        {statusText}
                      </strong>
                      <span>{modeLabel[plan.mode] ?? '学习计划'}</span>
                      <span>
                        {plan.purpose === 'weakness'
                          ? '薄弱词专项'
                          : plan.purpose === 'progressive'
                            ? `渐进练习${plan.progressiveStage ? ` · ${progressiveStageLabel[plan.progressiveStage]}` : ''}`
                            : '正常模式'}
                      </span>
                    </div>
                    <p className={styles.meta}>
                      <CalendarClock size={15} aria-hidden="true" />
                      创建于 {formatCreatedAt(plan.createdAt)} · {progressText}
                    </p>
                    {generating && plan.generationPhase && (
                      <p className={styles.phase} role="status">
                        {phaseLabel[plan.generationPhase] ?? '正在处理学习材料'}
                      </p>
                    )}
                    {failed && (
                      <p className={styles.errorReason}>
                        {plan.generationError ??
                          '未保存可展示的具体失败原因；打开计划可查看重试选项。'}
                      </p>
                    )}
                    {actionError?.id === plan.id && (
                      <p className={styles.errorReason} role="alert">
                        {actionError.message}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => void openPlan(plan)}
                    disabled={openingId !== null}
                    aria-label={
                      failed
                        ? `打开${formatCreatedAt(plan.createdAt)}的失败计划，查看原因与重试`
                        : generating
                          ? `查看${formatCreatedAt(plan.createdAt)}计划的生成进度`
                          : `继续${formatCreatedAt(plan.createdAt)}的学习计划`
                    }
                  >
                    {openingId === plan.id ? (
                      <LoaderCircle size={17} aria-hidden="true" />
                    ) : failed ? (
                      <RotateCcw size={17} aria-hidden="true" />
                    ) : generating ? (
                      <Sparkles size={17} aria-hidden="true" />
                    ) : (
                      <BookOpen size={17} aria-hidden="true" />
                    )}
                    {openingId === plan.id
                      ? '正在打开…'
                      : failed
                        ? '查看原因与重试'
                        : generating
                          ? '查看生成进度'
                          : '继续学习'}
                  </button>
                </article>
              );
            })}
          </div>
          {moreError && (
            <p className={styles.errorReason} role="alert">
              {moreError}
            </p>
          )}
          {page?.hasMore && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? '正在读取…' : moreError ? '重试加载更多' : '加载更多计划'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
