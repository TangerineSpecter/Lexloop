'use client';

import { ArrowLeft, BookOpen, CheckCircle2, Clock3, ListChecks, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { request, type Session } from '../lib/api';
import type { LearningPlan } from './dashboard';

const modeLabel: Record<LearningPlan['mode'], string> = {
  group: '分组学习',
  individual: '单词逐个学',
  exam: '真题模式',
};

const exerciseLabel: Record<string, string> = {
  WORD_MNEMONIC: '词根联想',
  MEANING_RECOGNITION: '词义识别',
  WORD_MATCHING: '词义配对',
  SYNONYM_REPLACEMENT: '同义替换',
  READING_COMPREHENSION: '阅读理解',
};

type CompletedHistoryResponse = { items: LearningPlan[]; hasMore: boolean };

export function LearningHistoryPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMessage, setLoadMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadMessage('');
    request<CompletedHistoryResponse>('/study/plans/history?page=1&pageSize=20', {}, session.accessToken)
      .then((response) => {
        if (cancelled) return;
        setPlans(response.items);
        setHasMore(response.hasMore);
        setPage(1);
      })
      .catch((error) => {
        if (!cancelled) setLoadMessage(error instanceof Error ? error.message : '学习历史加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [session.accessToken]);

  const loadMore = async () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const response = await request<CompletedHistoryResponse>(`/study/plans/history?page=${nextPage}&pageSize=20`, {}, session.accessToken);
      setPlans((current) => [...current, ...response.items]);
      setHasMore(response.hasMore);
      setPage(nextPage);
    } catch (error) {
      setLoadMessage(error instanceof Error ? error.message : '学习历史加载失败');
    } finally {
      setLoadingMore(false);
    }
  };

  const completedPlans = useMemo(
    () => plans.filter((plan) => plan.status === 'COMPLETED').sort((a, b) =>
      new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime(),
    ),
    [plans],
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return <section className="learning-history-page learning-history-empty" aria-labelledby="learning-history-title">
      <p className="history-kicker">FINISHED NOTES</p>
      <h1 id="learning-history-title">学习历史</h1>
      <div className="learning-history-empty-card"><BookOpen size={42} aria-hidden="true" /><strong>正在读取学习记录…</strong></div>
    </section>;
  }

  if (loadMessage && !completedPlans.length) {
    return <section className="learning-history-page learning-history-empty" aria-labelledby="learning-history-title">
      <p className="history-kicker">FINISHED NOTES</p>
      <h1 id="learning-history-title">学习历史</h1>
      <div className="learning-history-empty-card"><TriangleAlert size={42} aria-hidden="true" /><strong>学习历史加载失败</strong><p>{loadMessage}</p></div>
    </section>;
  }

  if (!completedPlans.length) {
    return <section className="learning-history-page learning-history-empty" aria-labelledby="learning-history-title">
      <p className="history-kicker">FINISHED NOTES</p>
      <h1 id="learning-history-title">学习历史</h1>
      <div className="learning-history-empty-card">
        <BookOpen size={42} aria-hidden="true" />
        <strong>还没有完成的学习记录</strong>
        <p>完成一次学习序列后，这里会保留当时的正确率、练习用时和需要巩固的单词。</p>
        <button onClick={onBack}><ArrowLeft size={17} />返回学习进度</button>
      </div>
    </section>;
  }

  const totalWords = completedPlans.reduce((sum, plan) => sum + plan.wordCount, 0);
  const totalQuestions = completedPlans.reduce((sum, plan) => sum + (plan.summary?.totalQuestions ?? 0), 0);
  const correctQuestions = completedPlans.reduce((sum, plan) => sum + (plan.summary?.correctQuestions ?? 0), 0);
  const overallAccuracy = totalQuestions ? Math.round((correctQuestions / totalQuestions) * 100) : 0;

  return <section className="learning-history-page" aria-labelledby="learning-history-title">
    <header className="learning-history-heading">
      <div>
        <p className="history-kicker">FINISHED NOTES</p>
        <h1 id="learning-history-title">学习历史</h1>
        <p>每次完成的学习，都留下一页可回看的学习笔记。</p>
      </div>
      <button className="history-back" onClick={onBack}><ArrowLeft size={17} />返回学习进度</button>
    </header>

    <div className="learning-history-overview" aria-label="历史学习汇总">
      <article><span><CheckCircle2 size={21} /></span><p>完成学习</p><strong>{completedPlans.length}<small>次</small></strong></article>
      <article><span><BookOpen size={21} /></span><p>累计完成</p><strong>{totalWords}<small>词</small></strong></article>
      <article><span><ListChecks size={21} /></span><p>历史正确率</p><strong>{overallAccuracy}<small>%</small></strong></article>
    </div>

    <section className="learning-history-list" aria-label="已完成学习记录">
      {completedPlans.map((plan) => {
        const summary = plan.summary;
        const accuracy = summary?.totalQuestions ? Math.round((summary.correctQuestions / summary.totalQuestions) * 100) : 0;
        const accuracyLevel = getAccuracyLevel(accuracy);
        const weakWords = plan.words.filter((word) => word.result === false);
        const isExpanded = expandedId === plan.id;
        return <article className="learning-history-card" key={plan.id}>
          <div className="history-date"><b>{formatDate(plan.completedAt ?? plan.createdAt)}</b><span>{formatTime(plan.completedAt ?? plan.createdAt)} 完成</span></div>
          <div className="history-card-main">
            <div className="history-card-title"><span>{modeLabel[plan.mode]}</span><strong>{plan.wordCount} 个单词的学习序列</strong></div>
            <div className={`history-score ${accuracyLevel.className}`}><div><b>{accuracy}%</b><span>正确率 · {accuracyLevel.label}</span></div><i><em style={{ width: `${accuracy}%` }} /></i><p>{summary?.correctQuestions ?? 0} / {summary?.totalQuestions ?? 0} 题答对</p></div>
          </div>
          <div className="history-card-meta"><span><Clock3 size={16} />{formatDuration(summary?.durationSeconds ?? 0)}</span><span><CheckCircle2 size={16} />{plan.wordCount} 词完成</span>{weakWords.length > 0 && <span className="is-warning"><TriangleAlert size={16} />{weakWords.length} 词待巩固</span>}</div>
          <button className="history-details-toggle" onClick={() => setExpandedId(isExpanded ? null : plan.id)} aria-expanded={isExpanded} aria-controls={`history-details-${plan.id}`}>{isExpanded ? '收起详情' : '查看详情'}</button>
          {isExpanded && <div className="history-details" id={`history-details-${plan.id}`}>
            <section><h2>题型表现</h2><div className="history-type-list">{summary?.typeStats.map((item) => { const rate = item.total ? Math.round((item.correct / item.total) * 100) : 0; return <div key={item.type}><span>{exerciseLabel[item.type] ?? '练习题'}</span><b>{item.correct}/{item.total} · {rate}%</b></div>; }) ?? <p>本次没有可用的答题统计。</p>}</div></section>
            <section><h2>需要巩固</h2>{weakWords.length ? <div className="history-weak-words">{weakWords.map((word) => <span key={word.id ?? word.word}>{word.word}</span>)}</div> : <p className="history-all-correct"><CheckCircle2 size={17} />这次练习全部答对，真棒。</p>}</section>
          </div>}
        </article>;
      })}
    </section>
    {loadMessage && <p className="history-load-message" role="status">{loadMessage}</p>}
    {hasMore && <button className="history-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? '正在加载…' : '加载更多历史记录'}</button>}
  </section>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function formatDuration(seconds: number) {
  if (seconds < 60) return seconds ? `${seconds} 秒作答` : '未记录用时';
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain ? `${minutes} 分 ${remain} 秒` : `${minutes} 分钟`;
}

function getAccuracyLevel(accuracy: number) {
  if (accuracy < 40) return { className: 'is-red', label: '待加强' };
  if (accuracy < 60) return { className: 'is-orange', label: '需巩固' };
  if (accuracy < 75) return { className: 'is-yellow', label: '已入门' };
  if (accuracy < 90) return { className: 'is-blue', label: '掌握良好' };
  return { className: 'is-green', label: '表现优秀' };
}
