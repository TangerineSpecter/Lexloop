'use client';

import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Compass,
  Hotel,
  Languages,
  LoaderCircle,
  Luggage,
  MapPin,
  MessageCircleMore,
  PlaneTakeoff,
  RefreshCcw,
  Send,
  ShieldPlus,
  ShoppingBag,
  Sparkles,
  TrainFront,
  Utensils,
} from 'lucide-react';
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotebookPage } from '@lexloop/types';
import { request, type Session, userFacingError } from '../lib/api';
import { TravelDeferredFeedback } from './travel-deferred-feedback';
import { DashboardBackButton } from './dashboard-back-button';
import { DashboardPageLoading } from './dashboard-loading';
import { TravelReportRehearsal } from './travel-report-rehearsal';
import resumeStyles from './travel-session-resume.module.css';

type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
type Profile = {
  overallLevel: CefrLevel;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  provisional: boolean;
  assessedAt: string | null;
  dimensions: Record<
    'vocabulary' | 'grammar' | 'sentenceBuilding' | 'taskCompletion' | 'naturalness',
    number
  > &
    Record<'pronunciation' | 'listening' | 'fluency', number | null>;
};
type GrammarFrame = { intent: string; natural: string; frame: string; explanation: string };
type Scenario = {
  id: string;
  category: Category;
  categoryLabel: string;
  title: string;
  description: string;
  userRole: string;
  aiRole: string;
  minTurns: number;
  maxTurns: number;
  objectives: string[];
  starterPhrases: string[];
  grammarFrames: GrammarFrame[];
  completedCount: number;
  bestOutcome: 'SUCCESS' | 'PARTIAL' | 'INCOMPLETE' | null;
};
type Category = 'AIRPORT' | 'HOTEL' | 'RESTAURANT' | 'SHOPPING' | 'TRANSPORT' | 'HELP';
type TodayPlan = {
  id: string;
  totalMinutes: number;
  items: Array<{
    id: string;
    type: string;
    position: number;
    minutes: number;
    title: string;
    reason: string;
    completedAt: string | null;
    scenario: Scenario | null;
  }>;
};
type AssessmentItem = {
  id: string;
  type: string;
  level: CefrLevel;
  dimension: string;
  scenario: Category | null;
  prompt: string;
  options: string[] | null;
  ordinal: number;
};
type AssessmentState = {
  id: string;
  status: string;
  answered: number;
  total: number;
  estimatedMinutes: number;
  currentLevel: CefrLevel;
  nextItem: AssessmentItem | null;
  result?: { isCorrect: boolean | null; provisional: boolean };
};
type Correction = {
  issue: string;
  hint: string;
  natural: string;
  frame: string;
  explanation: string;
};
type DeferredFeedback = { type: string; original: string; natural: string; explanation: string };
type VocabularyCandidate = {
  text: string;
  type: 'WORD' | 'PHRASE';
  meaning: string;
  example: string;
};
type Evaluation = {
  taskProgress: Array<{ objective: string; completed: boolean }>;
  blockingCorrection: Correction | null;
  deferredFeedback: DeferredFeedback[];
  vocabulary: VocabularyCandidate[];
  sessionShouldEnd: boolean;
};
type Turn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  evaluation?: Evaluation | null;
};
type ScenarioSession = {
  id: string;
  templateId: string;
  level: CefrLevel;
  status: string;
  turnCount: number;
};
type ScenarioStart = {
  session: ScenarioSession;
  template: Scenario;
  turns: Turn[];
  pendingRetry?: { content: string; clientMessageId: string } | null;
};
type Report = {
  outcome: 'SUCCESS' | 'PARTIAL' | 'INCOMPLETE';
  dimensions: Record<string, number>;
  rewrites: DeferredFeedback[];
  grammarFrames: GrammarFrame[];
  evidence: Array<{ objective: string; completed: boolean }>;
  vocabulary: VocabularyCandidate[];
  recommendation: string;
};
type ScenarioReportDetail = {
  session: ScenarioSession;
  completedAt: string;
  template: Scenario;
  report: Report;
};
type ScenarioReportHistoryItem = {
  sessionId: string;
  completedAt: string;
  level: CefrLevel;
  template: { id: string; title: string; category: Category; categoryLabel: string };
  outcome: Report['outcome'];
};
type ScenarioReportHistoryPage = {
  items: ScenarioReportHistoryItem[];
  nextCursor: string | null;
};
type PersonalItem = {
  id: string;
  text: string;
  type: string;
  meaning: string | null;
  example: string | null;
  sourceScenario: string | null;
  state: string;
};

const categories: Array<{ key: Category | 'ALL'; label: string; icon: ReactNode; note: string }> = [
  { key: 'ALL', label: '全部路线', icon: <Compass />, note: '18 站' },
  { key: 'AIRPORT', label: '机场', icon: <PlaneTakeoff />, note: '值机·登机' },
  { key: 'HOTEL', label: '酒店', icon: <Hotel />, note: '入住·需求' },
  { key: 'RESTAURANT', label: '餐厅', icon: <Utensils />, note: '点餐·结账' },
  { key: 'SHOPPING', label: '购物', icon: <ShoppingBag />, note: '尺码·退换' },
  { key: 'TRANSPORT', label: '交通', icon: <TrainFront />, note: '路线·改签' },
  { key: 'HELP', label: '求助', icon: <ShieldPlus />, note: '医疗·丢失' },
];

const dimensions = [
  ['vocabulary', '词汇识别'],
  ['grammar', '语法控制'],
  ['sentenceBuilding', '句子组装'],
  ['taskCompletion', '场景完成'],
  ['naturalness', '自然表达'],
] as const;

export function TravelScenarioPage({
  session,
  onBack,
  startWithAssessment = false,
}: {
  session: Session;
  onBack: () => void;
  startWithAssessment?: boolean;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [personal, setPersonal] = useState<PersonalItem[]>([]);
  const [resumable, setResumable] = useState<ScenarioStart | null>(null);
  const [resumableOwnerId, setResumableOwnerId] = useState(session.user.id);
  const [reportHistory, setReportHistory] = useState<ScenarioReportHistoryItem[]>([]);
  const [reportHistoryNextCursor, setReportHistoryNextCursor] = useState<string | null>(null);
  const [reportHistoryStatus, setReportHistoryStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [reportHistoryOwnerId, setReportHistoryOwnerId] = useState(session.user.id);
  const [reportHistoryError, setReportHistoryError] = useState('');
  const [reportHistoryMoreLoading, setReportHistoryMoreLoading] = useState(false);
  const [openingReportId, setOpeningReportId] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | 'ALL'>('ALL');
  const [assessment, setAssessment] = useState<AssessmentState | null>(null);
  const [active, setActive] = useState<ScenarioStart | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const assessmentRequested = useRef(false);
  const currentUserIdRef = useRef(session.user.id);
  currentUserIdRef.current = session.user.id;

  const loadReportHistory = useCallback(async () => {
    const ownerId = session.user.id;
    setReportHistoryOwnerId(ownerId);
    setReportHistory([]);
    setReportHistoryNextCursor(null);
    setReportHistoryStatus('loading');
    setReportHistoryError('');
    setReportHistoryMoreLoading(false);
    try {
      const result = await request<ScenarioReportHistoryPage>(
        '/scenario-sessions/reports',
        {},
        session.accessToken,
      );
      if (currentUserIdRef.current !== ownerId) return;
      setReportHistory(result.items);
      setReportHistoryNextCursor(result.nextCursor);
      setReportHistoryStatus('ready');
    } catch (error) {
      if (currentUserIdRef.current !== ownerId) return;
      setReportHistoryError(userFacingError(error, '暂时无法读取复盘历史'));
      setReportHistoryStatus('error');
    }
  }, [session.accessToken, session.user.id]);

  const loadMoreReportHistory = async () => {
    const ownerId = session.user.id;
    const cursor = reportHistoryNextCursor;
    if (!cursor || reportHistoryMoreLoading) return;
    setReportHistoryMoreLoading(true);
    setReportHistoryError('');
    try {
      const result = await request<ScenarioReportHistoryPage>(
        `/scenario-sessions/reports?cursor=${encodeURIComponent(cursor)}`,
        {},
        session.accessToken,
      );
      if (currentUserIdRef.current !== ownerId) return;
      setReportHistory((current) => {
        const existing = new Set(current.map((item) => item.sessionId));
        return [...current, ...result.items.filter((item) => !existing.has(item.sessionId))];
      });
      setReportHistoryNextCursor(result.nextCursor);
    } catch (error) {
      if (currentUserIdRef.current !== ownerId) return;
      setReportHistoryError(userFacingError(error, '暂时无法读取更早的复盘'));
    } finally {
      if (currentUserIdRef.current === ownerId) setReportHistoryMoreLoading(false);
    }
  };

  const openHistoricalReport = async (sessionId: string) => {
    const ownerId = session.user.id;
    if (openingReportId) return;
    setOpeningReportId(sessionId);
    setMessage('');
    try {
      const result = await request<ScenarioReportDetail>(
        `/scenario-sessions/${encodeURIComponent(sessionId)}/report`,
        {},
        session.accessToken,
      );
      if (currentUserIdRef.current !== ownerId) return;
      setActive({ session: result.session, template: result.template, turns: [] });
      setReport(result.report);
    } catch (error) {
      if (currentUserIdRef.current !== ownerId) return;
      setMessage(userFacingError(error, '暂时无法打开这次复盘，请重试'));
    } finally {
      if (currentUserIdRef.current === ownerId) setOpeningReportId(null);
    }
  };

  const load = useCallback(async () => {
    const ownerId = session.user.id;
    setLoading(true);
    setResumableOwnerId(ownerId);
    setResumable(null);
    setOpeningReportId(null);
    void loadReportHistory();
    try {
      const [nextProfile, nextPlan, nextScenarios, nextPersonal, nextResumable] = await Promise.all(
        [
          request<Profile>('/proficiency/profile', {}, session.accessToken),
          request<TodayPlan>('/practice/today', {}, session.accessToken),
          request<Scenario[]>('/scenarios', {}, session.accessToken),
          request<NotebookPage>('/vocabulary/notebook?source=TRAVEL', {}, session.accessToken),
          request<ScenarioStart | null>('/scenario-sessions/active', {}, session.accessToken),
        ],
      );
      if (currentUserIdRef.current !== ownerId) return;
      setProfile(nextProfile);
      setPlan(nextPlan);
      setScenarios(nextScenarios);
      setPersonal(nextPersonal.items);
      setResumable(nextResumable);
    } catch (error) {
      if (currentUserIdRef.current !== ownerId) return;
      setMessage(userFacingError(error, '旅行场景加载失败'));
    } finally {
      if (currentUserIdRef.current === ownerId) setLoading(false);
    }
  }, [loadReportHistory, session.accessToken, session.user.id]);

  const startAssessment = useCallback(async () => {
    setMessage('');
    try {
      setAssessment(
        await request<AssessmentState>(
          '/proficiency/assessments',
          { method: 'POST' },
          session.accessToken,
        ),
      );
    } catch (error) {
      setMessage(userFacingError(error, '暂时无法开始测评'));
    }
  }, [session.accessToken]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!startWithAssessment || assessmentRequested.current) return;
    assessmentRequested.current = true;
    void startAssessment();
  }, [startAssessment, startWithAssessment]);
  const startScenario = async (scenario: Scenario) => {
    setMessage('');
    setLoading(true);
    setReport(null);
    try {
      setActive(
        await request<ScenarioStart>(
          '/scenario-sessions',
          { method: 'POST', body: JSON.stringify({ templateId: scenario.id }) },
          session.accessToken,
        ),
      );
    } catch (error) {
      setMessage(userFacingError(error, '暂时无法开始场景'));
    } finally {
      setLoading(false);
    }
  };
  const saveVocabulary = async (candidate: VocabularyCandidate, scenarioTitle: string) => {
    try {
      const item = await request<PersonalItem>(
        '/vocabulary/personal/items',
        {
          method: 'POST',
          body: JSON.stringify({
            text: candidate.text,
            type: candidate.type,
            meaning: candidate.meaning,
            example: candidate.example,
            sourceScenario: scenarioTitle,
            cefrLevel: active?.session.level,
          }),
        },
        session.accessToken,
      );
      setPersonal((current) => [
        item,
        ...current.filter((value) => value.text.toLowerCase() !== item.text.toLowerCase()),
      ]);
      setMessage(`已把 “${candidate.text}” 放进个人生词本；新词已加入复习，重复收藏保留原有进度。`);
    } catch (error) {
      setMessage(userFacingError(error, '收藏失败'));
    }
  };

  if (loading && !profile) return <TravelLoading onBack={onBack} />;
  if (assessment)
    return (
      <AssessmentView
        session={session}
        assessment={assessment}
        onChange={setAssessment}
        onComplete={async (nextProfile) => {
          setProfile(nextProfile);
          setAssessment(null);
          await load();
        }}
        onClose={() => setAssessment(null)}
      />
    );
  if (report && active)
    return (
      <ReportView
        key={active.session.id}
        report={report}
        scenario={active.template}
        onSave={(candidate) => void saveVocabulary(candidate, active.template.title)}
        onAgain={() => {
          const scenario = active.template;
          setActive(null);
          setReport(null);
          void startScenario(scenario);
        }}
        onDone={() => {
          setActive(null);
          setReport(null);
          void load();
        }}
        message={message}
      />
    );
  if (active)
    return (
      <ConversationView
        session={session}
        value={active}
        onChange={setActive}
        onBack={() => {
          setActive(null);
          void load();
        }}
        onComplete={setReport}
        onSave={(candidate) => void saveVocabulary(candidate, active.template.title)}
        message={message}
      />
    );

  const filtered =
    category === 'ALL' ? scenarios : scenarios.filter((item) => item.category === category);
  const todayScenario = plan?.items.find((item) => item.type === 'SCENARIO')?.scenario;
  const ownsReportHistory = reportHistoryOwnerId === session.user.id;
  const latestHistoryReport = ownsReportHistory ? (reportHistory[0] ?? null) : null;
  const olderReports = ownsReportHistory ? reportHistory.slice(1) : [];
  const showReportHistory =
    ownsReportHistory &&
    (reportHistoryStatus === 'ready' ||
      (reportHistoryStatus === 'error' && reportHistory.length > 0)) &&
    (olderReports.length > 0 || reportHistoryNextCursor !== null || reportHistoryError !== '');
  return (
    <div className="travel-page">
      <header className="travel-page-head">
        <div className="travel-page-intro">
          <DashboardBackButton onClick={onBack}>返回学习进度</DashboardBackButton>
          <div>
            <p className="travel-kicker">TRAVEL ENGLISH · 旅行任务手账</p>
            <h1>把英语，带到真正要说的地方。</h1>
            <p>不用背台词。完成一次真实沟通，再把卡住你的表达拆开学会。</p>
          </div>
        </div>
        <div className="passport-stamp" aria-label={`当前等级 ${profile?.overallLevel ?? 'A1'}`}>
          <small>MY LEVEL</small>
          <strong>{profile?.overallLevel ?? 'A1'}</strong>
          <span>{profile?.provisional ? '暂定' : '已测评'}</span>
        </div>
      </header>
      {message && (
        <div className="travel-notice" role="status">
          {message}
        </div>
      )}

      {resumable && resumableOwnerId === session.user.id && (
        <section
          className={`${resumeStyles.resume} travel-session-resume`}
          aria-labelledby="travel-resume-title"
        >
          <div className={resumeStyles.copy}>
            <small>未完成的旅行对话</small>
            <h2 id="travel-resume-title">{resumable.template.title}</h2>
            <p>已保存 {resumable.session.turnCount} 轮对话，可以从上次停下的地方继续。</p>
            {resumable.pendingRetry && <span>上一句尚未收到回复，继续后可以安全重试。</span>}
          </div>
          <button onClick={() => setActive(resumable)}>继续上次场景</button>
        </section>
      )}

      {ownsReportHistory && reportHistoryStatus === 'loading' && (
        <p className={resumeStyles.status} role="status">
          正在读取旅行复盘…
        </p>
      )}
      {ownsReportHistory && reportHistoryStatus === 'error' && reportHistory.length === 0 && (
        <section className={`${resumeStyles.resume} travel-report-recovery`} aria-live="polite">
          <div className={resumeStyles.copy}>
            <small>旅行复盘</small>
            <h2>暂时无法读取</h2>
            <p>{reportHistoryError}</p>
          </div>
          <button onClick={() => void loadReportHistory()}>重试读取</button>
        </section>
      )}
      {ownsReportHistory && reportHistoryStatus === 'ready' && latestHistoryReport && (
        <section
          className={`${resumeStyles.resume} travel-report-recovery`}
          aria-labelledby="travel-report-recovery-title"
        >
          <div className={resumeStyles.copy}>
            <small>最近一次旅行复盘</small>
            <h2 id="travel-report-recovery-title">{latestHistoryReport.template.title}</h2>
            <p>这次的反馈和句型已保存，可以随时回来查看。</p>
          </div>
          <button
            disabled={openingReportId !== null}
            onClick={() => void openHistoricalReport(latestHistoryReport.sessionId)}
          >
            {openingReportId === latestHistoryReport.sessionId ? '正在打开…' : '查看复盘'}
          </button>
        </section>
      )}
      {showReportHistory && (
        <section
          className={`${resumeStyles.history} travel-report-history`}
          aria-labelledby="travel-report-history-title"
        >
          <header className={resumeStyles.historyHeader}>
            <div>
              <small>TRIP NOTES · 复盘历史</small>
              <h2 id="travel-report-history-title">更早的旅行复盘</h2>
            </div>
            <span>回看当时的表达反馈，再练习有帮助的句型。</span>
          </header>
          {reportHistoryStatus === 'error' && reportHistory.length === 0 && (
            <div className={resumeStyles.historyError} role="alert">
              <p>{reportHistoryError}</p>
              <button onClick={() => void loadReportHistory()}>重试读取</button>
            </div>
          )}
          {olderReports.length > 0 && (
            <ol className={resumeStyles.historyList} aria-label="已完成的旅行复盘">
              {olderReports.map((item) => (
                <li className={resumeStyles.historyItem} key={item.sessionId}>
                  <div className={resumeStyles.historySummary}>
                    <small>
                      {item.template.categoryLabel} · {historyDate(item.completedAt)} · {item.level}
                    </small>
                    <h3>{item.template.title}</h3>
                    <span>{scenarioOutcomeLabel(item.outcome)}</span>
                  </div>
                  <button
                    disabled={openingReportId !== null}
                    aria-label={`查看 ${item.template.title} 的复盘`}
                    onClick={() => void openHistoricalReport(item.sessionId)}
                  >
                    {openingReportId === item.sessionId ? '正在打开…' : '查看复盘'}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {reportHistoryError && reportHistory.length > 0 && (
            <div className={resumeStyles.historyError} role="alert">
              <p>{reportHistoryError}</p>
              {reportHistoryNextCursor && (
                <button onClick={() => void loadReportHistory()}>刷新复盘列表</button>
              )}
            </div>
          )}
          {reportHistoryNextCursor && (
            <button
              className={resumeStyles.historyMore}
              disabled={reportHistoryMoreLoading}
              onClick={() => void loadMoreReportHistory()}
            >
              {reportHistoryMoreLoading ? '正在读取…' : '加载更早复盘'}
            </button>
          )}
        </section>
      )}

      <section className="travel-overview-grid">
        <article className="today-ticket">
          <div className="ticket-route">
            <span>今日出发</span>
            <b>15 MIN</b>
          </div>
          <div className="ticket-main">
            <span className="ticket-icon">
              <Luggage />
            </span>
            <div>
              <small>{todayScenario?.categoryLabel ?? '旅行口语'}</small>
              <h2>{todayScenario?.title ?? '准备下一段旅程'}</h2>
              <p>{todayScenario?.description ?? '完成水平定位后，系统会为你安排合适的场景。'}</p>
            </div>
          </div>
          <ol className="ticket-steps">
            {plan?.items.map((item) => (
              <li key={item.id} className={item.completedAt ? 'done' : ''}>
                <span>{item.completedAt ? <Check size={14} /> : item.position}</span>
                <div>
                  <b>
                    {item.minutes} 分钟 · {item.title}
                  </b>
                  <small>{item.reason}</small>
                </div>
              </li>
            ))}
          </ol>
          <button
            className="travel-primary"
            disabled={!todayScenario}
            onClick={() => todayScenario && void startScenario(todayScenario)}
          >
            开始今日场景 <ArrowRight size={17} />
          </button>
        </article>

        <article className="ability-card">
          <div className="travel-section-head">
            <div>
              <span>
                <Languages />
              </span>
              <div>
                <small>CEFR PROFILE</small>
                <h2>我的表达能力</h2>
              </div>
            </div>
            <button onClick={() => void startAssessment()}>
              {profile?.assessedAt ? '重新测评' : '10 分钟测水平'}
            </button>
          </div>
          <div className="level-line">
            <strong>{profile?.overallLevel ?? 'A1'}</strong>
            <div>
              <b>{confidenceText(profile?.confidence)}</b>
              <span>
                {profile?.provisional
                  ? '这是暂定起点，会随练习校准。'
                  : '基于词汇、语法和场景表达综合判断。'}
              </span>
            </div>
          </div>
          <div className="ability-bars">
            {dimensions.map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <i>
                  <b style={{ width: `${profile?.dimensions[key] ?? 0}%` }} />
                </i>
                <em>{profile?.dimensions[key] ?? 0}</em>
              </div>
            ))}
          </div>
          <div className="unmeasured">
            <Circle size={9} />
            <span>发音 · 听力 · 流利度</span>
            <b>待语音测评</b>
          </div>
        </article>
      </section>

      <section className="scenario-board">
        <div className="scenario-board-head">
          <div>
            <p className="travel-kicker">CHOOSE YOUR NEXT STOP</p>
            <h2>六条旅行路线，十八个真实任务</h2>
          </div>
          <span>
            {scenarios.filter((item) => item.completedCount > 0).length} / {scenarios.length} 已体验
          </span>
        </div>
        <div className="route-tabs" role="tablist" aria-label="旅行场景分类">
          {categories.map((item) => (
            <button
              key={item.key}
              className={category === item.key ? 'active' : ''}
              onClick={() => setCategory(item.key)}
              role="tab"
              aria-selected={category === item.key}
            >
              <span>{item.icon}</span>
              <b>{item.label}</b>
              <small>{item.note}</small>
            </button>
          ))}
        </div>
        <div className="scenario-grid">
          {filtered.map((scenario, index) => (
            <article
              key={scenario.id}
              className="scenario-card"
              style={{ '--card-index': index } as React.CSSProperties}
            >
              <div className="scenario-number">{String(index + 1).padStart(2, '0')}</div>
              <div className="scenario-card-status">
                {scenario.completedCount ? (
                  <>
                    <CheckCircle2 /> 已练 {scenario.completedCount} 次
                  </>
                ) : (
                  'NEW STOP'
                )}
              </div>
              <small>
                {scenario.categoryLabel} · {scenario.userRole}
              </small>
              <h3>{scenario.title}</h3>
              <p>{scenario.description}</p>
              <div className="scenario-goals">
                {scenario.objectives.slice(0, 2).map((goal) => (
                  <span key={goal}>
                    <Check size={12} />
                    {goal}
                  </span>
                ))}
              </div>
              <button onClick={() => void startScenario(scenario)}>
                进入场景 <ArrowRight size={16} />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="travel-wordbook">
        <div>
          <BookMarked />
          <span>
            <small>MY TRAVEL PHRASES</small>
            <b>旅行收藏</b>
          </span>
          <a href="/dashboard/notebook">打开完整生词本 →</a>
        </div>
        {personal.length ? (
          <div className="wordbook-strip">
            {personal.slice(0, 8).map((item) => (
              <article key={item.id}>
                <small>{item.type === 'PHRASE' ? '口语块' : '单词'}</small>
                <strong>{item.text}</strong>
                <span>{item.meaning}</span>
              </article>
            ))}
          </div>
        ) : (
          <p>在场景中点击“加入生词”，常用单词和整句表达都会回到你的复习计划里。</p>
        )}
      </section>
    </div>
  );
}

function AssessmentView({
  session,
  assessment,
  onChange,
  onComplete,
  onClose,
}: {
  session: Session;
  assessment: AssessmentState;
  onChange: (value: AssessmentState) => void;
  onComplete: (profile: Profile) => void;
  onClose: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const item = assessment.nextItem;
  const submit = async () => {
    if (!item || !answer.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const next = await request<AssessmentState>(
        `/proficiency/assessments/${assessment.id}/responses`,
        { method: 'POST', body: JSON.stringify({ itemId: item.id, answer }) },
        session.accessToken,
      );
      setMessage(
        next.result?.provisional
          ? '已记录；当前表达题使用临时评分，稍后会继续校准。'
          : next.result?.isCorrect === false
            ? '已记录。不要担心，后面的题会自动调整难度。'
            : '已记录，继续保持。',
      );
      setAnswer('');
      onChange(next);
    } catch (error) {
      setMessage(userFacingError(error, '答案提交失败'));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    try {
      onComplete(
        await request<Profile>(
          `/proficiency/assessments/${assessment.id}/complete`,
          { method: 'POST' },
          session.accessToken,
        ),
      );
    } catch (error) {
      setMessage(userFacingError(error, '测评结算失败'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="assessment-page">
      <header>
        <button onClick={onClose}>
          <ArrowLeft /> 稍后再测
        </button>
        <div>
          <span>CEFR · LEVEL CHECK</span>
          <b>
            {assessment.answered} / {assessment.total}
          </b>
        </div>
      </header>
      <div className="assessment-progress">
        <i style={{ width: `${(assessment.answered / assessment.total) * 100}%` }} />
      </div>
      <main>
        <div className="assessment-meta">
          <span>{item?.level ?? assessment.currentLevel}</span>
          <b>{item ? dimensionLabel(item.dimension) : '测评完成'}</b>
          <small>预计还需 {assessment.estimatedMinutes} 分钟</small>
        </div>
        {item ? (
          <>
            <p className="assessment-number">QUESTION {item.ordinal}</p>
            <h1>{item.prompt}</h1>
            {item.type === 'FREE_RESPONSE' ? (
              <textarea
                autoFocus
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Write what you would really say. 不必追求长句，清楚自然最重要。"
                maxLength={1200}
              />
            ) : (
              <div className="assessment-options">
                {item.options?.map((option) => (
                  <button
                    key={option}
                    className={answer === option ? 'selected' : ''}
                    onClick={() => setAnswer(option)}
                  >
                    <span>{answer === option ? <Check /> : <Circle />}</span>
                    {option}
                  </button>
                ))}
              </div>
            )}
            <div className="assessment-actions">
              <span>{message}</span>
              <button disabled={!answer.trim() || busy} onClick={() => void submit()}>
                {busy ? (
                  <LoaderCircle className="spin" />
                ) : (
                  <>
                    提交并继续 <ArrowRight />
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="assessment-finish">
            <Sparkles />
            <h1>证据已经收集完成</h1>
            <p>系统会综合词汇、语法、句子组装和两个旅行表达任务，给出学习起点与能力画像。</p>
            <button disabled={busy} onClick={() => void finish()}>
              {busy ? '正在生成画像…' : '查看我的学习起点'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function ConversationView({
  session,
  value,
  onChange,
  onBack,
  onComplete,
  onSave,
  message,
}: {
  session: Session;
  value: ScenarioStart;
  onChange: (value: ScenarioStart) => void;
  onBack: () => void;
  onComplete: (report: Report) => void;
  onSave: (candidate: VocabularyCandidate) => void;
  message: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    value.pendingRetry
      ? '上次有一句还没收到回复。可以用原消息安全重试；如果它仍在处理中，请稍后再试。'
      : '',
  );
  const [pendingRetry, setPendingRetry] = useState<{
    content: string;
    clientMessageId: string;
  } | null>(value.pendingRetry ?? null);
  const latest =
    [...value.turns].reverse().find((turn) => turn.role === 'assistant' && turn.evaluation)
      ?.evaluation ?? null;
  const deliver = async (content: string, clientMessageId: string, turns: Turn[]) => {
    setBusy(true);
    setError('');
    try {
      const result = await request<{
        turn: Turn;
        evaluation: Evaluation;
        session: ScenarioSession;
      }>(
        `/scenario-sessions/${value.session.id}/turns`,
        { method: 'POST', body: JSON.stringify({ message: content, clientMessageId }) },
        session.accessToken,
      );
      setPendingRetry(null);
      onChange({
        ...value,
        session: result.session,
        turns: [...turns.filter((turn) => turn.id !== result.turn.id), result.turn],
      });
    } catch (nextError) {
      setPendingRetry({ content, clientMessageId });
      setError(userFacingError(nextError, '这一轮没有回复成功，你的输入已经保存，可以重试。'));
    } finally {
      setBusy(false);
    }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    const content = text.trim();
    const clientMessageId = crypto.randomUUID();
    const optimistic: Turn = { id: clientMessageId, role: 'user', content };
    const turns = [...value.turns, optimistic];
    onChange({ ...value, turns });
    setText('');
    await deliver(content, clientMessageId, turns);
  };
  const finish = async () => {
    setBusy(true);
    try {
      onComplete(
        await request<Report>(
          `/scenario-sessions/${value.session.id}/complete`,
          { method: 'POST' },
          session.accessToken,
        ),
      );
    } catch (nextError) {
      setError(userFacingError(nextError, '场景结算失败'));
    } finally {
      setBusy(false);
    }
  };
  const canFinish = value.session.turnCount >= value.template.minTurns || latest?.sessionShouldEnd;
  return (
    <div className="conversation-page">
      <header className="conversation-head">
        <button onClick={onBack} aria-label="退出场景">
          <ArrowLeft />
        </button>
        <div>
          <small>{value.template.categoryLabel} · ROLE PLAY</small>
          <h1>{value.template.title}</h1>
          <span>
            你是{value.template.userRole} · 对方是{value.template.aiRole}
          </span>
        </div>
        <div className="conversation-counter">
          <b>{value.session.turnCount}</b>
          <span>/ {value.template.maxTurns} 回合</span>
        </div>
      </header>
      <div className="conversation-layout">
        <aside className="mission-sheet">
          <p>MISSION CARD</p>
          <h2>这次要说成什么？</h2>
          <ul>
            {value.template.objectives.map((goal) => {
              const done = latest?.taskProgress.find((item) => item.objective === goal)?.completed;
              return (
                <li key={goal} className={done ? 'done' : ''}>
                  {done ? <CheckCircle2 /> : <Circle />}
                  <span>{goal}</span>
                </li>
              );
            })}
          </ul>
          <div className="phrase-kit">
            <small>卡住时，从这里借一句</small>
            {value.template.starterPhrases.map((phrase) => (
              <button key={phrase} onClick={() => setText(phrase)}>
                {phrase}
              </button>
            ))}
          </div>
          <div className="grammar-ticket">
            <small>今天的句子骨架</small>
            <b>{value.template.grammarFrames[0]?.natural}</b>
            <span>{value.template.grammarFrames[0]?.explanation}</span>
          </div>
        </aside>
        <main className="dialogue-sheet">
          <div className="dialogue-stream">
            {value.turns.map((turn) => (
              <div key={turn.id} className={`dialogue-turn ${turn.role}`}>
                <small>{turn.role === 'assistant' ? value.template.aiRole : 'YOU'}</small>
                <p>{turn.content}</p>
                {turn.role === 'assistant' && turn.evaluation?.deferredFeedback?.length ? (
                  <TravelDeferredFeedback items={turn.evaluation.deferredFeedback} />
                ) : null}
              </div>
            ))}
            {busy && (
              <div className="dialogue-turn assistant thinking">
                <small>{value.template.aiRole}</small>
                <p>
                  <i />
                  <i />
                  <i />
                </p>
              </div>
            )}
          </div>
          {latest?.blockingCorrection && <CorrectionCard value={latest.blockingCorrection} />}
          {latest?.vocabulary?.length ? (
            <div className="candidate-strip">
              <span>这轮值得带走</span>
              {latest.vocabulary.map((item) => (
                <button key={item.text} onClick={() => onSave(item)}>
                  <PlusMark /> {item.text}
                  <small>{item.meaning}</small>
                </button>
              ))}
            </div>
          ) : null}
          {(error || message) && (
            <div className="travel-notice scene-retry-notice" role="status">
              <span>{error || message}</span>
              {pendingRetry && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void deliver(pendingRetry.content, pendingRetry.clientMessageId, value.turns)
                  }
                >
                  {busy ? '正在重试…' : '重试这句话'}
                </button>
              )}
            </div>
          )}
          <form className="scene-composer" onSubmit={send}>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={pendingRetry ? '请先重试上一句话' : '像真的在现场一样回答…'}
              maxLength={1200}
              disabled={busy || Boolean(pendingRetry)}
            />
            <div>
              <span>{text.length}/1200</span>
              <button
                disabled={!text.trim() || busy || Boolean(pendingRetry)}
                aria-label="发送回复"
              >
                <Send />
              </button>
            </div>
          </form>
          <div className="conversation-actions">
            <span>
              {canFinish
                ? '已经可以结束并查看复盘'
                : `至少完成 ${value.template.minTurns} 轮，系统才会给出完整复盘`}
            </span>
            <button disabled={!canFinish || busy} onClick={() => void finish()}>
              完成场景 <CheckCircle2 />
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}

function CorrectionCard({ value }: { value: Correction }) {
  return (
    <article className="correction-card">
      <div>
        <Sparkles />
        <span>
          <small>PAUSE & REPAIR</small>
          <b>这句话会影响理解，先修一下</b>
        </span>
      </div>
      <p>{value.issue}</p>
      <blockquote>{value.natural}</blockquote>
      <div className="sentence-frame">
        <span>句子骨架</span>
        <b>{value.frame}</b>
        <small>{value.explanation}</small>
      </div>
      <em>{value.hint}</em>
    </article>
  );
}

function ReportView({
  report,
  scenario,
  onSave,
  onAgain,
  onDone,
  message,
}: {
  report: Report;
  scenario: Scenario;
  onSave: (candidate: VocabularyCandidate) => void;
  onAgain: () => void;
  onDone: () => void;
  message: string;
}) {
  const scoreEntries = dimensions.map(
    ([key, label]) => [key, label, report.dimensions[key] ?? 0] as const,
  );
  const rehearsalReference = report.rewrites[0]?.natural.trim().replace(/\s+/g, ' ').toLowerCase();
  const visibleGrammarFrames = (
    report.rewrites.length ? report.grammarFrames : report.grammarFrames.slice(1)
  )
    .filter((item) => item.natural.trim().replace(/\s+/g, ' ').toLowerCase() !== rehearsalReference)
    .slice(0, 3);
  return (
    <div className="travel-report-page">
      <header>
        <div className={`report-seal ${report.outcome.toLowerCase()}`}>
          <CheckCircle2 />
          <span>
            {report.outcome === 'SUCCESS'
              ? '任务完成'
              : report.outcome === 'PARTIAL'
                ? '部分完成'
                : '继续练习'}
          </span>
        </div>
        <p className="travel-kicker">TRIP NOTES · 场景复盘</p>
        <h1>{scenario.title}</h1>
        <p>{report.recommendation}</p>
      </header>
      {message && <div className="travel-notice">{message}</div>}
      <section className="report-grid">
        <article className="report-score">
          <h2>这次表达怎么样</h2>
          {scoreEntries.map(([, label, score]) => (
            <div key={label}>
              <span>{label}</span>
              <i>
                <b style={{ width: `${score}%` }} />
              </i>
              <em>{score}</em>
            </div>
          ))}
        </article>
        <article className="report-goals">
          <h2>沟通目标</h2>
          {report.evidence.map((item) => (
            <p key={item.objective} className={item.completed ? 'done' : ''}>
              {item.completed ? <CheckCircle2 /> : <Circle />}
              {item.objective}
            </p>
          ))}
        </article>
      </section>
      <section className="rewrite-notes">
        <div className="travel-section-head">
          <div>
            <span>
              <MessageCircleMore />
            </span>
            <div>
              <small>SAY IT NATURALLY</small>
              <h2>把它说得更自然</h2>
            </div>
          </div>
        </div>
        <TravelReportRehearsal
          rewrite={report.rewrites[0] ?? null}
          grammarFrame={report.rewrites.length ? null : (report.grammarFrames[0] ?? null)}
        />
        {report.rewrites.length ? (
          report.rewrites.slice(1).map((item, index) => (
            <article key={`${item.natural}-${index}`}>
              <small>{item.type}</small>
              <del>{item.original}</del>
              <strong>{item.natural}</strong>
              <p>{item.explanation}</p>
            </article>
          ))
        ) : (
          <p className="empty-note">
            这次没有需要集中纠正的表达。换一个变体再练，看看能不能依然自然完成。
          </p>
        )}
      </section>
      <section className="report-bottom">
        <article>
          <h2>最值得带走的句子骨架</h2>
          {visibleGrammarFrames.map((item) => (
            <div key={item.natural}>
              <span>{item.intent}</span>
              <b>{item.natural}</b>
              <p>{item.explanation}</p>
            </div>
          ))}
        </article>
        <article>
          <h2>加入个人生词本</h2>
          {report.vocabulary.length ? (
            report.vocabulary.map((item) => (
              <button key={item.text} onClick={() => onSave(item)}>
                <span>
                  <b>{item.text}</b>
                  <small>{item.meaning}</small>
                </span>
                <BookMarked />
              </button>
            ))
          ) : (
            <p>本次没有新的候选表达。</p>
          )}
        </article>
      </section>
      <footer>
        <button onClick={onDone}>回到场景地图</button>
        <button className="travel-primary" onClick={onAgain}>
          <RefreshCcw /> 换个变化再练
        </button>
      </footer>
    </div>
  );
}

function TravelLoading({ onBack }: { onBack: () => void }) {
  return (
    <DashboardPageLoading
      page="travel"
      title="场景口语"
      label="正在读取场景口语…"
      onBack={onBack}
    />
  );
}
function PlusMark() {
  return <span aria-hidden="true">＋</span>;
}
function confidenceText(value?: Profile['confidence']) {
  return value === 'HIGH' ? '高置信度' : value === 'MEDIUM' ? '中等置信度' : '继续收集证据';
}
function historyDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '日期未知'
    : date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}
function scenarioOutcomeLabel(outcome: Report['outcome']) {
  if (outcome === 'SUCCESS') return '沟通目标已完成';
  if (outcome === 'PARTIAL') return '完成了部分目标';
  return '还可以继续练习';
}
function dimensionLabel(value: string) {
  return (
    (
      {
        vocabulary: '词汇识别',
        grammar: '语法控制',
        sentenceBuilding: '句子组装',
        taskCompletion: '场景回应',
        naturalness: '自然表达',
        expression: '自由表达',
      } as Record<string, string>
    )[value] ?? '综合能力'
  );
}
