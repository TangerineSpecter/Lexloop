'use client';

import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Flame,
  ListChecks,
  RotateCcw,
  Trophy,
} from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import type {
  CareerActionTarget,
  PeriodActivityDay,
  PeriodStatistics,
  RankingRow,
  StatisticsRange,
} from '@lexloop/types';
import { browserTimeZone, request, type Session } from '../lib/api';
import { CareerStatisticsView } from './career-statistics-view';

type StatisticsView = 'period' | 'career';

const rangeLabels: Record<StatisticsRange, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  '365d': '近 1 年',
};

export function StatisticsPage({
  onBack,
  onNavigate,
  onOpenHistory,
  session,
}: {
  onBack: () => void;
  onNavigate: (target: CareerActionTarget) => void;
  onOpenHistory: () => void;
  session: Session;
}) {
  const [view, setView] = useState<StatisticsView>('period');
  const [range, setRange] = useState<StatisticsRange>('7d');
  const [statistics, setStatistics] = useState<PeriodStatistics | null>(null);
  const [loadMessage, setLoadMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    setStatistics(null);
    setLoadMessage('');
    request<PeriodStatistics>(
      `/reports/statistics?range=${range}&timeZone=${encodeURIComponent(browserTimeZone())}`,
      {},
      session.accessToken,
    )
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
  if (view === 'career')
    return (
      <section className="statistics-page" aria-labelledby="statistics-title">
        <StatisticsHeading
          view={view}
          setView={setView}
          range={range}
          setRange={setRange}
          onOpenHistory={onOpenHistory}
        />
        <CareerStatisticsView session={session} onNavigate={onNavigate} />
      </section>
    );
  if (!statistics) {
    return (
      <section className="statistics-page" aria-labelledby="statistics-title">
        <StatisticsHeading
          view={view}
          setView={setView}
          range={range}
          setRange={setRange}
          onOpenHistory={onOpenHistory}
        />
        <div className="statistics-empty-card">
          <BookOpen size={42} aria-hidden="true" />
          <strong>{loadMessage ? '学习统计加载失败' : '正在加载学习统计…'}</strong>
          <p>{loadMessage || '正在读取你的真实学习记录。'}</p>
          {loadMessage && <button onClick={onBack}>返回学习进度</button>}
        </div>
      </section>
    );
  }
  const chartTotalWords = statistics.chart.reduce((total, day) => total + day.words, 0);
  const maxWords = Math.max(...statistics.chart.map((day) => day.words), 1);
  const averageWords = Math.round(chartTotalWords / statistics.chart.length);
  const averageOffset = `${Math.max(4, Math.min(96, (1 - averageWords / maxWords) * 100))}%`;
  const rangeName = rangeLabels[range];
  const calendarDays = statistics.activity;
  const completedCalendarDays = calendarDays.filter((day) => activityLevel(day) > 0).length;
  const mostStudiedPeriod = statistics.chart.reduce((highest, day) =>
    day.words > highest.words ? day : highest,
  ).label;

  if (statistics.activeDays === 0) {
    return (
      <section className="statistics-page" aria-labelledby="statistics-title">
        <StatisticsHeading
          view={view}
          setView={setView}
          range={range}
          setRange={setRange}
          onOpenHistory={onOpenHistory}
        />
        <div className="statistics-empty-card">
          <BookOpen size={42} aria-hidden="true" />
          <strong>{rangeName}还没有学习记录</strong>
          <p>可以切换上方时间范围，或查看之前完成的学习记录。</p>
          <div className="statistics-empty-actions">
            <button onClick={onOpenHistory}>
              <CalendarDays size={17} />
              查看全部学习历史
            </button>
            <button className="is-secondary" onClick={onBack}>
              返回词环开始学习
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="statistics-page" aria-labelledby="statistics-title">
      {loadMessage && <p className="book-message">{loadMessage}</p>}
      <StatisticsHeading
        view={view}
        setView={setView}
        range={range}
        setRange={setRange}
        onOpenHistory={onOpenHistory}
      />

      <div className="statistics-metrics is-four" aria-label={`${rangeName}学习摘要`}>
        <article className="statistics-metric metric-streak">
          <span className="statistics-metric-icon">
            <Flame size={23} aria-hidden="true" />
          </span>
          <p>连续学习</p>
          <strong>
            {statistics.currentStreak}
            <small>天</small>
          </strong>
          <em>本期活跃 {statistics.activeDays} 天</em>
        </article>
        <article className="statistics-metric metric-activity">
          <span className="statistics-metric-icon">
            <ListChecks size={23} aria-hidden="true" />
          </span>
          <p>{rangeName}完成</p>
          <strong>
            {chartTotalWords}
            <small>词</small>
          </strong>
          <em>比上期多 {statistics.versusPrevious}%</em>
        </article>
        <article className="statistics-metric metric-words">
          <span className="statistics-metric-icon">
            <CheckCircle2 size={23} aria-hidden="true" />
          </span>
          <p>答题正确率</p>
          <strong>
            {statistics.accuracy}
            <small>%</small>
          </strong>
          <em>
            {statistics.attemptCount} 题 · 平均 {formatResponse(statistics.averageResponseMs)}
          </em>
        </article>
        <article className="statistics-metric metric-time">
          <span className="statistics-metric-icon">
            <BookOpen size={23} aria-hidden="true" />
          </span>
          <p>已记录答题</p>
          <strong>
            {formatStudyTime(statistics.studySeconds)}
            <small></small>
          </strong>
          <em>
            {statistics.completedPlans} 次序列 · {statistics.completedScenarios} 次场景
          </em>
        </article>
      </div>

      <section className="statistics-rhythm" aria-labelledby="rhythm-title">
        <div className="statistics-section-head">
          <div>
            <p>STUDY RHYTHM</p>
            <h2 id="rhythm-title">{rangeName}学习节奏</h2>
          </div>
          <span>{statistics.activeDays} 天有学习记录</span>
        </div>
        <section className="statistics-completion" aria-labelledby="completion-title">
          <div>
            <h3 id="completion-title">综合学习打卡</h3>
            <p>单词答题、正式测评和旅行场景都会点亮当天；橙色描边是今天。</p>
          </div>
          <div className={`statistics-completion-body range-${range}`}>
            <div className="statistics-completion-meta">
              <b>
                {completedCalendarDays} / {calendarDays.length} 天已学习
              </b>
              <span>{rangeName}</span>
            </div>
            <div className="statistics-weekdays" aria-hidden="true">
              {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                <span key={day}>周{day}</span>
              ))}
            </div>
            <div
              className={`statistics-contribution-grid range-${range}`}
              aria-label={`${rangeName}学习打卡：${completedCalendarDays} 天已学习`}
            >
              {calendarDays.map((day) => {
                const description = activityDescription(day);
                return (
                  <span
                    key={day.label}
                    className={`level-${activityLevel(day)} ${day.today ? 'is-today' : ''}`}
                    tabIndex={0}
                    data-tooltip={description}
                    title={`${day.label}：${description}`}
                    aria-label={`${day.label}：${description}`}
                  >
                    <b>{day.today ? '今' : day.label.match(/\d+(?= 日)/)?.[0]}</b>
                  </span>
                );
              })}
            </div>
            <div className="statistics-contribution-legend" aria-hidden="true">
              <span>少</span>
              <i className="level-0" />
              <i className="level-1" />
              <i className="level-2" />
              <i className="level-3" />
              <i className="level-4" />
              <span>多</span>
            </div>
          </div>
        </section>
        <div className="statistics-rhythm-grid">
          <figure
            className="statistics-chart"
            role="img"
            aria-label={`${rangeName}共完成 ${chartTotalWords} 个单词，其中 ${statistics.activeDays} 天有学习记录`}
          >
            <div className="statistics-chart-scale">
              <span>{maxWords} 词</span>
              <span>{Math.round(maxWords / 2)} 词</span>
              <span>0</span>
            </div>
            <div className="statistics-bars">
              <div
                className="statistics-average-line"
                style={{ '--average-offset': averageOffset } as CSSProperties}
              >
                <span>平均 {averageWords} 词</span>
              </div>
              {statistics.chart.map((day) => (
                <div
                  className={`statistics-bar-item ${day.today ? 'is-today' : ''} ${day.completed ? 'is-complete' : ''}`}
                  key={day.label}
                  tabIndex={0}
                  data-tooltip={`${day.label}：${day.words} 个单词`}
                  aria-label={`${day.label}完成 ${day.words} 个单词`}
                >
                  <div className="statistics-bar-track">
                    <i
                      style={
                        {
                          '--bar-height': `${Math.round((day.words / maxWords) * 100)}%`,
                        } as CSSProperties
                      }
                      aria-hidden="true"
                    />
                  </div>
                  <span>{day.label}</span>
                </div>
              ))}
            </div>
            <figcaption>
              <span className="statistics-chart-key is-complete" />
              已学习 <span className="statistics-chart-key is-today" />
              今天（进行中） ·{' '}
              {range === '365d'
                ? '每柱约为 1 个月累计'
                : range === '30d'
                  ? '每柱为 3 天累计'
                  : '每柱为当天完成'}
              单词数 · 悬停柱子查看详情
            </figcaption>
          </figure>
          <aside className="statistics-rhythm-note">
            <Trophy size={30} aria-hidden="true" />
            <strong>本期完成了 {chartTotalWords} 个单词</strong>
            <p>{statistics.summary}</p>
            <div>
              <span>最多完成</span>
              <b>{mostStudiedPeriod}</b>
            </div>
          </aside>
        </div>
      </section>

      <div className="statistics-bottom-grid">
        <section className="statistics-footprint" aria-labelledby="footprint-title">
          <div className="statistics-section-head">
            <div>
              <p>WORD FOOTPRINT</p>
              <h2 id="footprint-title">本期词汇足迹</h2>
            </div>
          </div>
          <div className="statistics-footprint-list">
            <StatFootprint
              icon={<BookOpen size={21} />}
              label="新学单词"
              value={statistics.newWords}
              className="is-new"
            />
            <StatFootprint
              icon={<RotateCcw size={21} />}
              label="完成复习"
              value={statistics.reviewWords}
              className="is-review"
            />
            <StatFootprint
              icon={<CheckCircle2 size={21} />}
              label="标记掌握"
              value={statistics.masteredWords}
              className="is-mastered"
            />
          </div>
        </section>
        <section className="statistics-summary" aria-labelledby="summary-title">
          <p>WEEKLY NOTE</p>
          <h2 id="summary-title">本期小结</h2>
          <strong>{statistics.summary}</strong>
          <div>
            <span>下一步</span>
            <p>{statistics.suggestion}</p>
          </div>
        </section>
      </div>
      <section className="statistics-rankings" aria-labelledby="rankings-title">
        <div className="statistics-section-head">
          <div>
            <p>WORD SIGNALS</p>
            <h2 id="rankings-title">单词信号</h2>
          </div>
          <span>实时学习数据</span>
        </div>
        <div className="statistics-ranking-grid">
          <WordRanking
            title="复习次数排行榜"
            hint="出现越多，说明它更常需要回来复习"
            rows={statistics.rankings.reviews}
            type="review"
          />
          <WordRanking
            title="陌生程度 · 低 → 高"
            hint="综合正确率、逾期、延期和连续答对计算"
            rows={statistics.rankings.unfamiliar}
            type="unfamiliar"
          />
          <WordRanking
            title="单词错误率 TOP 10"
            hint="所选时间内答错的比例；题数较少时仅作线索"
            rows={statistics.rankings.errorRate}
            type="error-rate"
          />
          <WordRanking
            title="单词正确率 TOP 10"
            hint="所选时间内答对的比例；题数较少时不代表稳定掌握"
            rows={statistics.rankings.accuracy}
            type="accuracy"
          />
        </div>
      </section>
    </section>
  );
}

function StatisticsHeading({
  onOpenHistory,
  range,
  setRange,
  setView,
  view,
}: {
  onOpenHistory: () => void;
  range: StatisticsRange;
  setRange: (range: StatisticsRange) => void;
  setView: (view: StatisticsView) => void;
  view: StatisticsView;
}) {
  return (
    <header className="statistics-heading">
      <div className="statistics-heading-copy">
        <p className="statistics-kicker">LEARNING NOTES</p>
        <div className="statistics-title-row">
          <h1 id="statistics-title">学习统计</h1>
          <div className="statistics-view-tabs" role="tablist" aria-label="统计视图">
            <button
              role="tab"
              aria-selected={view === 'period'}
              className={view === 'period' ? 'active' : ''}
              onClick={() => setView('period')}
            >
              阶段复盘
            </button>
            <button
              role="tab"
              aria-selected={view === 'career'}
              className={view === 'career' ? 'active' : ''}
              onClick={() => setView('career')}
            >
              学习生涯
            </button>
          </div>
        </div>
        <p>
          {view === 'period'
            ? '按周、月或年复盘最近的学习节奏。'
            : '从第一天到现在，回看完整的能力与记忆成长。'}
        </p>
      </div>
      <div className="statistics-heading-actions">
        <button className="statistics-history-link" onClick={onOpenHistory}>
          <CalendarDays size={17} />
          全部学习历史
        </button>
        {view === 'period' && (
          <div className="statistics-range" role="group" aria-label="统计时间范围">
            {(Object.keys(rangeLabels) as StatisticsRange[]).map((value) => (
              <button
                key={value}
                className={range === value ? 'active' : ''}
                onClick={() => setRange(value)}
                aria-pressed={range === value}
              >
                {rangeLabels[value]}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

function activityLevel(day: PeriodActivityDay) {
  const score =
    day.questions + day.scenarios * 5 + day.assessments * 8 + (day.practiceSessions ?? 0) * 4;
  return score ? Math.min(4, Math.max(1, Math.ceil(score / 5))) : 0;
}
function activityDescription(day: PeriodActivityDay) {
  const parts = [
    day.questions ? `${day.questions} 道题` : '',
    day.scenarios ? `${day.scenarios} 次场景` : '',
    day.assessments ? `${day.assessments} 次测评` : '',
    day.practiceSessions ? `${day.practiceSessions} 次学习专项` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '未学习';
}
function formatResponse(ms: number) {
  return ms ? (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}秒`) : '暂无';
}
function formatStudyTime(seconds: number) {
  if (!seconds) return '0分';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}分`;
  return `${Math.floor(seconds / 3600)}时`;
}

function StatFootprint({
  className,
  icon,
  label,
  value,
}: {
  className: string;
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className={`statistics-footprint-item ${className}`}>
      <span aria-hidden="true">{icon}</span>
      <p>{label}</p>
      <strong>
        {value}
        <small>词</small>
      </strong>
    </div>
  );
}

function WordRanking({
  hint,
  rows,
  title,
  type,
}: {
  hint: string;
  rows: RankingRow[];
  title: string;
  type: 'review' | 'unfamiliar' | 'error-rate' | 'accuracy';
}) {
  const maxValue = type === 'review' ? Math.max(...rows.map((row) => row.count ?? 0), 1) : 100;
  return (
    <section className={`statistics-ranking-card is-${type}`}>
      <h3>{title}</h3>
      <p>{hint}</p>
      <ol>
        {rows.map((row, index) => {
          const value = type === 'review' ? (row.count ?? 0) : (row.rate ?? 0);
          const isPercentage = type !== 'review';
          return (
            <li key={row.word}>
              <b>{index + 1}</b>
              <strong>{row.word}</strong>
              <i>
                <span style={{ width: `${Math.max(8, (value / maxValue) * 100)}%` }} />
              </i>
              <em>
                {isPercentage ? `${value.toFixed(1)}%` : `${value}次`}
                {(type === 'error-rate' || type === 'accuracy') && row.count != null && (
                  <small>{row.count} 题</small>
                )}
              </em>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
