'use client';

import { BookOpen, CheckCircle2, Flame, ListChecks, RotateCcw, Trophy } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { request, type Session } from '../lib/api';

type StatisticsRange = '7d' | '30d';

type RankingRow = { word: string; count?: number; rate?: number };

type StatisticsSnapshot = {
  activeDays: number;
  activity: Array<{ label: string; words: number; today?: boolean }>;
  chart: Array<{ label: string; words: number; completed: boolean; today?: boolean }>;
  currentStreak: number;
  learnedWords: number;
  masteredWords: number;
  newWords: number;
  summary: string;
  suggestion: string;
  versusPrevious: number;
  reviewWords: number;
  rankings: {
    accuracy: RankingRow[];
    errorRate: RankingRow[];
    unfamiliar: RankingRow[];
    reviews: RankingRow[];
  };
};

export function StatisticsPage({ onBack, session }: { onBack: () => void; session: Session }) {
  const [range, setRange] = useState<StatisticsRange>('7d');
  const [statistics, setStatistics] = useState<StatisticsSnapshot | null>(null);
  const [loadMessage, setLoadMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    setStatistics(null);
    setLoadMessage('');
    request<StatisticsSnapshot>(`/reports/statistics?range=${range}`, {}, session.accessToken)
      .then((snapshot) => {
        if (!cancelled) setStatistics(snapshot);
      })
      .catch((error) => {
        if (!cancelled) setLoadMessage(error instanceof Error ? error.message : '学习统计加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [range, session.accessToken]);
  if (!statistics) {
    return <section className="statistics-page statistics-empty" aria-labelledby="statistics-title">
      <p className="statistics-kicker">LEARNING NOTES</p>
      <h1 id="statistics-title">学习统计</h1>
      <div className="statistics-empty-card">
        <BookOpen size={42} aria-hidden="true"/>
        <strong>{loadMessage ? '学习统计加载失败' : '正在加载学习统计…'}</strong>
        <p>{loadMessage || '正在读取你的真实学习记录。'}</p>
        {loadMessage && <button onClick={onBack}>返回学习进度</button>}
      </div>
    </section>;
  }
  const chartTotalWords = statistics.chart.reduce((total, day) => total + day.words, 0);
  const maxWords = Math.max(...statistics.chart.map((day) => day.words), 1);
  const averageWords = Math.round(chartTotalWords / statistics.chart.length);
  const averageOffset = `${Math.max(4, Math.min(96, (1 - averageWords / maxWords) * 100))}%`;
  const rangeName = range === '7d' ? '近 7 天' : '近 30 天';
  const calendarDays = statistics.activity;
  const completedCalendarDays = calendarDays.filter((day) => day.words > 0).length;
  const mostStudiedPeriod = statistics.chart.reduce((highest, day) =>
    day.words > highest.words ? day : highest,
  ).label;

  if (chartTotalWords === 0) {
    return <section className="statistics-page statistics-empty" aria-labelledby="statistics-title">
      <p className="statistics-kicker">LEARNING NOTES</p>
      <h1 id="statistics-title">学习统计</h1>
      <div className="statistics-empty-card"><BookOpen size={42} aria-hidden="true"/><strong>本周还没有学习记录</strong><p>从今天的一个单词开始，学习足迹会慢慢在这里展开。</p><button onClick={onBack}>返回词环开始学习</button></div>
    </section>;
  }

  return <section className="statistics-page" aria-labelledby="statistics-title">
    {loadMessage && <p className="book-message">{loadMessage}</p>}
    <header className="statistics-heading">
      <div>
        <p className="statistics-kicker">LEARNING NOTES</p>
        <h1 id="statistics-title">学习统计</h1>
        <p>看看你的坚持，正一点点变成积累。</p>
      </div>
      <div className="statistics-range" role="group" aria-label="统计时间范围">
        <button className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')} aria-pressed={range === '7d'}>近 7 天</button>
        <button className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')} aria-pressed={range === '30d'}>近 30 天</button>
      </div>
    </header>

    <div className="statistics-metrics" aria-label={`${rangeName}学习摘要`}>
      <article className="statistics-metric metric-streak"><span className="statistics-metric-icon"><Flame size={23} aria-hidden="true"/></span><p>连续学习</p><strong>{statistics.currentStreak}<small>天</small></strong><em>本期活跃 {statistics.activeDays} 天</em></article>
      <article className="statistics-metric metric-activity"><span className="statistics-metric-icon"><ListChecks size={23} aria-hidden="true"/></span><p>{rangeName}完成</p><strong>{chartTotalWords}<small>词</small></strong><em>比上期多 {statistics.versusPrevious}%</em></article>
      <article className="statistics-metric metric-words"><span className="statistics-metric-icon"><BookOpen size={23} aria-hidden="true"/></span><p>词汇积累</p><strong>{statistics.learnedWords}<small>词</small></strong><em>本期新学 {statistics.newWords} 词 · 掌握 {statistics.masteredWords} 词</em></article>
    </div>

    <section className="statistics-rhythm" aria-labelledby="rhythm-title">
      <div className="statistics-section-head"><div><p>STUDY RHYTHM</p><h2 id="rhythm-title">{rangeName}学习节奏</h2></div><span>{statistics.activeDays} 天有学习记录</span></div>
      <section className="statistics-completion" aria-labelledby="completion-title"><div><h3 id="completion-title">学习打卡</h3><p>每格对应一天：有颜色表示完成学习，颜色越深表示完成的单词越多；橙色描边是今天。</p></div><div className={`statistics-completion-body range-${range}`}><div className="statistics-completion-meta"><b>{completedCalendarDays} / {calendarDays.length} 天已学习</b><span>{rangeName}</span></div><div className="statistics-weekdays" aria-hidden="true">{['一','二','三','四','五','六','日'].map((day) => <span key={day}>周{day}</span>)}</div><div className={`statistics-contribution-grid range-${range}`} aria-label={`${rangeName}学习打卡：${completedCalendarDays} 天已学习`}>{calendarDays.map((day) => <span key={day.label} className={`level-${Math.min(4, Math.ceil(day.words / 5))} ${day.today ? 'is-today' : ''}`} tabIndex={0} data-tooltip={day.words ? `完成 ${day.words} 个单词` : '未学习'} title={`${day.label}：${day.words ? `完成 ${day.words} 个单词` : '未学习'}`} aria-label={`${day.label}：${day.words ? `完成 ${day.words} 个单词` : '未学习'}`}><b>{day.today ? '今' : day.label.match(/\d+(?= 日)/)?.[0]}</b></span>)}</div><div className="statistics-contribution-legend" aria-hidden="true"><span>少</span><i className="level-0"/><i className="level-1"/><i className="level-2"/><i className="level-3"/><i className="level-4"/><span>多</span></div></div></section>
      <div className="statistics-rhythm-grid">
        <figure className="statistics-chart" role="img" aria-label={`${rangeName}共完成 ${chartTotalWords} 个单词，其中 ${statistics.activeDays} 天有学习记录`}>
          <div className="statistics-chart-scale"><span>{maxWords} 词</span><span>{Math.round(maxWords / 2)} 词</span><span>0</span></div>
          <div className="statistics-bars">
            <div className="statistics-average-line" style={{ '--average-offset': averageOffset } as CSSProperties}><span>平均 {averageWords} 词</span></div>
            {statistics.chart.map((day) => <div className={`statistics-bar-item ${day.today ? 'is-today' : ''} ${day.completed ? 'is-complete' : ''}`} key={day.label} tabIndex={0} data-tooltip={`${day.label}：${day.words} 个单词`} aria-label={`${day.label}完成 ${day.words} 个单词`}>
              <div className="statistics-bar-track"><i style={{ '--bar-height': `${Math.round((day.words / maxWords) * 100)}%` } as CSSProperties} aria-hidden="true"/></div>
              <span>{day.label}</span>
            </div>)}
          </div>
          <figcaption><span className="statistics-chart-key is-complete"/>已学习 <span className="statistics-chart-key is-today"/>今天（进行中） · {range === '30d' ? '每柱为 3 天累计单词数' : '每柱为当天完成单词数'} · 悬停柱子查看单词数</figcaption>
        </figure>
        <aside className="statistics-rhythm-note"><Trophy size={30} aria-hidden="true"/><strong>本期完成了 {chartTotalWords} 个单词</strong><p>{statistics.summary}</p><div><span>最多完成</span><b>{mostStudiedPeriod}</b></div></aside>
      </div>
    </section>

    <div className="statistics-bottom-grid">
      <section className="statistics-footprint" aria-labelledby="footprint-title"><div className="statistics-section-head"><div><p>WORD FOOTPRINT</p><h2 id="footprint-title">本期词汇足迹</h2></div></div><div className="statistics-footprint-list"><StatFootprint icon={<BookOpen size={21}/>} label="新学单词" value={statistics.newWords} className="is-new"/><StatFootprint icon={<RotateCcw size={21}/>} label="完成复习" value={statistics.reviewWords} className="is-review"/><StatFootprint icon={<CheckCircle2 size={21}/>} label="标记掌握" value={statistics.masteredWords} className="is-mastered"/></div></section>
      <section className="statistics-summary" aria-labelledby="summary-title"><p>WEEKLY NOTE</p><h2 id="summary-title">本期小结</h2><strong>{statistics.summary}</strong><div><span>下一步</span><p>{statistics.suggestion}</p></div></section>
    </div>
    <section className="statistics-rankings" aria-labelledby="rankings-title"><div className="statistics-section-head"><div><p>WORD SIGNALS</p><h2 id="rankings-title">单词信号</h2></div><span>实时学习数据</span></div><div className="statistics-ranking-grid"><WordRanking title="复习次数排行榜" hint="出现越多，说明它更常需要回来复习" rows={statistics.rankings.reviews} type="review"/><WordRanking title="陌生程度 · 低 → 高" hint="综合正确率、逾期、延期和连续答对计算" rows={statistics.rankings.unfamiliar} type="unfamiliar"/><WordRanking title="单词错误率 TOP 10" hint="错误率越高，越值得优先复习" rows={statistics.rankings.errorRate} type="error-rate"/><WordRanking title="单词正确率 TOP 10" hint="正确率越高，说明掌握得越稳定" rows={statistics.rankings.accuracy} type="accuracy"/></div></section>
  </section>;
}

function StatFootprint({ className, icon, label, value }: { className: string; icon: React.ReactNode; label: string; value: number }) {
  return <div className={`statistics-footprint-item ${className}`}><span aria-hidden="true">{icon}</span><p>{label}</p><strong>{value}<small>词</small></strong></div>;
}

function WordRanking({ hint, rows, title, type }: { hint: string; rows: RankingRow[]; title: string; type: 'review' | 'unfamiliar' | 'error-rate' | 'accuracy' }) {
  const maxValue = type === 'review' ? Math.max(...rows.map((row) => row.count ?? 0), 1) : 100;
  return <section className={`statistics-ranking-card is-${type}`}><h3>{title}</h3><p>{hint}</p><ol>{rows.map((row, index) => { const value = row.count ?? row.rate ?? 0; const isPercentage = type !== 'review'; return <li key={row.word}><b>{index + 1}</b><strong>{row.word}</strong><i><span style={{ width: `${Math.max(8, (value / maxValue) * 100)}%` }}/></i><em>{isPercentage ? `${value.toFixed(1)}%` : `${value}次`}</em></li>; })}</ol></section>;
}
