'use client';

import type {
  LearningHistoryAssessmentItem,
  LearningHistoryItem,
  LearningHistoryPlanItem,
  LearningHistoryResponse,
  LearningHistoryScenarioItem,
} from '@lexloop/types';
import {
  Award,
  BookOpen,
  CheckCircle2,
  Clock3,
  Languages,
  ListChecks,
  MapPin,
  TriangleAlert,
} from 'lucide-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import { DashboardBackButton } from './dashboard-back-button';

const modeLabel: Record<LearningHistoryPlanItem['mode'], string> = {
  group: '分组学习',
  individual: '单词逐个学',
  exam: '应试语境',
};
const exerciseLabel: Record<string, string> = {
  WORD_MNEMONIC: '词根联想',
  MEANING_RECOGNITION: '词义识别',
  WORD_MATCHING: '词义配对',
  SYNONYM_REPLACEMENT: '同义替换',
  READING_COMPREHENSION: '阅读理解',
  OTHER: '综合练习',
};
const categoryLabel: Record<string, string> = {
  AIRPORT: '机场',
  HOTEL: '酒店',
  RESTAURANT: '餐厅',
  SHOPPING: '购物',
  TRANSPORT: '交通',
  HELP: '求助',
};
const emptyTotals: LearningHistoryResponse['totals'] = {
  records: 0,
  plans: 0,
  words: 0,
  questions: 0,
  correctQuestions: 0,
  assessments: 0,
  scenarios: 0,
};
const HISTORY_PAGE_SIZE = 20;

type StudyPlanReviewWord = {
  id: string;
  word: string;
  result?: boolean;
  selectedAnswer?: string[];
  savedContext?: { scenario: string | null; example: string };
  question: {
    type?: string;
    prompt?: string;
    correctAnswers?: string[];
    explanation?: string;
    pairs?: Array<{ left: string; right: string }>;
  };
};

type StudyPlanReview = {
  id: string;
  status: string;
  words: StudyPlanReviewWord[];
};

export function LearningHistoryPage({
  backLabel = '返回学习进度',
  session,
  onBack,
}: {
  backLabel?: string;
  session: Session;
  onBack: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const historyQuery = useInfiniteQuery({
    queryKey: ['reports', 'history', session.user.id, HISTORY_PAGE_SIZE],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : '';
      return request<LearningHistoryResponse>(
        `/reports/history?page=1&pageSize=${HISTORY_PAGE_SIZE}${cursor}`,
        {},
        session.accessToken,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: false,
  });
  const pages = historyQuery.data?.pages ?? [];
  const items = pages.flatMap((response) => response.items);
  const totals = pages[pages.length - 1]?.totals ?? emptyTotals;
  const hasMore = historyQuery.hasNextPage ?? false;
  const loadMessage =
    historyQuery.error instanceof Error ? historyQuery.error.message : '学习历史加载失败';
  const retryHistory = () => {
    if (historyQuery.isFetchNextPageError) void historyQuery.fetchNextPage();
    else void historyQuery.refetch();
  };

  if (historyQuery.isPending)
    return (
      <HistoryState
        title="正在读取学习记录…"
        icon={<BookOpen size={42} />}
        loading
        onBack={onBack}
        backLabel={backLabel}
      />
    );
  if (historyQuery.isError && !items.length)
    return (
      <HistoryState
        title="学习历史加载失败"
        message={loadMessage}
        icon={<TriangleAlert size={42} />}
        onBack={onBack}
        backLabel={backLabel}
        onRetry={retryHistory}
      />
    );
  if (!items.length)
    return (
      <HistoryState
        title="还没有完成的学习记录"
        message="完成单词学习、正式测评或旅行场景后，这里会按时间保留你的学习足迹。"
        icon={<BookOpen size={42} />}
        onBack={onBack}
        backLabel={backLabel}
      />
    );

  const overallAccuracy = totals.questions
    ? Math.round((totals.correctQuestions / totals.questions) * 100)
    : 0;
  return (
    <section className="learning-history-page" aria-labelledby="learning-history-title">
      <header className="learning-history-heading">
        <DashboardBackButton onClick={onBack}>{backLabel}</DashboardBackButton>
        <div>
          <p className="history-kicker">FINISHED NOTES</p>
          <h1 id="learning-history-title">学习历史</h1>
          <p>学习序列、正式测评和旅行场景，都按完成时间留在这里。</p>
        </div>
      </header>

      <div className="learning-history-overview" aria-label="历史学习汇总">
        <article>
          <span>
            <CheckCircle2 size={21} />
          </span>
          <p>全部学习记录</p>
          <strong>
            {totals.records}
            <small>条</small>
          </strong>
        </article>
        <article>
          <span>
            <BookOpen size={21} />
          </span>
          <p>累计完成</p>
          <strong>
            {totals.words}
            <small>词</small>
          </strong>
        </article>
        <article>
          <span>
            <ListChecks size={21} />
          </span>
          <p>单词答题正确率</p>
          <strong>
            {overallAccuracy}
            <small>%</small>
          </strong>
        </article>
      </div>

      <div className="history-domain-summary" aria-label="学习记录分类">
        <span>
          <BookOpen />
          学习序列 <b>{totals.plans}</b>
        </span>
        <span>
          <Languages />
          正式测评 <b>{totals.assessments}</b>
        </span>
        <span>
          <MapPin />
          旅行场景 <b>{totals.scenarios}</b>
        </span>
      </div>

      <section className="learning-history-list" aria-label="全部学习记录">
        {items.map((item) =>
          item.kind === 'PLAN' ? (
            <PlanHistoryCard
              key={`plan-${item.id}`}
              item={item}
              session={session}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
            />
          ) : item.kind === 'ASSESSMENT' ? (
            <AssessmentHistoryCard key={`assessment-${item.id}`} item={item} />
          ) : (
            <ScenarioHistoryCard key={`scenario-${item.id}`} item={item} />
          ),
        )}
      </section>
      {historyQuery.isError && (
        <p className="history-load-message" role="alert">
          {loadMessage}{' '}
          <button type="button" onClick={retryHistory}>
            重试
          </button>
        </p>
      )}
      {hasMore && (
        <button
          className="history-load-more"
          onClick={() => void historyQuery.fetchNextPage()}
          disabled={historyQuery.isFetchingNextPage}
        >
          {historyQuery.isFetchingNextPage ? '正在加载…' : '加载更多历史记录'}
        </button>
      )}
    </section>
  );
}

function PlanHistoryCard({
  expanded,
  item,
  session,
  onToggle,
}: {
  expanded: boolean;
  item: LearningHistoryPlanItem;
  session: Session;
  onToggle: () => void;
}) {
  const reviewOwnerRef = useRef(session.user.id);
  reviewOwnerRef.current = session.user.id;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewState, setReviewState] = useState<
    | { ownerId: string; status: 'idle' | 'loading' }
    | { ownerId: string; status: 'error'; message: string }
    | { ownerId: string; status: 'ready'; review: StudyPlanReview }
  >({ ownerId: session.user.id, status: 'idle' });
  const visibleReviewState =
    reviewState.ownerId === session.user.id
      ? reviewState
      : { ownerId: session.user.id, status: 'idle' as const };
  useEffect(() => {
    setReviewState({ ownerId: session.user.id, status: 'idle' });
    setReviewOpen(false);
  }, [session.user.id]);
  const loadReview = async () => {
    const ownerId = session.user.id;
    const current = reviewState.ownerId === ownerId ? reviewState : null;
    if (current?.status === 'loading' || current?.status === 'ready') return;
    setReviewState({ ownerId, status: 'loading' });
    try {
      const review = await request<StudyPlanReview>(
        `/study/plans/${encodeURIComponent(item.id)}/review`,
        {},
        session.accessToken,
      );
      if (reviewOwnerRef.current !== ownerId) return;
      if (review.id !== item.id || review.status !== 'COMPLETED') {
        throw new Error('这条学习记录暂时无法回看');
      }
      setReviewState({ ownerId, status: 'ready', review });
    } catch (error) {
      if (reviewOwnerRef.current !== ownerId) return;
      setReviewState({
        ownerId,
        status: 'error',
        message: error instanceof Error ? error.message : '题目回顾加载失败',
      });
    }
  };
  const toggleReview = () => {
    if (visibleReviewState.status === 'ready') {
      setReviewOpen((open) => !open);
      return;
    }
    setReviewOpen(true);
    void loadReview();
  };
  const accuracy = item.totalQuestions
    ? Math.round((item.correctQuestions / item.totalQuestions) * 100)
    : 0;
  const accuracyLevel = getAccuracyLevel(accuracy);
  return (
    <article className="learning-history-card is-plan">
      <HistoryDate value={item.occurredAt} />
      <div className="history-card-main">
        <div className="history-card-title">
          <span>{modeLabel[item.mode]}</span>
          <strong>{item.wordCount} 个单词的学习序列</strong>
        </div>
        <div className={`history-score ${accuracyLevel.className}`}>
          <div>
            <b>{accuracy}%</b>
            <span>正确率 · {accuracyLevel.label}</span>
          </div>
          <i>
            <em style={{ width: `${accuracy}%` }} />
          </i>
          <p>
            {item.correctQuestions} / {item.totalQuestions} 题答对
          </p>
        </div>
      </div>
      <div className="history-card-meta">
        <span>
          <Clock3 size={16} />
          {formatDuration(item.durationSeconds)}
        </span>
        <span>
          <CheckCircle2 size={16} />
          {item.wordCount} 词完成
        </span>
        {item.weakWords.length > 0 && (
          <span className="is-warning">
            <TriangleAlert size={16} />
            {item.weakWords.length} 词待巩固
          </span>
        )}
      </div>
      <button
        className="history-details-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`history-details-${item.id}`}
      >
        {expanded ? '收起详情' : '查看详情'}
      </button>
      {expanded && (
        <div className="history-details" id={`history-details-${item.id}`}>
          <section>
            <h2>题型表现</h2>
            <div className="history-type-list">
              {item.typeStats.length ? (
                item.typeStats.map((type) => {
                  const rate = type.total ? Math.round((type.correct / type.total) * 100) : 0;
                  return (
                    <div key={type.type}>
                      <span>{exerciseLabel[type.type] ?? '练习题'}</span>
                      <b>
                        {type.correct}/{type.total} · {rate}%
                      </b>
                    </div>
                  );
                })
              ) : (
                <p>本次没有可用的答题统计。</p>
              )}
            </div>
          </section>
          <section>
            <h2>需要巩固</h2>
            {item.weakWords.length ? (
              <div className="history-weak-words">
                {item.weakWords.map((word) => (
                  <span key={word}>{word}</span>
                ))}
              </div>
            ) : (
              <p className="history-all-correct">
                <CheckCircle2 size={17} />
                这次练习全部答对，真棒。
              </p>
            )}
          </section>
          <section className="history-question-review">
            <h2>逐题回顾</h2>
            <p>只读取这份已完成练习中保存的作答，不会新增练习记录。</p>
            <button
              type="button"
              className="history-review-button"
              aria-expanded={reviewOpen}
              aria-controls={`history-review-content-${item.id}`}
              onClick={toggleReview}
              disabled={visibleReviewState.status === 'loading'}
            >
              {visibleReviewState.status === 'loading'
                ? '正在加载本次作答…'
                : visibleReviewState.status === 'error'
                  ? '重试加载作答'
                  : visibleReviewState.status === 'ready' && reviewOpen
                    ? '收起逐题回顾'
                    : visibleReviewState.status === 'ready'
                      ? '展开逐题回顾'
                      : '查看我的答案与解析'}
            </button>
            <div className="history-review-content" id={`history-review-content-${item.id}`}>
              {visibleReviewState.status === 'error' && (
                <p role="alert" className="history-review-error">
                  {visibleReviewState.message}
                </p>
              )}
              {reviewOpen && visibleReviewState.status === 'ready' && (
                <div className="history-review-list">
                  {visibleReviewState.review.words.map((word) => {
                    const correctAnswers =
                      word.question.type === 'WORD_MATCHING' && word.question.pairs?.length
                        ? word.question.pairs.map(({ left, right }) => `${left} → ${right}`)
                        : (word.question.correctAnswers ?? []);
                    return (
                      <article
                        key={word.id}
                        className={`history-review-question ${word.result === false ? 'is-wrong' : word.result === true ? 'is-correct' : ''}`}
                      >
                        <header>
                          <strong>{word.word}</strong>
                          <span>
                            {word.result === true
                              ? '答对'
                              : word.result === false
                                ? '答错'
                                : '没有正误记录'}
                          </span>
                        </header>
                        {word.question.prompt && (
                          <p className="history-review-prompt">{word.question.prompt}</p>
                        )}
                        <div className="history-review-answers">
                          <div>
                            <b>你的答案</b>
                            {word.selectedAnswer?.length ? (
                              <ul>
                                {word.selectedAnswer.map((answer, index) => (
                                  <li key={`${index}:${answer}`}>
                                    {answer.replaceAll('=>', ' → ')}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p>这条历史记录没有保存具体选项。</p>
                            )}
                          </div>
                          <div>
                            <b>正确答案</b>
                            {correctAnswers.length ? (
                              <ul>
                                {correctAnswers.map((answer, index) => (
                                  <li key={`${index}:${answer}`}>{answer}</li>
                                ))}
                              </ul>
                            ) : (
                              <p>本题没有可回看的标准答案。</p>
                            )}
                          </div>
                        </div>
                        {word.question.explanation && (
                          <p className="history-review-explanation">{word.question.explanation}</p>
                        )}
                        {word.savedContext && (
                          <aside className="saved-review-context history-saved-review-context">
                            <strong>收藏时的原句</strong>
                            {word.savedContext.scenario && (
                              <small>{word.savedContext.scenario}</small>
                            )}
                            <p lang="en">{word.savedContext.example}</p>
                          </aside>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </article>
  );
}

function AssessmentHistoryCard({ item }: { item: LearningHistoryAssessmentItem }) {
  return (
    <article className="learning-history-card history-event-card is-assessment">
      <HistoryDate value={item.occurredAt} />
      <div className="history-card-main">
        <div className="history-card-title">
          <span>正式测评</span>
          <strong>CEFR 英语水平评定</strong>
        </div>
        <div className="history-event-result">
          <Languages />
          <strong>{item.level}</strong>
          <span>
            {item.provisional ? '测评已完成 · 结果暂定' : confidenceLabel(item.confidence)}
          </span>
        </div>
      </div>
      <div className="history-card-meta">
        <span>
          <ListChecks size={16} />
          {item.questionCount} 道测评题
        </span>
        <span>
          <Award size={16} />
          {confidenceLabel(item.confidence)}
        </span>
      </div>
    </article>
  );
}

function ScenarioHistoryCard({ item }: { item: LearningHistoryScenarioItem }) {
  return (
    <article className="learning-history-card history-event-card is-scenario">
      <HistoryDate value={item.occurredAt} />
      <div className="history-card-main">
        <div className="history-card-title">
          <span>{categoryLabel[item.category] ?? item.category}场景</span>
          <strong>{item.title}</strong>
        </div>
        <div className="history-event-result">
          <MapPin />
          <strong>{outcomeLabel(item.outcome)}</strong>
          <span>{item.level} 难度 · 场景任务</span>
        </div>
      </div>
      <div className="history-card-meta">
        <span>
          <CheckCircle2 size={16} />
          {outcomeDescription(item.outcome)}
        </span>
        <span>
          <Languages size={16} />
          CEFR {item.level}
        </span>
      </div>
    </article>
  );
}

function HistoryDate({ value }: { value: string }) {
  return (
    <div className="history-date">
      <b>{formatDate(value)}</b>
      <span>{formatTime(value)} 完成</span>
    </div>
  );
}
function HistoryState({
  backLabel,
  icon,
  loading = false,
  message,
  onBack,
  onRetry,
  title,
}: {
  backLabel?: string;
  icon: React.ReactNode;
  loading?: boolean;
  message?: string;
  onBack?: () => void;
  onRetry?: () => void;
  title: string;
}) {
  return (
    <section
      className={`learning-history-page learning-history-empty${loading ? ' is-loading' : ''}`}
      aria-labelledby="learning-history-title"
      aria-busy={loading}
    >
      {onBack && (
        <DashboardBackButton onClick={onBack}>{backLabel ?? '返回学习进度'}</DashboardBackButton>
      )}
      <p className="history-kicker">FINISHED NOTES</p>
      <h1 id="learning-history-title">学习历史</h1>
      <div
        className={`learning-history-empty-card${loading ? ' history-loading-card' : ''}`}
        role={loading ? 'status' : onRetry ? 'alert' : undefined}
      >
        {loading ? (
          <>
            {icon}
            <span className="history-loading-lines" aria-hidden="true">
              <i />
              <i />
            </span>
            <span className="history-loading-caption">{title}</span>
          </>
        ) : (
          <>
            {icon}
            <strong>{title}</strong>
            {message && <p>{message}</p>}
            {onRetry && (
              <button type="button" onClick={onRetry}>
                重试
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(value));
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
function formatDuration(seconds: number) {
  if (seconds < 60) return seconds ? `${seconds} 秒作答` : '未记录用时';
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain ? `${minutes} 分 ${remain} 秒` : `${minutes} 分钟`;
}
function confidenceLabel(value: LearningHistoryAssessmentItem['confidence']) {
  return value === 'HIGH' ? '高可信度' : value === 'MEDIUM' ? '中等可信度' : '证据积累中';
}
function outcomeLabel(value: LearningHistoryScenarioItem['outcome']) {
  return value === 'SUCCESS' ? '完成' : value === 'PARTIAL' ? '部分完成' : '待重试';
}
function outcomeDescription(value: LearningHistoryScenarioItem['outcome']) {
  return value === 'SUCCESS'
    ? '任务目标全部完成'
    : value === 'PARTIAL'
      ? '完成部分任务目标'
      : '任务目标尚未完成';
}
function getAccuracyLevel(accuracy: number) {
  if (accuracy < 40) return { className: 'is-red', label: '待加强' };
  if (accuracy < 60) return { className: 'is-orange', label: '需巩固' };
  if (accuracy < 75) return { className: 'is-yellow', label: '已入门' };
  if (accuracy < 90) return { className: 'is-blue', label: '掌握良好' };
  return { className: 'is-green', label: '表现优秀' };
}
