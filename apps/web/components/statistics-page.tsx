'use client';

import { BookOpen, CheckCircle2, Clock3, Flame, RotateCcw, Trophy } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

type StatisticsRange = '7d' | '30d';

type StatisticsSnapshot = {
  activeDays: number;
  activity: Array<{ label: string; minutes: number; today?: boolean }>;
  chart: Array<{ label: string; minutes: number; completed: boolean; today?: boolean }>;
  currentStreak: number;
  learnedWords: number;
  masteredWords: number;
  newWords: number;
  summary: string;
  suggestion: string;
  totalMinutes: number;
  totalWords: number;
  versusPrevious: number;
  reviewWords: number;
  rankings: {
    unfamiliar: Array<{ word: string; score: number }>;
    reviews: Array<{ word: string; count: number }>;
  };
};

const statisticsByRange: Record<StatisticsRange, StatisticsSnapshot> = {
  '7d': {
    activeDays: 6,
    activity: [
      { label: '7 月 17 日', minutes: 18 }, { label: '7 月 18 日', minutes: 24 }, { label: '7 月 19 日', minutes: 0 }, { label: '7 月 20 日', minutes: 31 }, { label: '7 月 21 日', minutes: 15 }, { label: '7 月 22 日', minutes: 32 }, { label: '7 月 23 日', minutes: 18, today: true },
    ],
    chart: [
      { label: '周五', minutes: 18, completed: true },
      { label: '周六', minutes: 24, completed: true },
      { label: '周日', minutes: 0, completed: false },
      { label: '周一', minutes: 31, completed: true },
      { label: '周二', minutes: 15, completed: true },
      { label: '周三', minutes: 32, completed: true },
      { label: '今天', minutes: 18, completed: true, today: true },
    ],
    currentStreak: 4,
    learnedWords: 28,
    masteredWords: 4,
    newWords: 16,
    reviewWords: 38,
    rankings: {
      reviews: [{ word: 'business', count: 8 }, { word: 'policy', count: 6 }, { word: 'market', count: 5 }, { word: 'public', count: 4 }, { word: 'service', count: 3 }],
      unfamiliar: [{ word: 'help', score: 22 }, { word: 'market', score: 41 }, { word: 'policy', score: 58 }, { word: 'result', score: 76 }, { word: 'business', score: 91 }],
    },
    suggestion: '再学习 1 天，就能完成一周 7 天的学习节奏。',
    summary: '这周保持得很不错，周一和周三是你的高效学习日。',
    totalMinutes: 138,
    totalWords: 4545,
    versusPrevious: 22,
  },
  '30d': {
    activeDays: 20,
    activity: [
      { label: '6 月 24 日', minutes: 0 }, { label: '6 月 25 日', minutes: 0 }, { label: '6 月 26 日', minutes: 0 }, { label: '6 月 27 日', minutes: 14 }, { label: '6 月 28 日', minutes: 0 }, { label: '6 月 29 日', minutes: 24 },
      { label: '6 月 30 日', minutes: 16 }, { label: '7 月 1 日', minutes: 0 }, { label: '7 月 2 日', minutes: 28 }, { label: '7 月 3 日', minutes: 12 }, { label: '7 月 4 日', minutes: 19 }, { label: '7 月 5 日', minutes: 0 },
      { label: '7 月 6 日', minutes: 34 }, { label: '7 月 7 日', minutes: 15 }, { label: '7 月 8 日', minutes: 0 }, { label: '7 月 9 日', minutes: 21 }, { label: '7 月 10 日', minutes: 11 }, { label: '7 月 11 日', minutes: 25 },
      { label: '7 月 12 日', minutes: 0 }, { label: '7 月 13 日', minutes: 18 }, { label: '7 月 14 日', minutes: 29 }, { label: '7 月 15 日', minutes: 0 }, { label: '7 月 16 日', minutes: 36 }, { label: '7 月 17 日', minutes: 17 },
      { label: '7 月 18 日', minutes: 14 }, { label: '7 月 19 日', minutes: 23 }, { label: '7 月 20 日', minutes: 0 }, { label: '7 月 21 日', minutes: 19 }, { label: '7 月 22 日', minutes: 31 }, { label: '7 月 23 日', minutes: 18, today: true },
    ],
    chart: [
      { label: '24–26', minutes: 0, completed: false },
      { label: '27–29', minutes: 38, completed: true },
      { label: '30–2', minutes: 44, completed: true },
      { label: '3–5', minutes: 31, completed: true },
      { label: '6–8', minutes: 49, completed: true },
      { label: '9–11', minutes: 57, completed: true },
      { label: '12–14', minutes: 47, completed: true },
      { label: '15–17', minutes: 53, completed: true },
      { label: '18–20', minutes: 37, completed: true },
      { label: '21–今', minutes: 68, completed: true, today: true },
    ],
    currentStreak: 4,
    learnedWords: 96,
    masteredWords: 18,
    newWords: 54,
    reviewWords: 142,
    rankings: {
      reviews: [{ word: 'business', count: 19 }, { word: 'market', count: 16 }, { word: 'policy', count: 14 }, { word: 'service', count: 12 }, { word: 'result', count: 11 }],
      unfamiliar: [{ word: 'help', score: 18 }, { word: 'market', score: 36 }, { word: 'policy', score: 54 }, { word: 'result', score: 73 }, { word: 'business', score: 88 }],
    },
    suggestion: '保持现在的节奏，本月还可以再完成 6 次轻量复习。',
    summary: '近 30 天里，你已经有 20 天打开了词环。',
    totalMinutes: 424,
    totalWords: 4545,
    versusPrevious: 16,
  },
};

export function StatisticsPage({ onBack }: { onBack: () => void }) {
  const [range, setRange] = useState<StatisticsRange>('7d');
  const statistics = statisticsByRange[range];
  const chartTotalMinutes = statistics.chart.reduce((total, day) => total + day.minutes, 0);
  const maxMinutes = Math.max(...statistics.chart.map((day) => day.minutes), 1);
  const averageMinutes = Math.round(chartTotalMinutes / statistics.chart.length);
  const averageOffset = `${Math.max(4, Math.min(96, (1 - averageMinutes / maxMinutes) * 100))}%`;
  const rangeName = range === '7d' ? '近 7 天' : '近 30 天';
  const completion = Math.round((statistics.learnedWords / statistics.totalWords) * 100);
  const calendarDays = statistics.activity;
  const completedCalendarDays = calendarDays.filter((day) => day.minutes > 0).length;

  if (statistics.totalMinutes === 0) {
    return <section className="statistics-page statistics-empty" aria-labelledby="statistics-title">
      <p className="statistics-kicker">LEARNING NOTES</p>
      <h1 id="statistics-title">学习统计</h1>
      <div className="statistics-empty-card"><BookOpen size={42} aria-hidden="true"/><strong>本周还没有学习记录</strong><p>从今天的一个单词开始，学习足迹会慢慢在这里展开。</p><button onClick={onBack}>返回词环开始学习</button></div>
    </section>;
  }

  return <section className="statistics-page" aria-labelledby="statistics-title">
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
      <article className="statistics-metric metric-time"><span className="statistics-metric-icon"><Clock3 size={23} aria-hidden="true"/></span><p>{rangeName}投入</p><strong>{statistics.totalMinutes}<small>分钟</small></strong><em>比上期多 {statistics.versusPrevious}%</em></article>
      <article className="statistics-metric metric-words"><span className="statistics-metric-icon"><BookOpen size={23} aria-hidden="true"/></span><p>词汇积累</p><strong>{statistics.learnedWords}<small>词</small></strong><em>{statistics.learnedWords} / {statistics.totalWords} · {completion}%</em><i aria-hidden="true"><b style={{ width: `${Math.max(completion, 1)}%` }}/></i></article>
    </div>

    <section className="statistics-rhythm" aria-labelledby="rhythm-title">
      <div className="statistics-section-head"><div><p>STUDY RHYTHM</p><h2 id="rhythm-title">{rangeName}学习节奏</h2></div><span>{statistics.activeDays} 天有学习记录</span></div>
      <section className="statistics-completion" aria-labelledby="completion-title"><div><h3 id="completion-title">学习打卡</h3><p>每格对应一天：有颜色表示完成学习，颜色越深表示学习越久；橙色描边是今天。</p></div><div className="statistics-completion-body"><div className="statistics-completion-meta"><b>{completedCalendarDays} / {calendarDays.length} 天已学习</b><span>{rangeName}</span></div><div className="statistics-weekdays" aria-hidden="true">{['一','二','三','四','五','六','日'].map((day) => <span key={day}>周{day}</span>)}</div><div className="statistics-contribution-grid" aria-label={`${rangeName}学习打卡：${completedCalendarDays} 天已学习`}>{calendarDays.map((day) => <span key={day.label} className={`level-${Math.min(4, Math.ceil(day.minutes / 9))} ${day.today ? 'is-today' : ''}`} title={`${day.label}：${day.minutes ? `学习 ${day.minutes} 分钟` : '未学习'}`} aria-label={`${day.label}：${day.minutes ? `学习 ${day.minutes} 分钟` : '未学习'}`}><b>{day.today ? '今' : day.label.match(/\d+(?= 日)/)?.[0]}</b></span>)}</div><div className="statistics-contribution-legend" aria-hidden="true"><span>少</span><i className="level-0"/><i className="level-1"/><i className="level-2"/><i className="level-3"/><i className="level-4"/><span>多</span></div></div></section>
      <div className="statistics-rhythm-grid">
        <figure className="statistics-chart" role="img" aria-label={`${rangeName}共学习 ${statistics.totalMinutes} 分钟，其中 ${statistics.activeDays} 天有学习记录`}>
          <div className="statistics-chart-scale"><span>{maxMinutes} min</span><span>{Math.round(maxMinutes / 2)} min</span><span>0</span></div>
          <div className="statistics-bars">
            <div className="statistics-average-line" style={{ '--average-offset': averageOffset } as CSSProperties}><span>平均 {averageMinutes} min</span></div>
            {statistics.chart.map((day) => <div className={`statistics-bar-item ${day.today ? 'is-today' : ''} ${day.completed ? 'is-complete' : ''}`} key={day.label} tabIndex={0} data-tooltip={`${day.label}：${day.minutes} 分钟`} aria-label={`${day.label}学习 ${day.minutes} 分钟`}>
              <div className="statistics-bar-track"><i style={{ '--bar-height': `${Math.round((day.minutes / maxMinutes) * 100)}%` } as CSSProperties} aria-hidden="true"/></div>
              <span>{day.label}</span>
            </div>)}
          </div>
          <figcaption><span className="statistics-chart-key is-complete"/>已学习 <span className="statistics-chart-key is-today"/>今天（进行中） · {range === '30d' ? '每柱为 3 天累计时长' : '每柱为当天学习时长'} · 悬停柱子查看时长</figcaption>
        </figure>
        <aside className="statistics-rhythm-note"><Trophy size={30} aria-hidden="true"/><strong>本期学习了 {statistics.totalMinutes} 分钟</strong><p>{statistics.summary}</p><div><span>最常学习</span><b>{range === '7d' ? '周三' : '每周三'}</b></div></aside>
      </div>
    </section>

    <div className="statistics-bottom-grid">
      <section className="statistics-footprint" aria-labelledby="footprint-title"><div className="statistics-section-head"><div><p>WORD FOOTPRINT</p><h2 id="footprint-title">本期词汇足迹</h2></div></div><div className="statistics-footprint-list"><StatFootprint icon={<BookOpen size={21}/>} label="新学单词" value={statistics.newWords} className="is-new"/><StatFootprint icon={<RotateCcw size={21}/>} label="完成复习" value={statistics.reviewWords} className="is-review"/><StatFootprint icon={<CheckCircle2 size={21}/>} label="标记掌握" value={statistics.masteredWords} className="is-mastered"/></div></section>
      <section className="statistics-summary" aria-labelledby="summary-title"><p>WEEKLY NOTE</p><h2 id="summary-title">本期小结</h2><strong>{statistics.summary}</strong><div><span>下一步</span><p>{statistics.suggestion}</p></div></section>
    </div>
    <section className="statistics-rankings" aria-labelledby="rankings-title"><div className="statistics-section-head"><div><p>WORD SIGNALS</p><h2 id="rankings-title">单词信号</h2></div><span>演示数据</span></div><div className="statistics-ranking-grid"><WordRanking title="复习次数排行榜" hint="出现越多，说明它更常需要回来复习" rows={statistics.rankings.reviews} valueLabel="次" type="review"/><WordRanking title="陌生程度 · 低 → 高" hint="数值越高，越值得优先再见一面" rows={statistics.rankings.unfamiliar} valueLabel="陌生度" type="unfamiliar"/></div></section>
  </section>;
}

function StatFootprint({ className, icon, label, value }: { className: string; icon: React.ReactNode; label: string; value: number }) {
  return <div className={`statistics-footprint-item ${className}`}><span aria-hidden="true">{icon}</span><p>{label}</p><strong>{value}<small>词</small></strong></div>;
}

function WordRanking({ hint, rows, title, type, valueLabel }: { hint: string; rows: Array<{ word: string; count?: number; score?: number }>; title: string; type: 'review' | 'unfamiliar'; valueLabel: string }) {
  const maxValue = Math.max(...rows.map((row) => row.count ?? row.score ?? 0), 1);
  return <section className={`statistics-ranking-card is-${type}`}><h3>{title}</h3><p>{hint}</p><ol>{rows.map((row, index) => { const value = row.count ?? row.score ?? 0; return <li key={row.word}><b>{index + 1}</b><strong>{row.word}</strong><i><span style={{ width: `${Math.max(8, (value / maxValue) * 100)}%` }}/></i><em>{value}{type === 'review' ? valueLabel : ''}</em></li>; })}</ol></section>;
}
