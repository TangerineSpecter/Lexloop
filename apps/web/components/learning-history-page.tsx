'use client';

import type {
  LearningHistoryAssessmentItem,
  LearningHistoryItem,
  LearningHistoryPlanItem,
  LearningHistoryResponse,
  LearningHistoryScenarioItem,
} from '@lexloop/types';
import {
  ArrowLeft,
  Award,
  BookOpen,
  CheckCircle2,
  Clock3,
  Languages,
  ListChecks,
  MapPin,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { request, type Session } from '../lib/api';

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

export function LearningHistoryPage({
  backLabel = '返回学习进度',
  session,
  onBack,
}: {
  backLabel?: string;
  session: Session;
  onBack: () => void;
}) {
  const [items, setItems] = useState<LearningHistoryItem[]>([]);
  const [totals, setTotals] = useState(emptyTotals);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMessage, setLoadMessage] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadMessage('');
    request<LearningHistoryResponse>('/reports/history?page=1&pageSize=20', {}, session.accessToken)
      .then((response) => {
        if (cancelled) return;
        setItems(response.items);
        setTotals(response.totals);
        setHasMore(response.hasMore);
        setPage(1);
      })
      .catch((error) => {
        if (!cancelled) setLoadMessage(error instanceof Error ? error.message : '学习历史加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  const loadMore = async () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const response = await request<LearningHistoryResponse>(
        `/reports/history?page=${nextPage}&pageSize=20`,
        {},
        session.accessToken,
      );
      setItems((current) => [...current, ...response.items]);
      setTotals(response.totals);
      setHasMore(response.hasMore);
      setPage(nextPage);
    } catch (error) {
      setLoadMessage(error instanceof Error ? error.message : '学习历史加载失败');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <HistoryState title="正在读取学习记录…" icon={<BookOpen size={42} />} />;
  if (loadMessage && !items.length)
    return (
      <HistoryState
        title="学习历史加载失败"
        message={loadMessage}
        icon={<TriangleAlert size={42} />}
        onBack={onBack}
        backLabel={backLabel}
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
        <div>
          <p className="history-kicker">FINISHED NOTES</p>
          <h1 id="learning-history-title">学习历史</h1>
          <p>学习序列、正式测评和旅行场景，都按完成时间留在这里。</p>
        </div>
        <button className="history-back" onClick={onBack}>
          <ArrowLeft size={17} />
          {backLabel}
        </button>
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
      {loadMessage && (
        <p className="history-load-message" role="status">
          {loadMessage}
        </p>
      )}
      {hasMore && (
        <button
          className="history-load-more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? '正在加载…' : '加载更多历史记录'}
        </button>
      )}
    </section>
  );
}

function PlanHistoryCard({
  expanded,
  item,
  onToggle,
}: {
  expanded: boolean;
  item: LearningHistoryPlanItem;
  onToggle: () => void;
}) {
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
  message,
  onBack,
  title,
}: {
  backLabel?: string;
  icon: React.ReactNode;
  message?: string;
  onBack?: () => void;
  title: string;
}) {
  return (
    <section
      className="learning-history-page learning-history-empty"
      aria-labelledby="learning-history-title"
    >
      <p className="history-kicker">FINISHED NOTES</p>
      <h1 id="learning-history-title">学习历史</h1>
      <div className="learning-history-empty-card">
        {icon}
        <strong>{title}</strong>
        {message && <p>{message}</p>}
        {onBack && (
          <button onClick={onBack}>
            <ArrowLeft size={17} />
            {backLabel}
          </button>
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
