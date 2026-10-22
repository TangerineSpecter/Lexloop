'use client';

import type { CareerActionTarget, CareerAiAnalysis, CareerStatistics } from '@lexloop/types';
import { ArrowRight, BookOpen, Brain, CheckCircle2, Clock3, Compass, LoaderCircle, Route, Sparkles, Target, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { request, type Session } from '../lib/api';

const dimensionLabels = { vocabulary: '词汇', grammar: '语法', sentenceBuilding: '句子组织', taskCompletion: '任务完成', naturalness: '表达自然度' } as const;
const sourceLabels = { ASSESSMENT: '正式测评', SCENARIO: '场景校准', BACKFILLED_BASELINE: '历史基线' } as const;
const questionLabels: Record<string, string> = { WORD_MNEMONIC: '词根联想', MEANING_RECOGNITION: '词义识别', WORD_MATCHING: '词义配对', SYNONYM_REPLACEMENT: '同义替换', READING_COMPREHENSION: '阅读理解', OUTPUT: '每日输出', CONFUSION: '易混词辨析', OTHER: '综合练习' };
const categoryLabels: Record<string, string> = { AIRPORT: '机场', HOTEL: '酒店', RESTAURANT: '餐厅', SHOPPING: '购物', TRANSPORT: '交通', HELP: '求助' };

export function CareerStatisticsView({ session, onNavigate }: { session: Session; onNavigate: (target: CareerActionTarget) => void }) {
  const [career, setCareer] = useState<CareerStatistics | null>(null);
  const [message, setMessage] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    request<CareerStatistics>('/reports/career', {}, session.accessToken)
      .then(value => { if (!cancelled) setCareer(value); })
      .catch(error => { if (!cancelled) setMessage(error instanceof Error ? error.message : '学习生涯加载失败'); });
    return () => { cancelled = true; };
  }, [session.accessToken]);

  const generateAnalysis = async () => {
    setAnalyzing(true);
    setMessage('');
    try {
      const result = await request<{ status: 'ready'; generatedAt: string; content: CareerAiAnalysis }>('/reports/career/analysis', { method: 'POST' }, session.accessToken);
      setCareer(current => current ? { ...current, aiAnalysis: result } : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'AI 学习分析生成失败，规则建议仍可正常使用。');
    } finally {
      setAnalyzing(false);
    }
  };

  if (!career) return <div className="career-loading"><BookOpen size={38}/><strong>{message || '正在整理你的学习生涯…'}</strong></div>;

  const assessed = Boolean(career.profile.assessedAt);
  const profileDimensions = Object.entries(dimensionLabels) as Array<[keyof typeof dimensionLabels, string]>;
  return <div className="career-view">
    {message && <p className="career-message" role="status"><TriangleAlert size={17}/>{message}</p>}

    <section className="career-passport" aria-labelledby="career-passport-title">
      <div className="career-passport-copy"><p>MY LEARNING PASSPORT</p><h2 id="career-passport-title">我的学习生涯</h2><span>从 {formatDate(career.overview.startedAt)} 开始，每一次练习都算作成长证据。</span></div>
      <div className="career-passport-stats">
        <CareerNumber label="累计学习日" value={career.overview.activeDays} unit="天"/>
        <CareerNumber label="完成序列" value={career.overview.completedPlans} unit="次"/>
        <CareerNumber label="累计答题" value={career.overview.totalQuestions} unit="题"/>
        <CareerNumber label="已记录答题" value={formatDuration(career.overview.studySeconds)} unit=""/>
        <CareerNumber label="学过 / 掌握" value={`${career.overview.learnedWords} / ${career.overview.masteredWords}`} unit="词"/>
        <CareerNumber label="实战场景" value={career.overview.completedScenarios} unit="次"/>
      </div>
    </section>

    <section className="career-profile" aria-labelledby="career-profile-title">
      <div className="career-section-head"><div><p>CEFR PROFILE</p><h2 id="career-profile-title">英语能力画像</h2></div><button onClick={() => onNavigate('assessment')}>{assessed ? '重新测评' : '10 分钟测水平'}<ArrowRight size={16}/></button></div>
      <div className="career-profile-grid">
        <div className="career-level-stamp"><small>{assessed ? 'ASSESSED LEVEL' : 'PROVISIONAL START'}</small><strong>{career.profile.level}</strong><b>{assessed ? career.profile.provisional ? '已完成正式测评 · 结果暂定' : confidenceLabel(career.profile.confidence) : '尚未完成正式测评 · 暂定起点'}</b><span>{career.profile.assessedAt ? `最近测评 ${formatDate(career.profile.assessedAt)}` : '完成测评后会建立可信的能力基线'}</span></div>
        <div className="career-ability-bars">{profileDimensions.map(([key, label]) => <div key={key}><span>{label}</span><i><b style={{ width: `${career.profile.dimensions[key]}%` }}/></i><em>{career.profile.dimensions[key]}</em></div>)}<p>发音 · 听力 · 流利度 <b>待语音测评</b></p></div>
      </div>
    </section>

    <section className="career-growth" aria-labelledby="career-growth-title">
      <div className="career-section-head"><div><p>GROWTH TRACE</p><h2 id="career-growth-title">能力成长轨迹</h2></div><span>{career.growth.length} 个能力节点</span></div>
      {career.growth.length ? <div className="career-timeline">{career.growth.slice(-12).map((item, index) => <article key={item.id}><i>{index + 1}</i><div><small>{formatDate(item.recordedAt)} · {sourceLabels[item.source]}{item.backfilled ? ' · 回溯' : ''}</small><strong>{item.level}</strong><span>{item.provisional ? '暂定能力节点' : confidenceLabel(item.confidence)}</span></div></article>)}</div> : <p className="career-inline-empty">完成一次正式测评或旅行场景后，能力变化会从这里开始留下轨迹。</p>}
    </section>

    <div className="career-data-grid">
      <section className="career-data-card is-memory"><div className="career-card-title"><Brain/><div><p>MEMORY ASSETS</p><h2>记忆资产</h2></div></div><div className="career-mini-grid"><CareerNumber label="学习中" value={career.memory.learningWords} unit="词"/><CareerNumber label="复习中" value={career.memory.reviewingWords} unit="词"/><CareerNumber label="今日待复习" value={career.memory.dueWords} unit="词"/><CareerNumber label="已经逾期" value={career.memory.overdueWords} unit="词"/></div><div className="career-meter"><span>掌握转化率</span><i><b style={{ width: `${Math.min(100, career.memory.masteryRate)}%` }}/></i><em>{career.memory.masteryRate}%</em></div></section>
      <section className="career-data-card is-quality"><div className="career-card-title"><Target/><div><p>LEARNING QUALITY</p><h2>学习质量</h2></div></div><div className="career-mini-grid"><CareerNumber label="累计正确率" value={career.quality.accuracy} unit="%"/><CareerNumber label="平均答题" value={formatResponse(career.quality.averageResponseMs)} unit=""/><CareerNumber label="活跃薄弱项" value={career.quality.activeWeaknesses} unit="个"/><CareerNumber label="已经纠正" value={career.quality.resolvedWeaknesses} unit="个"/></div><p className="career-type-note">较稳：{questionLabel(career.quality.strongestQuestionType)} · 待加强：{questionLabel(career.quality.weakestQuestionType)}</p></section>
    </div>

    <section className="career-practice" aria-labelledby="career-practice-title">
      <div className="career-section-head"><div><p>REAL-WORLD PRACTICE</p><h2 id="career-practice-title">实战表达能力</h2></div><span>{career.practice.categoriesExperienced} / {career.practice.totalCategories} 类场景已体验</span></div>
      <div className="career-practice-grid"><div className="career-practice-score"><Route/><strong>{career.practice.successRate}%</strong><span>场景任务成功率</span><button onClick={() => onNavigate('travel')}>继续场景练习<ArrowRight size={15}/></button></div><div><div className="career-category-list">{career.practice.categories.map(item => <span key={item.category}><b>{categoryLabels[item.category] ?? item.category}</b>{item.count} 次 · 成功 {item.successRate}%</span>)}</div><div className="career-skill-list">{career.practice.skills.length ? career.practice.skills.map(skill => <div key={skill.code}><span>{skill.title}<small>{skill.level} · {skill.evidenceCount} 次证据</small></span><i><b style={{ width: `${skill.score}%` }}/></i><em>{skill.score}</em></div>) : <p>完成旅行场景后，这里会展示礼貌请求、澄清、协商等技能进度。</p>}</div></div></div>
    </section>

    <section className="career-analysis" aria-labelledby="career-analysis-title">
      <div className="career-section-head"><div><p>PERSONAL FIELD NOTES</p><h2 id="career-analysis-title">学习分析与下一步</h2></div><button disabled={analyzing} onClick={() => void generateAnalysis()}>{analyzing ? <><LoaderCircle className="spin"/>正在分析</> : <><Sparkles/>{career.aiAnalysis.status === 'none' ? '生成 AI 分析' : '重新分析'}</>}</button></div>
      <div className="career-insights"><div><h3><CheckCircle2/>正在形成的优势</h3>{career.insights.strengths.map(item => <p key={item}>{item}</p>)}</div><div><h3><TriangleAlert/>值得留意</h3>{career.insights.risks.length ? career.insights.risks.map(item => <p key={item}>{item}</p>) : <p>目前没有明显风险，继续积累学习证据。</p>}</div></div>
      <div className="career-recommendations">{career.insights.recommendations.map((item, index) => <button key={item.title} onClick={() => onNavigate(item.target)}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{item.title}</strong><small>{item.reason}</small></span><ArrowRight/></button>)}</div>
      {career.aiAnalysis.content && <article className={`career-ai-note is-${career.aiAnalysis.status}`}><div><Sparkles/><span><small>AI STUDY NOTE · {career.aiAnalysis.generatedAt ? formatDate(career.aiAnalysis.generatedAt) : ''}</small><strong>{career.aiAnalysis.content.headline}</strong></span>{career.aiAnalysis.status === 'stale' && <b>有新数据，建议更新</b>}</div><p>{career.aiAnalysis.content.summary}</p><ol>{career.aiAnalysis.content.weeklyPlan.map(item => <li key={item.action}><button onClick={() => onNavigate(item.target)}><Compass/><span><strong>{item.action}</strong><small>{item.reason}</small></span></button></li>)}</ol></article>}
    </section>
  </div>;
}

function CareerNumber({ label, unit, value }: { label: string; unit: string; value: number | string }) { return <div className="career-number"><span>{label}</span><strong>{value}<small>{unit}</small></strong></div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value)); }
function formatDuration(seconds: number) { if (!seconds) return '0 分钟'; if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟`; return `${Math.floor(seconds / 3600)}时${Math.round(seconds % 3600 / 60)}分`; }
function formatResponse(ms: number) { return ms ? ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}秒` : '暂无'; }
function confidenceLabel(value: CareerStatistics['profile']['confidence']) { return value === 'HIGH' ? '高可信度' : value === 'MEDIUM' ? '中等可信度' : '证据积累中'; }
function questionLabel(value: string | null) { return value ? questionLabels[value] ?? value : '暂无数据'; }
