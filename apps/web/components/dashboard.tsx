'use client';

import {
  ArrowLeft,
  AlertTriangle,
  BarChart3,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleX,
  Check,
  CircleHelp,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Flame,
  Grid2X2,
  LayoutList,
  ListRestart,
  LogOut,
  Menu,
  Pause,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  TimerReset,
  ToggleLeft,
  Trophy,
  Trash2,
  Undo2,
  UserRound,
  Volume2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import { StatisticsPage } from './statistics-page';
import { SystemSettings } from './system-settings';

type ExerciseType =
  | 'WORD_MNEMONIC'
  | 'MEANING_RECOGNITION'
  | 'WORD_MATCHING'
  | 'SYNONYM_REPLACEMENT'
  | 'READING_COMPREHENSION';
type GeneratedQuestion = {
  bookWordId: string;
  type: ExerciseType;
  prompt: string;
  options: string[];
  correctAnswers: string[];
  explanation: string;
  optionNotes?: string[];
  pairs?: Array<{ left: string; right: string }>;
};
type ReadingSentence = { english: string; chinese: string; simplified: string };
type GeneratedGroup = {
  index: number;
  title: string;
  wordOccurrences: Record<string, number>;
  sentences: ReadingSentence[];
  questions: GeneratedQuestion[];
};
type Word = {
  id?: string;
  word: string;
  part: string;
  meaning: string;
  state?: 'review';
  source?: 'NEW' | 'REVIEW';
  groupIndex?: number;
  question?: GeneratedQuestion;
  completed?: boolean;
  result?: boolean;
};
type DashboardWords = { defaultNewWordCount: number; reviewWords: Word[]; newWords: Word[] };
type MasteredWord = Word & { id: string; masteredAt: string };
type StudyMode = 'group' | 'individual' | 'exam';
type LearningPlan = {
  id: string;
  mode: StudyMode;
  wordCount: number;
  words: Word[];
  completed: number;
  groupCount: number;
  content?: { groups: GeneratedGroup[] } | null;
  generationError?: string | null;
  summary?: {
    totalQuestions: number;
    correctQuestions: number;
    durationSeconds: number;
    typeStats: Array<{ type: string; total: number; correct: number }>;
  };
  status: 'GENERATING' | 'ACTIVE' | 'COMPLETED' | 'FAILED';
  createdAt: string;
};
type LearningWord = Omit<Word, 'state'> & {
  state: 'LEARNING' | 'REVIEWING';
  accuracy: number;
  reinforcement: string;
  reviewCount: number;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  bookTitle: string;
};
type VocabularyBookCard = {
  id: string;
  category: string;
  categoryLabel: string;
  title: string;
  publisher: string | null;
  grade: string | null;
  totalWords: number;
  learnedWords: number;
  isLearning: boolean;
  isDefault: boolean;
};
type VocabularyCatalog = {
  categories: Array<{ key: string; label: string; count: number }>;
  books: VocabularyBookCard[];
};
const GROUP_WORD_LIMIT = 3;
const WORD_TONES = [
  { background: '#d8ebff', color: '#0b3a85' },
  { background: '#ffd9d2', color: '#9b1c1c' },
  { background: '#e8dcff', color: '#481388' },
  { background: '#d8f3dd', color: '#17613a' },
  { background: '#ffe9b6', color: '#875000' },
] as const;

function splitPlanWords(words: Word[]) {
  const indexes = [...new Set(words.map((word, index) => word.groupIndex ?? Math.floor(index / GROUP_WORD_LIMIT)))];
  return indexes.map((groupIndex) =>
    words.filter((word, index) => (word.groupIndex ?? Math.floor(index / GROUP_WORD_LIMIT)) === groupIndex),
  );
}
function wordTone(index: number) {
  const tone = WORD_TONES[index % WORD_TONES.length];
  return { '--word-bg': tone.background, '--word-color': tone.color } as React.CSSProperties;
}
function exerciseType(index: number) {
  return index === 0 ? '单词匹配' : index === 1 ? '同义替换' : '词义辨析';
}
function articleOccurrenceCount(index: number, total: number) {
  return index === total - 1 ? 3 : 2;
}
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        fill="currentColor"
        d="M211.456 317.253818l227.746909-215.831273a68.375273 68.375273 0 0 1 93.509818 21.317819 66.373818 66.373818 0 0 1 10.333091 35.514181v707.723637a67.444364 67.444364 0 0 1-67.863273 67.025454 68.561455 68.561455 0 0 1-35.979636-10.193454l-227.746909-216.110546H133.911273a94.440727 94.440727 0 0 1-94.999273-93.835636V411.089455a94.440727 94.440727 0 0 1 94.999273-93.835637z m33.233455 74.472727a41.146182 41.146182 0 0 1-21.597091 6.097455H133.911273a13.498182 13.498182 0 0 0-13.591273 13.405091v201.774545a13.498182 13.498182 0 0 0 13.591273 13.405091h89.181091a41.146182 41.146182 0 0 1 21.597091 6.097455l216.901818 209.128727V182.411636z m565.154909 524.474182a41.099636 41.099636 0 0 1-57.576728-0.977454 39.842909 39.842909 0 0 1 0.977455-56.878546 473.972364 473.972364 0 0 0 0-692.782545 39.842909 39.842909 0 0 1-0.977455-56.878546 41.099636 41.099636 0 0 1 57.576728-0.977454 553.890909 553.890909 0 0 1 0 808.448m-136.052364-160.581818a41.099636 41.099636 0 0 1-57.716364-1.303273 39.889455 39.889455 0 0 1 1.582546-56.832 249.669818 249.669818 0 0 0 0-370.548364 39.889455 39.889455 0 0 1-1.582546-57.018182 41.099636 41.099636 0 0 1 57.576728-1.536 329.402182 329.402182 0 0 1 0 487.33091z"
      />
    </svg>
  );
}
function appendSpeakerIcon(button: HTMLButtonElement) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.setAttribute('class', 'reading-speaker-icon');
  svg.setAttribute('viewBox', '0 0 1024 1024');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute(
    'd',
    'M211.456 317.253818l227.746909-215.831273a68.375273 68.375273 0 0 1 93.509818 21.317819 66.373818 66.373818 0 0 1 10.333091 35.514181v707.723637a67.444364 67.444364 0 0 1-67.863273 67.025454 68.561455 68.561455 0 0 1-35.979636-10.193454l-227.746909-216.110546H133.911273a94.440727 94.440727 0 0 1-94.999273-93.835636V411.089455a94.440727 94.440727 0 0 1 94.999273-93.835637z m33.233455 74.472727a41.146182 41.146182 0 0 1-21.597091 6.097455H133.911273a13.498182 13.498182 0 0 0-13.591273 13.405091v201.774545a13.498182 13.498182 0 0 0 13.591273 13.405091h89.181091a41.146182 41.146182 0 0 1 21.597091 6.097455l216.901818 209.128727V182.411636z m565.154909 524.474182a41.099636 41.099636 0 0 1-57.576728-0.977454 39.842909 39.842909 0 0 1 0.977455-56.878546 473.972364 473.972364 0 0 0 0-692.782545 39.842909 39.842909 0 0 1-0.977455-56.878546 41.099636 41.099636 0 0 1 57.576728-0.977454 553.890909 553.890909 0 0 1 0 808.448m-136.052364-160.581818a41.099636 41.099636 0 0 1-57.716364-1.303273 39.889455 39.889455 0 0 1 1.582546-56.832 249.669818 249.669818 0 0 0 0-370.548364 39.889455 39.889455 0 0 1-1.582546-57.018182 41.099636 41.099636 0 0 1 57.576728-1.536 329.402182 329.402182 0 0 1 0 487.33091z',
  );
  svg.append(path);
  button.replaceChildren(svg);
}

const reviewWords: Word[] = [
  {
    word: 'business',
    part: 'n.',
    meaning: '商业；买卖；生意｜职业；行业｜企业；公司｜事情；事务',
    state: 'review',
  },
  { word: 'help', part: 'vt.', meaning: '帮助，协助｜改善，促进｜避免，防止', state: 'review' },
  { word: 'market', part: 'n.', meaning: '市场；集市｜需求；销路｜交易', state: 'review' },
  { word: 'policy', part: 'n.', meaning: '政策；方针｜保险单｜策略', state: 'review' },
  { word: 'public', part: 'adj.', meaning: '公众的；公共的｜公开的', state: 'review' },
  { word: 'report', part: 'n.', meaning: '报告；报道｜成绩单｜传闻', state: 'review' },
  { word: 'result', part: 'n.', meaning: '结果；后果｜成果；成绩', state: 'review' },
  { word: 'service', part: 'n.', meaning: '服务；公共事业｜服役', state: 'review' },
  { word: 'system', part: 'n.', meaning: '系统；体系｜制度；方法', state: 'review' },
  { word: 'value', part: 'n.', meaning: '价值；重要性｜价值观', state: 'review' },
  { word: 'world', part: 'n.', meaning: '世界；领域｜世人；社会', state: 'review' },
  { word: 'write', part: 'v.', meaning: '写；书写｜写信；编写', state: 'review' },
];
const newWords: Word[] = [
  {
    word: 'health',
    part: 'n.',
    meaning: '健康；康健｜（人的）健康状况｜（组织、系统等的）运行状况',
  },
  { word: 'view', part: 'n.', meaning: '查看，观察｜观点，看法｜景色，风景' },
  { word: 'first', part: 'adj.', meaning: '第一的；最早的；首要的｜一流的；最重要的' },
  { word: 'click', part: 'vt.', meaning: '使发出咔嗒声｜点击' },
  { word: 'like', part: 'vt.', meaning: '喜欢；喜爱｜希望；想要' },
  { word: 'find', part: 'vt.', meaning: '找到；发现｜（经历后）获得；得到' },
  { word: 'learn', part: 'vt.', meaning: '学习；得知｜记住；学会' },
  { word: 'practice', part: 'n.', meaning: '练习；实践｜惯例；做法' },
  { word: 'remember', part: 'vt.', meaning: '记得；牢记｜代为问候' },
  { word: 'review', part: 'n.', meaning: '复习；回顾｜评论；检讨' },
  { word: 'study', part: 'n.', meaning: '学习；研究｜书房；课题' },
  { word: 'understand', part: 'vt.', meaning: '理解；明白｜获悉；听说' },
];

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState<'words' | 'plan' | 'history'>('words');
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [previewPlan, setPreviewPlan] = useState<LearningPlan | null>(null);
  const [lessonPlanId, setLessonPlanId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bookPickerOpen, setBookPickerOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [page, setPage] = useState<'study' | 'learning' | 'mastered' | 'statistics' | 'settings'>(
    'study',
  );
  const [settingsSection, setSettingsSection] = useState<'account' | 'system'>('account');
  const [currentBook, setCurrentBook] = useState<{
    id: string;
    title: string;
    totalWords: number;
  } | null>(null);
  const [progressSummary, setProgressSummary] = useState({ totalWords: 0, masteredWords: 0, progress: 0 });
  const [progressRevision, setProgressRevision] = useState(0);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const name = session.user.displayName || session.user.email.split('@')[0];
  const closeBookPicker = useCallback(() => setBookPickerOpen(false), []);

  useEffect(() => {
    request<{ id: string; title: string; totalWords: number } | null>(
      '/vocabulary/default',
      {},
      session.accessToken,
    )
      .then(setCurrentBook)
      .catch(() => setCurrentBook(null));
  }, [session.accessToken]);

  useEffect(() => {
    request<{ totalWords: number; masteredWords: number; progress: number }>(
      '/vocabulary/progress-summary',
      {},
      session.accessToken,
    ).then(setProgressSummary).catch(() => setProgressSummary({ totalWords: 0, masteredWords: 0, progress: 0 }));
  }, [session.accessToken, plans, progressRevision]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    request<LearningPlan[]>('/study/plans', {}, session.accessToken)
      .then(setPlans)
      .catch(() => setPlans([]));
  }, [session.accessToken]);

  return (
    <main className="study-app">
      <aside className={`study-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="sidebar-account-wrap" ref={accountMenuRef}>
          <button
            className="sidebar-book"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-expanded={accountMenuOpen}
          >
            <Avatar />
            <div>
              <strong>{name}</strong>
              <span>{currentBook?.title ?? '请选择词表'}</span>
            </div>
            <ChevronDown size={15} />
          </button>
          {accountMenuOpen && (
            <AccountMenu
              name={name}
              isAdmin={session.user.role === 'ADMIN'}
              onSettings={() => {
                setSettingsSection('account');
                setPage('settings');
                setAccountMenuOpen(false);
                setSidebarOpen(false);
              }}
              onSystemSettings={() => {
                setSettingsSection('system');
                setPage('settings');
                setAccountMenuOpen(false);
                setSidebarOpen(false);
              }}
              onLogout={onLogout}
            />
          )}
        </div>
        <Calendar />
        <nav className="sidebar-nav" aria-label="主导航">
          <span className="nav-label">APP</span>
          <button
            className={`nav-item nav-button ${page === 'study' ? 'active' : ''}`}
            onClick={() => {
              setPage('study');
              setSidebarOpen(false);
            }}
          >
            <BookOpen size={16} />
            <span>词环</span>
          </button>
          <div className="nav-group">
            <a className="nav-item" href="#words">
              <BookOpen size={16} />
              <span>我的单词</span>
              <ChevronDown size={14} />
            </a>
            <div className="nav-children">
              <button
                className={page === 'learning' ? 'active' : ''}
                onClick={() => {
                  setPage('learning');
                  setSidebarOpen(false);
                }}
              >
                学习中
              </button>
              <button
                className={page === 'mastered' ? 'active' : ''}
                onClick={() => {
                  setPage('mastered');
                  setSidebarOpen(false);
                }}
              >
                已掌握
              </button>
            </div>
          </div>
          <button
            className={`nav-item nav-button ${page === 'statistics' ? 'active' : ''}`}
            onClick={() => {
              setPage('statistics');
              setSidebarOpen(false);
            }}
          >
            <BarChart3 size={16} />
            <span>学习统计</span>
          </button>
          <button
            className={`nav-item nav-button ${page === 'settings' ? 'active' : ''}`}
            onClick={() => {
              setSettingsSection('account');
              setPage('settings');
              setSidebarOpen(false);
            }}
          >
            <Settings2 size={16} />
            <span>账户设置</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="switch-book" onClick={() => setBookPickerOpen(true)}>
            <Plus size={15} />
            切换词汇表
          </button>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭菜单"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <section className="study-shell">
        <header className="study-topbar">
          <button
            className="menu-trigger"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开菜单"
          >
            <Menu size={19} />
          </button>
          <span className="topbar-brand">
            <BookOpen size={15} /> Lexloop · 词环
          </span>
          <div className="topbar-actions">
            <button
              className="topbar-account"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-label="账户菜单"
            >
              <Avatar />
              <span>{name}</span>
              <ChevronDown size={15} />
            </button>
          </div>
        </header>
        {page === 'study' && lessonPlanId !== null ? (
          <GeneratedStudyPage
            plan={plans.find((plan) => plan.id === lessonPlanId) ?? null}
            session={session}
            onBack={() => setLessonPlanId(null)}
            onPlanUpdated={(updated) =>
              setPlans((current) =>
                current.map((plan) =>
                  plan.id === updated.id ? { ...updated, mode: plan.mode } : plan,
                ),
              )
            }
          />
        ) : page === 'study' ? (
          <div className="study-content">
            <h1>学习进度</h1>
            <section className="progress-grid">
              <StreakCard />
              <Metric
                title="词表总词数"
                value={String(currentBook?.totalWords ?? 0)}
                detail={currentBook?.title ?? '请选择一个系统词表'}
                backIcon={<BookOpen size={42} />}
                backText="海量词库等你探索"
                backColor="var(--sky)"
              />
              <Metric
                title="已掌握词数"
                value={String(progressSummary.masteredWords)}
                detail={`学习进度 ${progressSummary.progress.toFixed(1)}%`}
                backIcon={<Flame size={42} />}
                backText="千里之行始于足下"
                backColor="var(--coral)"
              />
            </section>

            <div className="learning-tabs" role="tablist" aria-label="学习内容">
              <button
                role="tab"
                aria-selected={activeTab === 'words'}
                className={activeTab === 'words' ? 'active' : ''}
                onClick={() => setActiveTab('words')}
              >
                单词列表
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'plan'}
                className={activeTab === 'plan' ? 'active' : ''}
                onClick={() => setActiveTab('plan')}
              >
                当前学习序列
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'history'}
                className={activeTab === 'history' ? 'active' : ''}
                onClick={() => setActiveTab('history')}
              >
                今日学习历史
              </button>
            </div>
            {activeTab === 'words' && (
              <WordsPanel
                session={session}
                onCreatePlan={(plan) => setPreviewPlan(plan)}
                onProgressChanged={() => setProgressRevision((current) => current + 1)}
              />
            )}
            {activeTab === 'plan' && (
              <PlanPanel
                plan={plans.find((plan) => plan.status === 'ACTIVE' || plan.status === 'GENERATING') ?? null}
                onContinue={(id) => setLessonPlanId(id)}
              />
            )}
            {activeTab === 'history' && (
              <LearningHistory
                plans={plans}
                onContinue={(id) => setLessonPlanId(id)}
                onRetry={setPreviewPlan}
              />
            )}
          </div>
        ) : page === 'learning' ? (
          <LearningWordsPage session={session} onBack={() => setPage('study')} />
        ) : page === 'mastered' ? (
          <MasteredWordsPage
            session={session}
            onBack={() => setPage('study')}
            onProgressChanged={() => setProgressRevision((current) => current + 1)}
          />
        ) : page === 'statistics' ? (
          <StatisticsPage session={session} onBack={() => setPage('study')} />
        ) : (
          <AccountSettings
            session={session}
            initialSection={settingsSection}
            onBack={() => setPage('study')}
            onLearningReset={() => {
              setPlans([]);
              setPreviewPlan(null);
              setLessonPlanId(null);
              setProgressRevision((current) => current + 1);
            }}
          />
        )}
      </section>
      {bookPickerOpen && (
        <BookPicker session={session} onClose={closeBookPicker} onActivated={setCurrentBook} />
      )}
      {previewPlan && (
        <PlanPreview
          plan={previewPlan}
          session={session}
          onPlanUpdated={(updated) => {
            setPreviewPlan(updated);
            setPlans((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
          }}
          onClose={() => setPreviewPlan(null)}
          onStart={() => {
            setPlans((current) => [
              { ...previewPlan },
              ...current.filter((plan) => plan.id !== previewPlan.id),
            ]);
            setPreviewPlan(null);
            setLessonPlanId(previewPlan.id);
          }}
        />
      )}
    </main>
  );
}

function Avatar() {
  return (
    <span className="profile-avatar" aria-hidden="true">
      <i />
      <b />
    </span>
  );
}

function MasteredWordsPage({
  session,
  onBack,
  onProgressChanged,
}: {
  session: Session;
  onBack: () => void;
  onProgressChanged: () => void;
}) {
  const [words, setWords] = useState<MasteredWord[]>([]);
  const [message, setMessage] = useState('');
  const [removingId, setRemovingId] = useState<string>();
  useEffect(() => {
    request<MasteredWord[]>('/vocabulary/mastered', {}, session.accessToken)
      .then(setWords)
      .catch((error) => setMessage(error instanceof Error ? error.message : '已掌握单词加载失败'));
  }, [session.accessToken]);
  const removeMastered = async (word: MasteredWord) => {
    setRemovingId(word.id);
    setMessage('');
    try {
      await request(`/vocabulary/mastered/${word.id}`, { method: 'DELETE' }, session.accessToken);
      setWords((current) => current.filter((item) => item.id !== word.id));
      onProgressChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '移除已掌握失败');
    } finally {
      setRemovingId(undefined);
    }
  };
  return (
    <section className="mastered-page">
      <button className="mastered-back" onClick={onBack}>
        <ArrowLeft size={17} />
        返回学习进度
      </button>
      <header className="mastered-heading">
        <div>
          <p>MY WORDS</p>
          <h1>已掌握</h1>
          <span>这些单词已从所有词书的新词候选中排除。</span>
        </div>
        <div className="mastered-count">
          <CheckCircle2 size={24} />
          <b>{words.length}</b>
          <span>词</span>
        </div>
      </header>
      {message && <p className="book-message">{message}</p>}
      {!message && !words.length && (
        <div className="mastered-empty">
          <CheckCircle2 size={34} />
          <strong>还没有已掌握的单词</strong>
          <p>在新单词列表中点击“标记掌握”，它就会出现在这里。</p>
          <button onClick={onBack}>去学习单词</button>
        </div>
      )}
      {words.length > 0 && (
        <div className="mastered-list">
          {words.map((word) => (
            <article key={word.id}>
              <div>
                <strong>{word.word}</strong>
                <p>
                  {word.part && <span>{word.part}</span>}
                  {word.meaning}
                </p>
              </div>
              <div className="mastered-word-actions">
                <time dateTime={word.masteredAt}>已掌握</time>
                <button onClick={() => void removeMastered(word)} disabled={removingId === word.id}>
                  <Undo2 size={14} />
                  {removingId === word.id ? '移除中' : '移除'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LearningWordsPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [words, setWords] = useState<LearningWord[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    request<LearningWord[]>('/vocabulary/learning-words', {}, session.accessToken)
      .then(setWords)
      .catch((error) => setMessage(error instanceof Error ? error.message : '学习中单词加载失败'));
  }, [session.accessToken]);
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(
          new Date(value),
        )
      : '尚未复习';
  return (
    <section className="learning-words-page">
      <button className="mastered-back" onClick={onBack}>
        <ArrowLeft size={17} />
        返回学习进度
      </button>
      <header className="mastered-heading">
        <div>
          <p>MY WORDS</p>
          <h1>学习中</h1>
          <span>所有学习中词书里，尚未标记掌握的单词。</span>
        </div>
        <div className="mastered-count">
          <BookOpen size={24} />
          <b>{words.length}</b>
          <span>词</span>
        </div>
      </header>
      {message && <p className="book-message">{message}</p>}
      {!message && !words.length && (
        <div className="mastered-empty">
          <BookOpen size={34} />
          <strong>还没有学习中的单词</strong>
          <p>创建学习计划或将新单词加入复习后，会在这里追踪学习表现。</p>
          <button onClick={onBack}>去学习单词</button>
        </div>
      )}
      {words.length > 0 && (
        <div className="learning-word-table">
          <header>
            <span>单词</span>
            <span>状态</span>
            <span>正确率</span>
            <span>上次复习</span>
            <span>下次复习</span>
          </header>
          {words.map((word) => (
            <article key={word.id}>
              <div>
                <strong>{word.word}</strong>
                <p>
                  {word.part && <b>{word.part}</b>}
                  {word.meaning}
                  <small>{word.bookTitle}</small>
                </p>
              </div>
              <span
                className={`learning-state ${word.state === 'REVIEWING' ? 'is-reviewing' : ''}`}
              >
                {word.state === 'REVIEWING' ? '复习中' : '学习中'}
                <em>{word.reinforcement}</em>
              </span>
              <b>{word.accuracy}%</b>
              <time>{date(word.lastReviewedAt)}</time>
              <time>{date(word.nextReviewAt)}</time>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const checkInBursts = [
  { x: '-104px', y: '-48px', turn: '-28deg', delay: '0ms' },
  { x: '-66px', y: '-94px', turn: '-16deg', delay: '35ms' },
  { x: '-16px', y: '-112px', turn: '12deg', delay: '10ms' },
  { x: '44px', y: '-92px', turn: '34deg', delay: '45ms' },
  { x: '98px', y: '-40px', turn: '58deg', delay: '0ms' },
  { x: '106px', y: '34px', turn: '75deg', delay: '28ms' },
  { x: '52px', y: '84px', turn: '104deg', delay: '15ms' },
  { x: '-12px', y: '98px', turn: '132deg', delay: '52ms' },
  { x: '-72px', y: '68px', turn: '158deg', delay: '20ms' },
  { x: '-112px', y: '14px', turn: '188deg', delay: '40ms' },
] as const;

function StreakCard() {
  const [burst, setBurst] = useState(0);
  const [celebrating, setCelebrating] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);

  const celebrate = () => {
    setCheckedIn(true);
    setBurst((value) => value + 1);
    setCelebrating(true);
  };

  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(() => setCelebrating(false), 800);
    return () => window.clearTimeout(timer);
  }, [burst, celebrating]);

  return (
    <div className="streak-card-wrap">
      <article className="streak-card">
        <div className="streak-front">
          <div className="streak-content">
            <div className="card-heading">
              <strong>学习连胜</strong>
              <Trophy size={18} />
              <CheckCircle2 size={18} />
            </div>
            <p>
              每天坚持学习，就能持续积累「连胜」
              <br />
              你的「词汇量」和「外语水平」将迎来显著突破！
            </p>
          </div>
          <div className="streak-count">
            <b>0</b>
            <Flame size={26} />
            <small>Today</small>
          </div>
        </div>
        <div className="streak-back">
          <button
            className={`check-in-btn ${celebrating ? 'is-celebrating' : ''}`}
            onClick={celebrate}
            aria-label={checkedIn ? '已打卡，再次播放庆祝动画' : '立刻打卡'}
          >
            <CheckCircle2 size={32} />
            <span>{checkedIn ? '打卡成功' : '立刻打卡'}</span>
            <span className="sr-only" aria-live="polite">
              {checkedIn ? '打卡成功，星星正在绽放' : ''}
            </span>
          </button>
        </div>
      </article>
      {celebrating && (
        <span className="check-in-burst" aria-hidden="true" key={burst}>
          {checkInBursts.map((star, index) => (
            <i
              key={index}
              style={
                {
                  '--burst-x': star.x,
                  '--burst-y': star.y,
                  '--burst-turn': star.turn,
                  '--burst-delay': star.delay,
                } as React.CSSProperties
              }
            >
              ✦
            </i>
          ))}
        </span>
      )}
    </div>
  );
}

function AccountMenu({
  name,
  isAdmin,
  onSettings,
  onSystemSettings,
  onLogout,
}: {
  name: string;
  isAdmin: boolean;
  onSettings: () => void;
  onSystemSettings: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="account-menu">
      <div className="account-menu-user">
        <Avatar />
        <strong>{name}</strong>
      </div>
      <button onClick={onSettings}>
        <Settings2 size={22} />
        账户设置
      </button>
      {isAdmin && (
        <button onClick={onSystemSettings}>
          <ToggleLeft size={22} />
          系统设置
        </button>
      )}
      <button onClick={onLogout}>
        <LogOut size={22} />
        退出登录
      </button>
    </div>
  );
}

function BookPicker({
  session,
  onClose,
  onActivated,
}: {
  session: Session;
  onClose: () => void;
  onActivated: (book: { id: string; title: string; totalWords: number }) => void;
}) {
  const [tab, setTab] = useState<'learning' | 'mine' | 'system'>('learning');
  const [catalog, setCatalog] = useState<VocabularyCatalog>({ categories: [], books: [] });
  const [learning, setLearning] = useState<VocabularyBookCard[]>([]);
  const [category, setCategory] = useState<string>();
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = async (selectedCategory?: string) => {
    try {
      const [nextCatalog, nextLearning] = await Promise.all([
        request<VocabularyCatalog>(
          `/vocabulary/system${selectedCategory ? `?category=${selectedCategory}` : ''}`,
          {},
          session.accessToken,
        ),
        request<VocabularyBookCard[]>('/vocabulary/learning', {}, session.accessToken),
      ]);
      setCatalog(nextCatalog);
      setLearning(nextLearning);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '词表加载失败');
    }
  };
  const loadCatalog = async (selectedCategory?: string) => {
    try {
      setCatalog(
        await request<VocabularyCatalog>(
          `/vocabulary/system${selectedCategory ? `?category=${selectedCategory}` : ''}`,
          {},
          session.accessToken,
        ),
      );
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '词表加载失败');
    }
  };
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    void load();
    return () => document.removeEventListener('keydown', closeOnEscape);
    // The dialog is intentionally loaded once per opening; category switches call load explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, session.accessToken]);
  const activate = async (book: VocabularyBookCard, action: 'start' | 'continue') => {
    setBusyId(book.id);
    try {
      const active = await request<{ id: string; title: string; totalWords: number }>(
        `/vocabulary/books/${book.id}/${action}`,
        { method: 'POST' },
        session.accessToken,
      );
      setLearning((current) => {
        const selected = { ...book, isLearning: true, isDefault: true };
        const withUpdatedDefault = current.map((item) => ({
          ...item,
          isDefault: item.id === book.id,
        }));
        return current.some((item) => item.id === book.id)
          ? withUpdatedDefault
          : [...withUpdatedDefault, selected];
      });
      if (action === 'start') {
        setTab('learning');
        await loadCatalog(category);
      }
      onActivated(active);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新学习词表失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="book-drawer" role="dialog" aria-modal="true" aria-label="选择词表">
      <header>
        <div>
          <h2>选择词表</h2>
          <p>请选择一个词表开始您的学习之旅。</p>
        </div>
        <button onClick={onClose} aria-label="关闭">
          <X size={23} />
        </button>
      </header>
      <div className="book-tabs">
        <button className={tab === 'learning' ? 'active' : ''} onClick={() => setTab('learning')}>
          学习中（{learning.length}）
        </button>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          我的词表
        </button>
        <button className={tab === 'system' ? 'active' : ''} onClick={() => setTab('system')}>
          系统词表（{catalog.categories.reduce((sum, item) => sum + item.count, 0)}）
        </button>
      </div>
      {message && <p className="book-message">{message}</p>}
      {tab === 'learning' && (
        <BookCards
          cards={learning}
          busyId={busyId}
          showProgress
          onActivate={(book) => activate(book, 'continue')}
        />
      )}
      {tab === 'mine' && (
        <div className="book-empty">
          <strong>我的词表</strong>
          <p>自建词表功能即将开放</p>
        </div>
      )}
      {tab === 'system' && (
        <div className="book-system">
          <h3>系统词表</h3>
          <p>按学习阶段与目标选择，无需额外筛选教材版本。</p>
          <div className="book-category-tabs" role="tablist" aria-label="词表分类">
            {catalog.categories.map((item) => (
              <button
                key={item.key}
                role="tab"
                aria-selected={category === item.key}
                className={category === item.key ? 'active' : ''}
                onClick={() => {
                  const next = category === item.key ? undefined : item.key;
                  setCategory(next);
                  void loadCatalog(next);
                }}
              >
                {item.label}
                <b>{item.count}</b>
              </button>
            ))}
          </div>
          <BookCards
            cards={catalog.books}
            busyId={busyId}
            onActivate={(book) => activate(book, 'start')}
          />
        </div>
      )}
    </div>
  );
}

function BookCards({
  cards,
  busyId,
  showProgress = false,
  onActivate,
}: {
  cards: VocabularyBookCard[];
  busyId: string | null;
  showProgress?: boolean;
  onActivate: (book: VocabularyBookCard) => void;
}) {
  if (!cards.length)
    return (
      <div className="book-empty">
        <strong>还没有可展示的词表</strong>
        <p>词表初始化完成后会自动显示在这里。</p>
      </div>
    );
  return (
    <div className="book-card-grid">
      {cards.map((book) => {
        const progress =
          book.totalWords > 0
            ? Math.min(100, Math.round((book.learnedWords / book.totalWords) * 100))
            : 0;
        return (
          <article className="book-choice" key={book.id}>
            <div className="book-choice-main">
              <strong title={book.title}>{book.title}</strong>
              <div
                className="book-choice-tags"
                aria-label={`教材信息：${[book.publisher, book.categoryLabel, book.grade].filter(Boolean).join('，')}，共 ${book.totalWords} 词`}
              >
                {book.publisher && <span>{book.publisher}</span>}
                <span>{book.categoryLabel}</span>
                {book.grade && <span>{book.grade}</span>}
                <span className="book-choice-count">
                  <b>{book.totalWords}</b> 词
                </span>
              </div>
              {showProgress && (
                <div className="book-choice-learning-meta">
                  <span>
                    已学 <b>{book.learnedWords}</b> 词
                  </span>
                  <span>{progress}%</span>
                </div>
              )}
              {showProgress && (
                <div
                  className="book-choice-progress"
                  role="progressbar"
                  aria-label={`${book.title}学习进度`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <i style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
            <button
              className={book.isDefault ? 'current' : ''}
              disabled={busyId === book.id || book.isDefault}
              onClick={() => onActivate(book)}
            >
              {book.isDefault ? '当前' : showProgress ? '切换' : '开始'}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function AccountSettings({
  session,
  initialSection,
  onBack,
  onLearningReset,
}: {
  session: Session;
  initialSection: 'account' | 'system';
  onBack: () => void;
  onLearningReset: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<'account' | 'system'>(initialSection);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState('');
  useEffect(() => setSection(initialSection), [initialSection]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) return setMessage('新密码至少需要 8 位。');
    if (password !== confirm) return setMessage('两次输入的密码不一致。');
    setBusy(true);
    setMessage('');
    try {
      await request(
        '/auth/password',
        { method: 'POST', body: JSON.stringify({ password }) },
        session.accessToken,
      );
      setPassword('');
      setConfirm('');
      setMessage('密码已更新。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };
  const clearLearningRecords = async () => {
    setClearing(true);
    setClearMessage('');
    try {
      await request(
        '/vocabulary/learning-records',
        { method: 'DELETE' },
        session.accessToken,
      );
      onLearningReset();
      setClearDialogOpen(false);
      setClearMessage('学习记录已全部清除，可以重新开始学习。');
    } catch (error) {
      setClearMessage(error instanceof Error ? error.message : '学习记录清理失败，请稍后重试。');
    } finally {
      setClearing(false);
    }
  };
  return (
    <div className="settings-page">
      <header className="settings-heading">
        <div>
          <button className="settings-back" onClick={onBack}>
            ← 返回学习
          </button>
          <h1>设置</h1>
          <p>管理您的账号和系统设置</p>
        </div>
        <div className="identity-card">
          <span>身份 ID（可用于客服联系问题）</span>
          <div className="identity-card-value">
            <strong>{session.user.id}</strong>
            <button
              onClick={() => navigator.clipboard?.writeText(session.user.id)}
              aria-label="复制身份 ID"
            >
              <Copy size={20} />
            </button>
          </div>
        </div>
      </header>
      <div className="settings-layout">
        <nav>
          <button
            className={section === 'account' ? 'active' : ''}
            onClick={() => setSection('account')}
          >
            <UserRound size={19} />
            账号设置
          </button>
          {session.user.role === 'ADMIN' && (
            <button
              className={section === 'system' ? 'active' : ''}
              onClick={() => setSection('system')}
            >
              <Settings2 size={19} />
              系统设置
            </button>
          )}
        </nav>
        {section === 'system' && session.user.role === 'ADMIN' ? (
          <SystemSettings session={session} />
        ) : (
          <section className="account-settings-content">
            <h2>账号设置</h2>
            <form className="password-card" onSubmit={save}>
              <h3>密码管理</h3>
              <p>更新您的账户密码</p>
              <label>
                新密码
                <div className="password-input">
                  <input
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <button type="button" onClick={() => setShow(!show)} aria-label="显示密码">
                    {show ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </label>
              <label>
                确认密码
                <input
                  type={show ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {message && (
                <p className={message === '密码已更新。' ? 'form-success' : 'form-error'}>
                  {message}
                </p>
              )}
              <button className="save-password" disabled={busy}>
                {busy ? '更新中…' : '更新密码'}
              </button>
            </form>
            <section className="learning-danger-zone" aria-labelledby="learning-danger-title">
              <div>
                <span>危险操作</span>
                <h3 id="learning-danger-title">清理学习记录</h3>
                <p>清除所有个人学习计划、答题结果、复习排期、学习中及已掌握单词。账号、词书、模型、偏好设置和可复用的 AI 阅读材料题库都会保留。</p>
              </div>
              <button type="button" onClick={() => {
                setClearMessage('');
                setClearDialogOpen(true);
              }}>
                <Trash2 size={18}/>
                清理学习记录
              </button>
            </section>
            {clearMessage && <p className={clearMessage.startsWith('学习记录已') ? 'settings-clear-success' : 'settings-clear-error'}>{clearMessage}</p>}
          </section>
        )}
      </div>
      {clearDialogOpen && (
        <div className="learning-clear-layer" role="dialog" aria-modal="true" aria-labelledby="learning-clear-title">
          <button className="learning-clear-scrim" aria-label="取消清理" onClick={() => !clearing && setClearDialogOpen(false)}/>
          <section className="learning-clear-dialog">
            <span className="learning-clear-icon"><AlertTriangle size={29}/></span>
            <p>DANGER ZONE</p>
            <h2 id="learning-clear-title">确认清理全部学习记录？</h2>
            <div>
              <strong>此操作无法撤销</strong>
              <span>当前学习序列、历史答题、复习时间、正确率、统计数据和已掌握状态都会被清空。</span>
              <small>账号、已添加词书、大模型配置、每日新词数量以及公共 AI 阅读材料与题目不会改变。</small>
            </div>
            {clearMessage && <p className="settings-clear-error">{clearMessage}</p>}
            <footer>
              <button type="button" className="secondary" disabled={clearing} onClick={() => setClearDialogOpen(false)}>取消</button>
              <button type="button" className="confirm-danger" disabled={clearing} onClick={() => void clearLearningRecords()}>
                <Trash2 size={17}/>
                {clearing ? '正在清理…' : '确认全部清理'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function Calendar() {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return (
    <section className="mini-calendar">
      <div className="calendar-title">
        <ChevronLeft size={15} />
        <span>July 2026</span>
        <ChevronRight size={15} />
      </div>
      <div className="calendar-grid weekdays">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {Array.from({ length: 3 }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {days.map((day) => (
          <button key={day} className={day === 22 ? 'today' : ''}>
            {day}
          </button>
        ))}
        <span className="muted-day">1</span>
      </div>
    </section>
  );
}

function Metric({
  title,
  value,
  detail,
  backIcon,
  backText,
  backColor,
}: {
  title: string;
  value: string;
  detail: string;
  backIcon?: React.ReactNode;
  backText?: string;
  backColor?: string;
}) {
  return (
    <article className="metric-card" style={{ '--back-color': backColor } as React.CSSProperties}>
      <div className="metric-front">
        <span>{title}</span>
        <b>{value}</b>
        <small>{detail}</small>
      </div>
      <div className="metric-back">
        {backIcon}
        <strong>{backText}</strong>
      </div>
    </article>
  );
}

function WordsPanel({
  session,
  onCreatePlan,
  onProgressChanged,
}: {
  session: Session;
  onCreatePlan: (plan: LearningPlan) => void;
  onProgressChanged: () => void;
}) {
  const [mode, setMode] = useState<StudyMode>('group');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawer, setDrawer] = useState<'reading' | 'exam' | null>(null);
  const [dashboardWords, setDashboardWords] = useState<DashboardWords>({
    defaultNewWordCount: 10,
    reviewWords: [],
    newWords: [],
  });
  const [displayNewWordCount, setDisplayNewWordCount] = useState<number>();
  const [message, setMessage] = useState('');
  const newWordCount = displayNewWordCount ?? dashboardWords.defaultNewWordCount;
  const loadWords = useCallback(
    async (count?: number) => {
      try {
        const query = count ? `?newWordCount=${count}` : '';
        const next = await request<DashboardWords>(
          `/vocabulary/dashboard-words${query}`,
          {},
          session.accessToken,
        );
        setDashboardWords(next);
        setDisplayNewWordCount(count ?? next.defaultNewWordCount);
        setMessage('');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '学习词汇加载失败');
      }
    },
    [session.accessToken],
  );
  useEffect(() => {
    void loadWords();
  }, [loadWords]);
  const removeNewWord = (wordId: string) => {
    setDashboardWords((current) => ({
      ...current,
      newWords: current.newWords.filter((word) => word.id !== wordId),
    }));
    setDisplayNewWordCount((current) =>
      Math.max(0, (current ?? dashboardWords.defaultNewWordCount) - 1),
    );
  };
  const reviewCount = dashboardWords.reviewWords.length;
  const totalWordCount = reviewCount + newWordCount;
  const reviewShare = totalWordCount ? `${(reviewCount / totalWordCount) * 100}%` : '0%';
  return (
    <section className="words-panel">
      <header className="panel-top">
        <div className="panel-title">
          <BookOpen size={18} />
          <strong>今日学习词汇</strong>
        </div>
        <div
          className="panel-progress"
          aria-label={`今日学习构成：待复习 ${reviewCount} 词，新单词 ${newWordCount} 词`}
        >
          <div className="panel-progress-labels">
            <span className="is-review">
              待复习 <b>{reviewCount}</b>
            </span>
            <span className="is-new">
              新单词 <b>{newWordCount}</b>
            </span>
            <strong>
              {totalWordCount}
              <small>词</small>
            </strong>
          </div>
          <div className="panel-progress-bar" aria-hidden="true">
            <b className="review" style={{ width: reviewShare }} />
            <b className="new" />
          </div>
        </div>
        <div className="toolbar">
          <button className={mode === 'group' ? 'selected' : ''} onClick={() => setMode('group')}>
            <Grid2X2 size={15} />
            分组
          </button>
          <button
            className={mode === 'individual' ? 'selected' : ''}
            onClick={() => setMode('individual')}
          >
            <LayoutList size={15} />
            独立单词
          </button>
          <button
            className={`real ${mode === 'exam' ? 'selected' : ''}`}
            onClick={() => setMode('exam')}
          >
            <span>◎</span> 真题 <em>NEW</em>
          </button>
          <button
            className="create"
            onClick={() =>
              void request<LearningPlan>(
                '/study/plans',
                {
                  method: 'POST',
                  body: JSON.stringify({ newWordCount: dashboardWords.newWords.length, mode }),
                },
                session.accessToken,
              )
                .then(onCreatePlan)
                .catch((error) => {
                  const text = error instanceof Error ? error.message : '创建学习计划失败';
                  setMessage(text);
                  if (text.includes('大模型')) setDrawer('reading');
                })
            }
            disabled={!dashboardWords.newWords.length && !dashboardWords.reviewWords.length}
          >
            <Sparkles size={15} />
            创建学习计划
          </button>
          <button
            className="mode-settings-trigger"
            aria-label={mode === 'exam' ? '真题题库设置' : '阅读材料模型设置'}
            onClick={() => setDrawer(mode === 'exam' ? 'exam' : 'reading')}
          >
            {mode === 'exam' ? <ExamBookIcon /> : <FilterSettingsIcon />}
          </button>
        </div>
      </header>
      {message && <p className="book-message">{message}</p>}
      <div className="word-columns">
        <WordColumn
          title="待复习单词"
          count={String(reviewCount)}
          icon={<ReviewWordsIcon />}
          words={dashboardWords.reviewWords.map((word) => ({ ...word, state: 'review' }))}
          onMarkMastered={async (word) => {
            if (!word.id) return;
            try {
              await request(
                `/vocabulary/words/${word.id}/master`,
                { method: 'POST' },
                session.accessToken,
              );
              await loadWords(newWordCount);
              onProgressChanged();
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '标记掌握失败');
            }
          }}
          onDefer={async (word) => {
            if (!word.id) return;
            try {
              await request(
                `/vocabulary/words/${word.id}/defer-review`,
                { method: 'POST' },
                session.accessToken,
              );
              await loadWords(newWordCount);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '稍后再学失败');
            }
          }}
        />
        <WordColumn
          title="新单词"
          count={String(dashboardWords.newWords.length)}
          icon={<NewWordsIcon />}
          words={dashboardWords.newWords}
          isNew
          onAddThree={() => void loadWords(newWordCount + 3)}
          onOpenSettings={() => setSettingsOpen(true)}
          onAddToReview={async (word) => {
            if (!word.id) return;
            try {
              await request(
                `/vocabulary/words/${word.id}/review`,
                { method: 'POST' },
                session.accessToken,
              );
              await loadWords(newWordCount);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '加入复习失败');
            }
          }}
          onMarkMastered={async (word) => {
            if (!word.id) return;
            try {
              await request(
                `/vocabulary/words/${word.id}/master`,
                { method: 'POST' },
                session.accessToken,
              );
              removeNewWord(word.id);
              onProgressChanged();
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '标记掌握失败');
            }
          }}
          onDefer={async (word) => {
            if (!word.id) return;
            try {
              await request(
                `/vocabulary/words/${word.id}/defer`,
                { method: 'POST' },
                session.accessToken,
              );
              removeNewWord(word.id);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '稍后再学失败');
            }
          }}
        />
      </div>
      {settingsOpen && (
        <NewWordSettings
          value={dashboardWords.defaultNewWordCount}
          onCancel={() => setSettingsOpen(false)}
          onSave={async (value) => {
            try {
              await request(
                '/vocabulary/dashboard-settings',
                { method: 'PATCH', body: JSON.stringify({ defaultNewWordCount: value }) },
                session.accessToken,
              );
              setSettingsOpen(false);
              await loadWords(value);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : '保存默认新词数量失败');
            }
          }}
        />
      )}
      {drawer === 'reading' && (
        <ReadingModelDrawer session={session} onClose={() => setDrawer(null)} />
      )}
      {drawer === 'exam' && <ExamLibraryDrawer onClose={() => setDrawer(null)} />}
    </section>
  );
}

function StudySettingsDrawer({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return (
    <div className="study-drawer-layer">
      <button className="study-drawer-scrim" aria-label="关闭设置" onClick={onClose} />
      <aside className="study-settings-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="关闭">
            <X size={22} />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

type AvailableAiModel = {
  id: string;
  displayName: string;
  provider: 'DEEPSEEK' | 'OPENAI_COMPATIBLE';
  model: string;
  isSelected: boolean;
};
function ReadingModelDrawer({ session, onClose }: { session: Session; onClose: () => void }) {
  const [models, setModels] = useState<AvailableAiModel[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState('');
  useEffect(() => {
    request<AvailableAiModel[]>('/ai/models', {}, session.accessToken)
      .then(setModels)
      .catch((error) => setMessage(error instanceof Error ? error.message : '模型加载失败'));
  }, [session.accessToken]);
  const select = async (id: string) => {
    setBusyId(id);
    setMessage('');
    try {
      await request(`/ai/models/${id}/select`, { method: 'PATCH' }, session.accessToken);
      setModels((items) => items.map((item) => ({ ...item, isSelected: item.id === id })));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '模型切换失败');
    } finally {
      setBusyId(undefined);
    }
  };
  return (
    <StudySettingsDrawer title="阅读材料模型" onClose={onClose}>
      <p className="drawer-intro">
        仅展示管理员在系统设置中添加并启用的模型；分组和独立单词模式会使用这里的模型生成阅读材料和练习内容。
      </p>
      {message && <p className="book-message">{message}</p>}
      {!message && !models.length && (
        <div className="model-options-empty">
          <Sparkles size={27} />
          <strong>暂时没有可用模型</strong>
          <p>请联系管理员在系统设置中添加并启用模型。</p>
        </div>
      )}
      <div className="model-options">
        {models.map((item) => (
          <button
            key={item.id}
            className={`model-option ${item.isSelected ? 'is-active' : ''}`}
            onClick={() => void select(item.id)}
            disabled={busyId === item.id}
          >
            <span className="model-icon">
              <Sparkles size={24} />
            </span>
            <span>
              <strong>{item.displayName}</strong>
              <small>
                {item.isSelected
                  ? '当前生效模型'
                  : `${item.provider === 'DEEPSEEK' ? 'DeepSeek' : 'OpenAI 兼容'} · ${item.model}`}
              </small>
            </span>
            {item.isSelected && <Check size={24} />}
          </button>
        ))}
      </div>
    </StudySettingsDrawer>
  );
}

function ExamLibraryDrawer({ onClose }: { onClose: () => void }) {
  const libraries = [
    ['CET4 真题', '2014–2025', '66 套', '11,000+ 条'],
    ['考研英语一', '2009–2023', '15 套', '2,000+ 条'],
    ['考研英语二', '2009–2024', '16 套', '2,000+ 条'],
  ];
  const [automatic, setAutomatic] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const selectLibrary = (name: string) => {
    const nextSelected = selected.includes(name)
      ? selected.filter((item) => item !== name)
      : [...selected, name];
    setSelected(nextSelected);
    setAutomatic(nextSelected.length === 0);
  };
  return (
    <StudySettingsDrawer title="真题题库设置" onClose={onClose}>
      <div className={`exam-mode-card ${automatic ? 'is-current' : ''}`}>
        <FileText size={28} />
        <div>
          <button
            className="mode-choice"
            onClick={() => {
              setAutomatic(true);
              setSelected([]);
            }}
            aria-pressed={automatic}
          >
            <i className={automatic ? 'checked' : ''} />
            <strong>自动模式</strong>
            {automatic ? <b>当前生效</b> : <small>跟随词表</small>}
            <CircleHelp size={18} />
          </button>
          <span>CET4 真题</span>
        </div>
      </div>
      <div className={`exam-mode-card ${!automatic ? 'is-current' : ''}`}>
        <FileText size={28} />
        <div className="exam-manual">
          <button
            className="mode-choice"
            onClick={() => selected.length > 0 && setAutomatic(false)}
            aria-pressed={!automatic}
          >
            <i className={!automatic ? 'checked' : ''} />
            <strong>手动模式</strong>
            {automatic ? (
              <small>勾选下方题库后切换</small>
            ) : (
              <>
                <b>当前生效</b>
                <small>已选 {selected.length}</small>
              </>
            )}
          </button>
          {!automatic && (
            <div className="selected-exam-libraries" aria-label="已选题库">
              {selected.map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
          )}
          {automatic && <p>从下方题库中勾选范围</p>}
          {libraries.map(([name, year, sets, count]) => (
            <button
              className="exam-library"
              key={name}
              onClick={() => selectLibrary(name)}
              aria-pressed={selected.includes(name)}
            >
              <i className={selected.includes(name) ? 'checked' : ''} />
              <strong>{name}</strong>
              <span>{year}</span>
              <span>{sets}</span>
              <span>{count}</span>
            </button>
          ))}
        </div>
      </div>
    </StudySettingsDrawer>
  );
}

function WordColumn({
  title,
  count,
  icon,
  words,
  isNew,
  onOpenSettings,
  onAddThree,
  onAddToReview,
  onMarkMastered,
  onDefer,
}: {
  title: string;
  count: string;
  icon: React.ReactNode;
  words: Word[];
  isNew?: boolean;
  onOpenSettings?: () => void;
  onAddThree?: () => void;
  onAddToReview?: (word: Word) => Promise<void>;
  onMarkMastered?: (word: Word) => Promise<void>;
  onDefer?: (word: Word) => Promise<void>;
}) {
  const [visibleCount, setVisibleCount] = useState(isNew ? words.length : 10);
  useEffect(() => {
    if (isNew) setVisibleCount(words.length);
  }, [isNew, words.length]);
  const hasMore = visibleCount < words.length;
  const isScrollable = visibleCount > 10;
  return (
    <div className="word-column">
      <div className={`word-column-head ${isNew ? 'is-new' : ''}`}>
        <div>
          {icon}
          <strong>{title}</strong>
          <span>{count}</span>
        </div>
        {isNew && (
          <div className="column-buttons">
            <button className="add-three-words" onClick={onAddThree}>
              <Plus size={22} />3
            </button>
            <button onClick={onOpenSettings} aria-label="新单词设置">
              <GearIcon />
            </button>
          </div>
        )}
      </div>
      <div className={`word-list ${isScrollable ? 'is-scrollable' : ''}`} aria-label={title}>
        {words.slice(0, visibleCount).map((word) => (
          <WordRow
            key={word.id ?? word.word}
            word={word}
            onAddToReview={onAddToReview}
            onMarkMastered={onMarkMastered}
            onDefer={onDefer}
          />
        ))}
        {hasMore && (
          <button
            className="load-more-words"
            onClick={() => setVisibleCount((current) => Math.min(current + 5, words.length))}
          >
            加载更多（剩余 {words.length - visibleCount} 个）
          </button>
        )}
      </div>
    </div>
  );
}

function NewWordSettings({
  value,
  onCancel,
  onSave,
}: {
  value: number;
  onCancel: () => void;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onCancel]);
  return (
    <div className="new-word-settings" role="dialog" aria-label="默认新单词数量">
      <strong>默认新单词数量（5-40个）</strong>
      <input
        type="number"
        min="5"
        max="40"
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        autoFocus
      />
      <div>
        <button onClick={onCancel}>取消</button>
        <button className="save" onClick={() => onSave(Math.min(40, Math.max(5, draft || 5)))}>
          保存
        </button>
      </div>
    </div>
  );
}

function ReviewWordsIcon() {
  return (
    <svg className="review-words-icon" viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        d="M138.752 302.592c68.608-128 201.216-237.056 360.96-237.056 255.488 0 414.208 200.704 413.696 446.464h63.488c0-315.904-210.944-506.88-477.184-506.88-185.856 0-329.216 97.792-414.208 246.784L5.12 175.616V363.52h189.952l-56.32-60.928z m331.264 230.4L322.56 659.456l42.496 42.496 168.96-147.456V258.56H471.04v274.432h-1.024z m274.432 83.968v63.488H1018.88v-63.488h-274.432z m0 401.92H1018.88v-63.488h-274.432V1018.88z m0-168.96H1018.88v-63.488h-274.432V849.92z m-147.968-169.472H680.96v-63.488h-84.48v63.488z m0 338.432H680.96v-63.488h-84.48V1018.88z m0-168.96H680.96v-63.488h-84.48V849.92z m-147.968 62.976c-152.064-17.92-275.968-107.52-355.328-292.352l-3.072-3.584H26.624c54.272 190.976 210.944 338.944 421.888 359.424 5.12.512 60.928.512 63.488 0v-63.488c-11.776 1.536-48.64 1.536-63.488 0z"
        fill="currentColor"
      />
    </svg>
  );
}

function NewWordsIcon() {
  return (
    <svg className="new-words-icon" viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        d="M140.8 204.8a38.4 38.4 0 1 1 0-76.8L883.2 128a38.4 38.4 0 1 1 0 76.8l-742.4 0z m0 230.4a38.4 38.4 0 1 1 0-76.8l384 0a38.4 38.4 0 1 1 0 76.8l-384 0zM688.4352 647.0656a25.6 25.6 0 0 1-4.8128-14.8992l0-240.3328a25.6 25.6 0 0 1 40.4992-20.8384L892.416 491.1616a25.6 25.6 0 0 1 0 41.6768l-168.2944 120.1664a25.6 25.6 0 0 1-35.6864-5.9392zM140.8 665.6a38.4 38.4 0 1 1 0-76.8l384 0a38.4 38.4 0 0 1 0 76.8l-384 0z m0 230.4a38.4 38.4 0 1 1 0-76.8L883.2 819.2a38.4 38.4 0 0 1 0 76.8l-742.4 0z"
        fill="currentColor"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg className="gear-icon" viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        d="M512 315.9c-108.3 0-196.1 87.8-196.1 196.1S403.7 708.1 512 708.1 708.1 620.3 708.1 512 620.3 315.9 512 315.9z m93.41 289.51A132.11 132.11 0 1 1 644.1 512a131.25 131.25 0 0 1-38.69 93.41zM851.37 512c0-7.13-0.23-14.33-0.69-21.54l68.83-62.15-4.73-18.69a413.07 413.07 0 0 0-45.62-110L859.29 283l-92.59 4.73a340.49 340.49 0 0 0-30.45-30.45l4.75-92.57-16.56-9.87a413.07 413.07 0 0 0-110-45.62l-18.69-4.74-62.15 68.84a336.56 336.56 0 0 0-43.08 0l-62.15-68.84-18.69 4.74a413.07 413.07 0 0 0-110 45.62L283 164.71l4.73 92.59a341.81 341.81 0 0 0-30.45 30.45L164.71 283l-9.87 16.56a413.07 413.07 0 0 0-45.62 110l-4.74 18.69 68.84 62.15c-0.46 7.21-0.69 14.41-0.69 21.54s0.23 14.33 0.69 21.54l-68.84 62.15 4.74 18.69a413.07 413.07 0 0 0 45.62 110l9.87 16.68 92.59-4.73a340.49 340.49 0 0 0 30.45 30.45L283 859.29l16.56 9.87a413.07 413.07 0 0 0 110 45.62l18.69 4.73 62.15-68.83a336.56 336.56 0 0 0 43.08 0l62.15 68.83 18.69-4.73a413.07 413.07 0 0 0 110-45.62l16.68-9.87-4.73-92.59a341.81 341.81 0 0 0 30.45-30.45l92.57 4.75 9.87-16.56a413.07 413.07 0 0 0 45.62-110l4.73-18.69-68.83-62.15c0.46-7.27 0.69-14.47 0.69-21.6z m-65.75-31.06a276.51 276.51 0 0 1 0 62.12l-1.83 16.32L847.57 617a349.88 349.88 0 0 1-24.1 58.1l-85.81-4.38-10.25 12.85a277.6 277.6 0 0 1-43.88 43.88l-12.85 10.25 4.38 85.81a349.88 349.88 0 0 1-58.1 24.1l-57.58-63.78-16.32 1.83a276.51 276.51 0 0 1-62.12 0l-16.32-1.83L407 847.57a349.88 349.88 0 0 1-58.1-24.1l4.38-85.81-12.85-10.25a277.66 277.66 0 0 1-43.89-43.88l-10.24-12.85-85.81 4.38A349 349 0 0 1 176.44 617l63.77-57.58-1.83-16.32a276.51 276.51 0 0 1 0-62.12l1.83-16.32L176.43 407a349.88 349.88 0 0 1 24.1-58.1l85.81 4.38 10.24-12.85a278.57 278.57 0 0 1 43.89-43.89l12.85-10.24-4.38-85.81a349.88 349.88 0 0 1 58.1-24.1l57.58 63.78 16.32-1.83a276.51 276.51 0 0 1 62.12 0l16.32 1.83L617 176.44a349 349 0 0 1 58.1 24.09l-4.38 85.81 12.85 10.24a277.66 277.66 0 0 1 43.88 43.89l10.25 12.85 85.81-4.38a349.88 349.88 0 0 1 24.1 58.1l-63.78 57.58z"
        fill="currentColor"
      />
    </svg>
  );
}

function FilterSettingsIcon() {
  return (
    <svg className="filter-settings-icon" viewBox="0 0 1024 1024" aria-hidden="true">
      <path d="M686.973887 582.412635l78.915922-79.63495a61.836403 61.836403 0 0 0-36.774632-104.905135l-111.866159-13.588586a1.844463 1.844463 0 0 1-1.458897-0.937863l-52.103474-98.923656c-11.045937-20.976859-32.106161-34.075672-56.511429-33.14823a61.857245 61.857245 0 0 0-54.917061 35.638776l-47.591314 101.08074a1.834042 1.834042 0 0 1-1.396373 1.04207l-111.147131 18.475892a61.815562 61.815562 0 0 0-32.054058 106.436977l82.896628 77.321556-16.537643 110.38642a61.4821 61.4821 0 0 0 25.822482 59.83563 62.076079 62.076079 0 0 0 65.785847 3.501354l98.527669-54.104248a2.209187 2.209187 0 0 1 1.979932 0l100.851485 49.706714a62.076079 62.076079 0 0 0 65.587854-6.502513 61.4821 61.4821 0 0 0 23.10268-60.929803z m-59.616795 12.879979l21.529156 109.490241c0.093786 0.489773 0.14589 0.812814-0.583559 1.385952a1.844463 1.844463 0 0 1-2.24045 0.208414l-100.851484-49.696294a62.524169 62.524169 0 0 0-57.688967 1.271325l-98.485987 54.125089a1.80278 1.80278 0 0 1-2.219608-0.114628c-0.791973-0.552297-0.75029-0.9066-0.677345-1.396373l16.568905-110.365579a61.721776 61.721776 0 0 0-19.226182-54.521075l-82.907049-77.446604a1.552684 1.552684 0 0 1 1.479739-1.18796l111.115869-18.496733a62.24281 62.24281 0 0 0 46.069892-34.7947l47.601734-101.08074a1.583946 1.583946 0 0 1 1.708994-1.04207h0.104207a1.563104 1.563104 0 0 1 1.677732 0.958704l52.103474 98.913236a62.138603 62.138603 0 0 0 47.560051 32.720982l111.845318 13.546903c0.59398 0.083366 1.19838 0.15631 1.177539 2.563491l-78.926343 79.655791a61.753038 61.753038 0 0 0-16.735636 55.302628zM512 156.831457a45.236236 45.236236 0 0 0 45.246657-45.246657V45.246657a45.246657 45.246657 0 0 0-90.493314 0v66.338143a45.246657 45.246657 0 0 0 45.246657 45.246657zM512 867.168543a45.246657 45.246657 0 0 0-45.246657 45.246657v66.338143a45.246657 45.246657 0 0 0 90.493314 0v-66.338143a45.236236 45.236236 0 0 0-45.246657-45.246657zM978.753343 466.742922h-66.338143a45.246657 45.246657 0 1 0 0 90.493314h66.338143a45.246657 45.246657 0 0 0 0-90.493314zM156.831458 512a45.246657 45.246657 0 0 0-45.246657-45.246657H45.246657a45.246657 45.246657 0 0 0 0 90.493314h66.338144a45.246657 45.246657 0 0 0 45.246657-45.246657zM795.130279 274.116378a45.069505 45.069505 0 0 0 31.991533-13.255124l46.893127-46.893127a45.246657 45.246657 0 1 0-63.983066-63.983066l-46.893127 46.893127a45.257078 45.257078 0 0 0 31.991533 77.23819zM196.878188 763.138746l-46.893127 46.893127a45.246657 45.246657 0 1 0 63.983066 63.983066l46.893127-46.893127a45.246657 45.246657 0 0 0-63.983066-63.983066zM827.121812 763.138746a45.246657 45.246657 0 0 0-63.983066 63.983066l46.893127 46.893127a45.246657 45.246657 0 0 0 63.993487-63.983066zM196.878188 260.861254a45.246657 45.246657 0 1 0 63.983066-63.993487l-46.893127-46.893127a45.253952 45.253952 0 0 0-64.003907 63.993487z" />
    </svg>
  );
}

function WordRow({
  word,
  onAddToReview,
  onMarkMastered,
  onDefer,
}: {
  word: Word;
  onAddToReview?: (word: Word) => Promise<void>;
  onMarkMastered?: (word: Word) => Promise<void>;
  onDefer?: (word: Word) => Promise<void>;
}) {
  return (
    <article className="word-row">
      <div className="word-copy">
        <strong>{word.word}</strong>
        <p>
          {word.part && <span>{word.part}</span>}
          {word.meaning}
        </p>
      </div>
      <div className="word-actions">
        {word.state === 'review' && (
          <button className="reviewing">
            <TimerReset size={14} />
            复习中
          </button>
        )}
        {!word.state && (
          <button
            aria-label="加入复习"
            data-tooltip="加入复习"
            onClick={() => void onAddToReview?.(word)}
          >
            <ListRestart size={16} />
          </button>
        )}
        <button
          aria-label="标记掌握"
          data-tooltip="标记掌握"
          onClick={() => void onMarkMastered?.(word)}
        >
          <CheckCircle2 size={16} />
        </button>
        <button aria-label="稍后再学" data-tooltip="稍后再学" onClick={() => void onDefer?.(word)}>
          <TimerReset size={16} />
        </button>
      </div>
    </article>
  );
}

function ExamBookIcon() {
  return (
    <svg className="exam-book-icon" viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        d="M658.285714 512m-182.857143 0a182.857143 182.857143 0 1 0 365.714286 0 182.857143 182.857143 0 1 0-365.714286 0Z"
        fill="#D4FD46"
      />
      <path
        d="M362.660571 149.284571H360.228571c-33.097143 0-61.622857 0-84.443428 3.072-24.484571 3.291429-47.926857 10.697143-66.962286 29.732572-19.017143 19.017143-26.441143 42.477714-29.732571 66.962286-3.072 22.838857-3.072 51.346286-3.072 84.443428v431.798857c0 72.155429 58.514286 130.651429 130.669714 130.651429H810.660571a37.339429 37.339429 0 1 0 0-74.660572H306.669714a56.009143 56.009143 0 0 1 0-112H663.771429c33.097143 0 61.622857 0 84.443428-3.072 24.484571-3.291429 47.945143-10.697143 66.962286-29.732571 19.017143-19.017143 26.441143-42.477714 29.732571-66.962286 3.072-22.820571 3.072-51.346286 3.072-84.443428V333.494857c0-33.097143 0-61.622857-3.072-84.443428-3.291429-24.466286-10.697143-47.926857-29.732571-66.962286-19.017143-19.017143-42.477714-26.441143-66.962286-29.732572-22.838857-3.072-51.346286-3.072-84.443428-3.072H362.660571z m-55.990857 485.339429a130.176 130.176 0 0 0-56.009143 12.562286v-311.222857c0-36.260571 0.091429-59.702857 2.413715-76.982858 2.176-16.182857 5.668571-21.248 8.521143-24.100571 2.852571-2.834286 7.917714-6.345143 24.118857-8.521143 17.261714-2.322286 40.704-2.413714 76.946285-2.413714h298.678858c36.242286 0 59.684571 0.091429 76.946285 2.413714 16.201143 2.176 21.266286 5.686857 24.118857 8.521143 2.834286 2.852571 6.345143 7.917714 8.521143 24.118857 2.322286 17.261714 2.413714 40.704 2.413715 76.946286v186.678857c0 36.242286-0.091429 59.684571-2.413715 76.946286-2.176 16.201143-5.668571 21.266286-8.521143 24.118857-2.852571 2.834286-7.917714 6.345143-24.118857 8.521143-17.261714 2.322286-40.704 2.413714-76.946285 2.413714H306.651429z"
        fill="currentColor"
      />
      <path
        d="M609.554286 363.190857l-3.072 91.392c0 31.488 2.56 57.984 7.68 79.488 5.376 21.504 15.232 36.352 29.568 44.544-17.664 11.008-35.584 16.512-53.76 16.512-32 0-51.712-25.856-59.136-77.568h-78.336c-4.864 16.64-7.296 29.44-7.296 38.4 0 8.704 1.024 15.744 3.072 21.12-18.944 12.032-35.84 18.048-50.688 18.048-22.784 0-34.176-13.824-34.176-41.472 0-13.824 4.224-31.232 12.672-52.224 8.704-20.992 20.096-45.056 34.176-72.192 14.336-27.136 23.424-45.056 27.264-53.76a674.102857 674.102857 0 0 0-9.6-40.704c13.312-9.216 26.112-16.128 38.4-20.736a110.555429 110.555429 0 0 1 40.32-7.296c14.592 0 24.704 3.2 30.336 9.6 14.592-6.4 26.624-9.6 36.096-9.6s16.512 1.536 21.12 4.608c4.608 3.072 7.936 7.552 9.984 13.44 3.584 10.24 5.376 23.04 5.376 38.4z m-77.184 8.832h-12.288c-23.04 44.544-40.192 79.616-51.456 105.216h59.52c0-27.904 1.408-62.976 4.224-105.216z"
        fill="currentColor"
      />
    </svg>
  );
}

const modeLabel = { group: '分组学习', individual: '单词模式', exam: '真题' } as const;

function PlanPreview({
  plan,
  session,
  onClose,
  onStart,
  onPlanUpdated,
}: {
  plan: LearningPlan;
  session: Session;
  onClose: () => void;
  onStart: () => void;
  onPlanUpdated: (plan: LearningPlan) => void;
}) {
  const [index, setIndex] = useState(0);
  const [generating, setGenerating] = useState(plan.status === 'GENERATING');
  const [generationMessage, setGenerationMessage] = useState('');
  const generationStartedRef = useRef(false);
  const word = plan.words[index] ?? newWords[index % newWords.length];
  const previous = () => setIndex((current) => Math.max(0, current - 1));
  const next = () => setIndex((current) => Math.min(plan.wordCount - 1, current + 1));

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIndex((current) => Math.min(plan.wordCount - 1, current + 1));
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [onClose, plan.wordCount]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenerationMessage('');
    try {
      const updated = await request<LearningPlan>(
        `/study/plans/${plan.id}/generate`,
        { method: 'POST' },
        session.accessToken,
      );
      onPlanUpdated(updated);
    } catch (error) {
      setGenerationMessage(error instanceof Error ? error.message : '学习计划生成失败，请重试');
    } finally {
      setGenerating(false);
    }
  }, [onPlanUpdated, plan.id, session.accessToken]);

  useEffect(() => {
    if (plan.status === 'GENERATING' && !generationStartedRef.current) {
      generationStartedRef.current = true;
      void generate();
    }
  }, [generate, plan.status]);

  useEffect(() => {
    if (plan.status !== 'GENERATING' || generating) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void request<LearningPlan[]>('/study/plans', {}, session.accessToken)
        .then((plans) => {
          if (cancelled) return;
          const updated = plans.find((item) => item.id === plan.id);
          if (updated) onPlanUpdated(updated);
        })
        .catch((error) => {
          if (!cancelled) {
            setGenerationMessage(error instanceof Error ? error.message : '学习计划状态加载失败');
          }
        });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [generating, onPlanUpdated, plan.id, plan.status, session.accessToken]);

  return (
    <div
      className="plan-preview-layer"
      role="dialog"
      aria-modal="true"
      aria-label="学习计划预习"
      aria-keyshortcuts="ArrowLeft ArrowRight Escape"
    >
      <button className="plan-preview-scrim" onClick={onClose} aria-label="关闭预习" />
      <section className="plan-preview">
        <header>
          <div>
            <p>{generating || plan.status === 'GENERATING' ? '学习计划生成中，先预习一下…' : plan.status === 'FAILED' ? '学习计划生成失败' : '学习计划生成完毕'}</p>
            <span>
              预习第 {index + 1} / {plan.wordCount} 个单词
            </span>
          </div>
          <button onClick={onClose} aria-label="关闭">
            <X size={22} />
          </button>
        </header>
        <div className="preview-progress">
          <b style={{ width: `${((index + 1) / plan.wordCount) * 100}%` }} />
        </div>
        <div className="preview-card-wrap">
          <button
            className="preview-arrow"
            onClick={previous}
            disabled={index === 0}
            aria-label="上一个单词"
          >
            <ChevronLeft size={26} />
          </button>
          <article className="preview-word-card">
            <div className="preview-word-title">
              <strong>{word.word}</strong>
              <span>New</span>
            </div>
            <div className="preview-pronunciation">
              /{word.word}/{' '}
              <button aria-label={`播放 ${word.word} 发音`}>
                <SpeakerIcon />
              </button>
            </div>
            <hr />
            <p>
              <b>{word.part}</b>
              {word.meaning}
            </p>
            <small>可使用左右方向键切换，空格键播放发音</small>
          </article>
          <button
            className="preview-arrow"
            onClick={next}
            disabled={index === plan.wordCount - 1}
            aria-label="下一个单词"
          >
            <ChevronRight size={26} />
          </button>
        </div>
        {generationMessage && <p className="book-message">{generationMessage}</p>}
        {plan.status === 'FAILED' || generationMessage ? (
          <button className="start-challenge" onClick={() => void generate()} disabled={generating}>
            <Sparkles size={19} />
            {generating ? '正在重新生成…' : '重新生成学习计划'}
          </button>
        ) : (
          <button className="start-challenge" onClick={onStart} disabled={generating || plan.status !== 'ACTIVE'}>
            <Play size={19} />
            {generating || plan.status === 'GENERATING' ? '题目生成中，请稍候' : '开始今天的挑战'}
          </button>
        )}
      </section>
    </div>
  );
}

function PlanPanel({
  plan,
  onContinue,
}: {
  plan: LearningPlan | null;
  onContinue: (id: string) => void;
}) {
  if (!plan)
    return (
      <section className="plan-empty">
        <CalendarDays size={32} />
        <strong>还没有学习序列</strong>
        <p>在单词列表中创建学习计划后，会在这里显示。</p>
      </section>
    );
  const groups = splitPlanWords(plan.words);
  const progress = Math.round((plan.completed / plan.wordCount) * 100);
  return (
    <section className="sequence-panel">
      <header className="sequence-head">
        <div>
          <BookOpen size={23} />
          <strong>学习序列</strong>
          <span>{modeLabel[plan.mode]}</span>
          <span>正常模式</span>
          <span>第 1/{groups.length} 组</span>
        </div>
        <div className="sequence-summary">
          <small>
            {plan.completed}/{plan.wordCount}
          </small>
          <b>{progress}%</b>
          <i>
            <em style={{ width: `${progress}%` }} />
          </i>
          <button onClick={() => onContinue(plan.id)} disabled={plan.status !== 'ACTIVE'}>
            {plan.status === 'GENERATING' ? <Sparkles size={18}/> : <BookOpen size={18} />}
            {plan.status === 'GENERATING' ? '题目生成中' : plan.completed === plan.wordCount ? '已完成' : '继续学习'}
          </button>
        </div>
      </header>
      <div className="sequence-body">
        <header>
          <strong>学习分组</strong>
          <span>共 {groups.length} 组</span>
          <small>New 新单词</small>
        </header>
        <div className="sequence-words">
          {groups.map((group, index) => (
            <article key={`${plan.id}-${index}`}>
              <b className={index === 0 ? 'done' : ''}>{index + 1}</b>
              <strong>{group.map((word) => word.word).join(' · ')}</strong>
              <BookOpen size={20} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SenseLevelBadge({ word }: { word: Word }) {
  const levels: Record<string, [number, string]> = {
    health: [5, 'A1'],
    view: [4, 'B1'],
    first: [3, 'B2'],
    public: [4, 'A2'],
    video: [3, 'B1'],
  };
  const [frequency, cefr] = levels[word.word] ?? [3, 'B2'];
  return (
    <span
      className={`sense-level level-${frequency}`}
      tabIndex={0}
      aria-label={`使用频率 ${frequency}/5，CEFR ${cefr}`}
    >
      <i>
        {Array.from({ length: 5 }, (_, index) => (
          <b key={index} className={index < frequency ? 'filled' : ''} />
        ))}
      </i>
      <em>{cefr}</em>
      <span className="sense-level-tooltip">
        <strong>词义级别说明</strong>
        <b>使用频率 {frequency}/5</b>
        <p>
          {frequency >= 4
            ? '高频词义，日常对话和常见阅读中经常出现。'
            : frequency >= 2
              ? '常用词义，在新闻、书籍和正式场合中稳定出现。'
              : '低频词义，适合在特定语境中重点辨认。'}
        </p>
        <b>
          CEFR 级别 <em>{cefr}</em>
        </b>
        <p>
          {cefr === 'A1'
            ? '基础入门词义，适合日常简单交流。'
            : cefr.startsWith('B')
              ? '进阶表达词义，用于更复杂的交流与阅读。'
              : '常用学习阶段词义。'}
        </p>
      </span>
    </span>
  );
}

function WordMeaningCard({ word }: { word: Word }) {
  const senses = word.meaning.split('｜');
  return (
    <section className="word-meaning-card">
      <div className="word-meaning-word">
        <span>{word.part}</span>
        <strong>{word.word}</strong>
      </div>
      <div className="meaning-senses">
        {senses.map((sense, index) => (
          <p key={sense}>
            <b>{index + 1}</b>
            {sense}
          </p>
        ))}
      </div>
      <SenseLevelBadge word={word} />
    </section>
  );
}

function WordSenseDemo() {
  return (
    <article className="exercise-card word-sense-demo">
      <span className="exercise-kind">词义识别</span>
      <h3>
        In the passage, &quot;I&apos;ve already placed an <mark>order</mark> for tickets&quot;, what
        does the word &quot;<mark>order</mark>&quot; mean here?
      </h3>
      <div className="answer-options" aria-label="词义识别演示选项">
        <button className="correct" aria-disabled="true">
          订单 <b>✓</b>
        </button>
        <button aria-disabled="true">规则</button>
        <button aria-disabled="true">顺序</button>
        <button aria-disabled="true">命令</button>
      </div>
      <strong className="answer-feedback success">✓　回答正确！</strong>
    </article>
  );
}

const SYNONYM_DEMO_OPTIONS = [
  { word: 'booking', hint: 'a reservation', correct: false },
  { word: 'library', hint: 'a place with books', correct: false },
  { word: 'volume', hint: 'a book in a set', correct: true },
  { word: 'pamphlet', hint: 'a small booklet', correct: false },
];

function SynonymDemo({ word, result, onAnswer }: { word: Word; result: boolean | undefined; onAnswer: (correct: boolean) => void }) {
  return <article className={`exercise-card synonym-demo ${result !== undefined ? 'is-answered' : ''}`}><span className="exercise-kind">同义替换</span><h3>In the sentence, &quot;Have you read that interesting <mark>book</mark> we saw at the local cultural center?&quot;, which word best replaces <mark>book</mark> without changing the original meaning?</h3><p>先观察候选词；将鼠标停在提示区，或用键盘聚焦选项后可查看词义提示。</p><div className="synonym-options" aria-label="同义替换演示选项">{SYNONYM_DEMO_OPTIONS.map(option => <button key={option.word} className={`${result !== undefined && option.correct ? 'correct' : ''} ${result !== undefined && !option.correct ? 'muted' : ''}`} aria-label={`${option.word}，提示：${option.hint}`} disabled={result !== undefined} onClick={() => onAnswer(option.correct)}><strong>{option.word}</strong><span className="synonym-hint-trigger"><i aria-hidden="true">✳</i><span className="synonym-hint-label">悬停查看提示</span><em>{option.hint}</em></span></button>)}</div>{result !== undefined && <><strong className={result ? 'answer-feedback success' : 'answer-feedback'}>{result ? '回答正确！“volume” 可指一册书。' : '回答错误，正确答案已标出。'}</strong><WordMeaningCard word={word}/></>}</article>;
}

function GroupSettlement({
  words,
  results,
  summary,
  onBack,
}: {
  words: Word[];
  results: Record<string, boolean>;
  summary?: LearningPlan['summary'];
  onBack: () => void;
}) {
  const correct = words.filter((word) => results[word.word]).length;
  const accuracy = words.length ? Math.round((correct / words.length) * 100) : 0;
  const reviewCount = words.filter((word) => word.state === 'review').length;
  const newCount = words.length - reviewCount;
  const incorrect = words.filter((word) => !results[word.word]);
  const exerciseStats: Array<[string, number, number]> = summary?.typeStats.map((item) => [
    exerciseLabels[item.type as ExerciseType] ?? item.type,
    item.correct,
    item.total,
  ]) ?? [['全部练习', correct, words.length]];
  const durationMinutes = Math.max(1, Math.round((summary?.durationSeconds ?? 0) / 60));
  return (
    <section className="group-settlement" aria-labelledby="settlement-title">
      <header className="settlement-heading">
        <div>
          <p>GROUP RECAP · 已安排复习</p>
          <h1 id="settlement-title">本组学习完成</h1>
          <span>你的练习结果已记录，接下来会在合适的时间让这些单词再回来。</span>
        </div>
        <div className="settlement-stamp">
          <Trophy size={27} />
          <b>{accuracy}%</b>
          <small>正确率</small>
        </div>
      </header>
      <div className="settlement-layout">
        <div className="settlement-main">
          <section className="settlement-overview">
            <article>
              <small>本组单词</small>
              <strong>
                {words.length}
                <em>词</em>
              </strong>
              <p>
                <b>{newCount}</b> 新单词　·　<b>{reviewCount}</b> 复习单词
              </p>
            </article>
            <article>
              <small>回答正确率</small>
              <strong>
                {accuracy}
                <em>%</em>
              </strong>
              <i>
                <b style={{ width: `${accuracy}%` }} />
              </i>
              <p>
                {correct} / {words.length} 道练习答对
              </p>
            </article>
            <article>
              <small>学习时长</small>
              <strong>
                {durationMinutes}<em>min</em>
              </strong>
              <p>保持节奏，记忆会慢慢变牢。</p>
            </article>
          </section>
          <section className="settlement-card settlement-exercises">
            <header>
              <BarChart3 size={20} />
              <h2>题目统计</h2>
            </header>
            {exerciseStats.map(([label, value, total]) => (
              <div key={String(label)}>
                <span>{label}</span>
                <i>
                  <b
                    className={value === total ? 'is-correct' : ''}
                    style={{ width: `${total ? Math.max(8, value / total * 100) : 8}%` }}
                  />
                </i>
                <strong>{value}/{total} 正确</strong>
              </div>
            ))}
          </section>
          <section className="settlement-card settlement-schedule">
            <header>
              <TimerReset size={20} />
              <h2>后续复习计划</h2>
            </header>
            <div className="settlement-timeline">
              <p>
                <b>明天</b>
                <i>
                  <em style={{ width: `${Math.max(words.length, 1) * 20}%` }} />
                </i>
                <strong>{words.length} 词</strong>
              </p>
              <p>
                <b>一周内</b>
                <i>
                  <em style={{ width: '35%' }} />
                </i>
                <strong>巩固复习</strong>
              </p>
              <p>
                <b>一个月内</b>
                <i>
                  <em style={{ width: '20%' }} />
                </i>
                <strong>长期记忆</strong>
              </p>
            </div>
          </section>
        </div>
        <aside className="settlement-side">
          <section className="settlement-card settlement-words">
            <header>
              <CheckCircle2 size={21} />
              <h2>{incorrect.length ? '需要再见一面' : '本组全对'}</h2>
              <span>{incorrect.length}</span>
            </header>
            {incorrect.length ? (
              incorrect.map((word) => (
                <article key={word.word}>
                  <strong>{word.word}</strong>
                  <p>{word.meaning.split('｜')[0]}</p>
                  <small>已安排明天优先复习</small>
                </article>
              ))
            ) : (
              <p className="settlement-all-correct">
                很棒，本组单词都答对了。明天会进行一次轻量回顾。
              </p>
            )}
          </section>
          <section className="settlement-card settlement-note">
            <Sparkles size={19} />
            <p>今天完成一小组，就是为长期记忆多留下一条清晰的线索。</p>
          </section>
        </aside>
      </div>
      <button className="settlement-return" onClick={onBack}>
        <ArrowLeft size={19} />
        返回学习序列
      </button>
    </section>
  );
}

const exerciseLabels: Record<ExerciseType, string> = {
  WORD_MNEMONIC: '单词助记',
  MEANING_RECOGNITION: '词义识别',
  WORD_MATCHING: '单词匹配',
  SYNONYM_REPLACEMENT: '同义替换',
  READING_COMPREHENSION: '阅读理解',
};

function GeneratedStudyPage({
  plan,
  session,
  onBack,
  onPlanUpdated,
}: {
  plan: LearningPlan | null;
  session: Session;
  onBack: () => void;
  onPlanUpdated: (plan: LearningPlan) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; correct: boolean }>>({});
  const [sentenceMode, setSentenceMode] = useState(false);
  const [translationMode, setTranslationMode] = useState<'none' | 'translation' | 'simplified'>('none');
  const [submitting, setSubmitting] = useState(false);
  const [finishedPlan, setFinishedPlan] = useState<LearningPlan | null>(null);
  const groupStartedAt = useRef(Date.now());
  if (!plan?.content?.groups?.length) {
    return <section className="plan-empty"><Sparkles size={32}/><strong>学习内容还没有生成好</strong><p>{plan?.generationError ?? '返回预习页等待生成完成后再开始挑战。'}</p><button onClick={onBack}>返回学习序列</button></section>;
  }
  const firstPendingWord = plan.words.find((word) => !word.completed);
  const currentGroupIndex = firstPendingWord?.groupIndex ?? Math.max(0, plan.content.groups.length - 1);
  const group = plan.content.groups.find((item) => item.index === currentGroupIndex) ?? plan.content.groups[currentGroupIndex];
  const words = plan.words.filter((word) => word.groupIndex === group.index);
  const allAnswered = words.every((word) => word.id && answers[word.id]);

  const recordAnswer = (question: GeneratedQuestion, selected: string[]) => {
    const expected = (question.type === 'WORD_MATCHING' && question.pairs?.length
      ? question.pairs.map((pair) => `${pair.left}=>${pair.right}`)
      : question.correctAnswers
    ).slice().sort();
    const actual = [...selected].sort();
    setAnswers((current) => ({
      ...current,
      [question.bookWordId]: {
        selected,
        correct: expected.length === actual.length && expected.every((value, index) => value === actual[index]),
      },
    }));
  };
  const completeGroup = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    try {
      const elapsed = Math.round((Date.now() - groupStartedAt.current) / Math.max(1, words.length));
      const updated = await request<LearningPlan>(
        `/study/plans/${plan.id}/groups/${group.index}/complete`,
        {
          method: 'POST',
          body: JSON.stringify({
            answers: words.map((word) => {
              const answer = answers[word.id!];
              return {
                bookWordId: word.id,
                selectedAnswer: answer.selected,
                responseTimeMs: elapsed,
              };
            }),
          }),
        },
        session.accessToken,
      );
      onPlanUpdated(updated);
      if (updated.status === 'COMPLETED') setFinishedPlan(updated);
      else {
        setAnswers({});
        setSentenceMode(false);
        setTranslationMode('none');
        groupStartedAt.current = Date.now();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '提交本组结果失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };
  if (finishedPlan) {
    const results = Object.fromEntries(finishedPlan.words.map((word) => [word.word, word.result === true]));
    return <GroupSettlement words={finishedPlan.words} results={results} summary={finishedPlan.summary} onBack={onBack}/>;
  }
  return <section className="lesson-page">
    <header className="lesson-page-head">
      <button onClick={onBack}><ArrowLeft size={19}/>返回学习序列</button>
      <div><span>{modeLabel[plan.mode]} · 正常模式</span><strong>第 {group.index + 1} / {plan.groupCount} {plan.mode === 'individual' ? '篇' : '组'}</strong></div>
      <b>{plan.completed}/{plan.wordCount} 已完成</b>
    </header>
    <div className="lesson-layout">
      <main>
        <section className="lesson-section">
          <header><BookOpen size={19}/><h1>阅读材料</h1></header>
          <article className="reading-card">
            <div className="lesson-word-chips">
              {words.map((word, index) => <span key={word.id} style={wordTone(index)}>{word.word}<b>{group.wordOccurrences[word.word] ?? 1}</b></span>)}
            </div>
            <h2>{group.title}</h2>
            <p className="reading-lede">先在短文中理解本组单词，再完成每个单词对应的一道练习。</p>
            <div className="reading-tools generated-reading-tools">
              <button aria-pressed={sentenceMode} onClick={() => setSentenceMode((value) => !value)} title="分句阅读">☰</button>
              <button aria-pressed={translationMode === 'translation'} onClick={() => setTranslationMode((value) => value === 'translation' ? 'none' : 'translation')} title="翻译全文">译</button>
              <button aria-pressed={translationMode === 'simplified'} onClick={() => setTranslationMode((value) => value === 'simplified' ? 'none' : 'simplified')} title="简化全文">✦</button>
            </div>
            <div className={sentenceMode ? 'sentence-reading generated-sentences' : 'generated-passage'}>
              {group.sentences.map((sentence, index) => <article className={sentenceMode ? 'sentence-line' : ''} key={`${group.index}-${index}`}>
                <p>{sentenceMode && <b>{index + 1}. </b>}<HighlightedSentence text={sentence.english} words={words}/></p>
                {sentenceMode && translationMode !== 'none' && <small>{translationMode === 'translation' ? sentence.chinese : sentence.simplified}</small>}
              </article>)}
            </div>
            {!sentenceMode && translationMode !== 'none' && <p className={translationMode === 'translation' ? 'reading-translation' : 'reading-simple'}>
              {group.sentences.map((sentence) => translationMode === 'translation' ? sentence.chinese : sentence.simplified).join('')}
            </p>}
            <small>Powered by Lexloop AI</small>
          </article>
        </section>
        <section className="lesson-section exercises">
          <header><Sparkles size={19}/><h2>练习题</h2></header>
          {group.questions.map((question, index) => {
            const word = words.find((item) => item.id === question.bookWordId);
            if (!word) return null;
            return <GeneratedQuestionCard
              key={question.bookWordId}
              question={question}
              word={word}
              toneIndex={index}
              answer={answers[question.bookWordId]}
              onAnswer={(selected) => recordAnswer(question, selected)}
            />;
          })}
          <button className="check-matches" disabled={!allAnswered || submitting} onClick={() => void completeGroup()}>
            {submitting ? '正在记录学习结果…' : group.index + 1 === plan.groupCount ? '完成挑战并查看总结' : `完成本${plan.mode === 'individual' ? '篇' : '组'}，继续下一${plan.mode === 'individual' ? '篇' : '组'}`}
          </button>
        </section>
      </main>
      <aside className="lesson-side">
        <section><h2>本组学习单词</h2>{words.map((word, index) => <button key={word.id} style={wordTone(index)}><b>{index + 1}</b><span><strong>{word.word}</strong><small>{word.meaning.split('｜')[0]}</small></span></button>)}</section>
        <section className="exercise-progress"><h2>练习题</h2>{words.map((word) => {
          const answer = word.id ? answers[word.id] : undefined;
          const question = group.questions.find((item) => item.bookWordId === word.id);
          return <div className={answer ? answer.correct ? 'is-correct' : 'is-wrong' : ''} key={word.id}>{!answer ? <Circle size={25}/> : answer.correct ? <CheckCircle2 size={25}/> : <CircleX size={25}/>}<strong>{word.word}</strong><span>{question ? exerciseLabels[question.type] : '练习题'}</span></div>;
        })}<p>{allAnswered ? '本组练习已完成' : '完成所有练习题后即可继续'}</p></section>
      </aside>
    </div>
  </section>;
}

function HighlightedSentence({ text, words }: { text: string; words: Word[] }) {
  const escaped = words.map((word) => word.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!escaped) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return <>{parts.map((part, index) => {
    const wordIndex = words.findIndex((word) => word.word.toLowerCase() === part.toLowerCase());
    return wordIndex >= 0 ? <mark key={`${part}-${index}`} style={wordTone(wordIndex)}>{part}</mark> : <span key={`${part}-${index}`}>{part}</span>;
  })}</>;
}

function GeneratedQuestionCard({
  question,
  word,
  toneIndex,
  answer,
  onAnswer,
}: {
  question: GeneratedQuestion;
  word: Word;
  toneIndex: number;
  answer?: { selected: string[]; correct: boolean };
  onAnswer: (selected: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const isMultiple = question.type === 'WORD_MNEMONIC';
  const submit = (option?: string) => {
    const next = option ? [option] : selected;
    if (next.length) onAnswer(next);
  };
  return <article className="exercise-card generated-question">
    <span className="exercise-kind">{exerciseLabels[question.type]}</span>
    <h3><mark style={wordTone(toneIndex)}>{word.word}</mark>　{question.prompt}</h3>
    {question.type === 'WORD_MATCHING' && question.pairs?.length ? (
      <div className="generated-matching">{question.pairs.map((pair, index) => <label key={pair.left}><strong>{pair.left}</strong><select disabled={Boolean(answer)} defaultValue="" onChange={(event) => {
        const next = [...selected.filter((value) => !value.startsWith(`${pair.left}=>`)), `${pair.left}=>${event.target.value}`];
        setSelected(next);
        if (next.length === question.pairs!.length) onAnswer(next);
      }}><option value="" disabled>选择对应释义</option>{[...question.pairs!].sort((a, b) => b.right.localeCompare(a.right)).map((item) => <option key={item.right}>{item.right}</option>)}</select></label>)}</div>
    ) : (
      <div className="answer-options">{question.options.map((option, index) => {
        const checked = selected.includes(option);
        const correct = answer && question.correctAnswers.includes(option);
        return <button key={option} disabled={Boolean(answer)} className={`${checked ? 'selected' : ''} ${correct ? 'correct' : ''} ${answer && !correct ? 'muted' : ''}`} onClick={() => {
          if (isMultiple) setSelected((current) => current.includes(option) ? current.filter((item) => item !== option) : [...current, option]);
          else submit(option);
        }}>{option}{answer && correct ? ' ✓' : ''}{question.optionNotes?.[index] && <small>{question.optionNotes[index]}</small>}</button>;
      })}</div>
    )}
    {isMultiple && !answer && <button className="check-matches" disabled={!selected.length} onClick={() => submit()}>提交多选答案</button>}
    {answer && <><strong className={answer.correct ? 'answer-feedback success' : 'answer-feedback'}>{answer.correct ? '回答正确！' : '回答错误，正确答案已标出。'}</strong><p className="question-explanation">{question.explanation}</p><WordMeaningCard word={word}/></>}
  </article>;
}

function GroupStudyPage({
  plan,
  session,
  onBack,
  onPlanUpdated,
}: {
  plan: LearningPlan | null;
  session: Session;
  onBack: () => void;
  onPlanUpdated: (plan: LearningPlan) => void;
}) {
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [selectedPhrase, setSelectedPhrase] = useState<string | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<number | null>(null);
  const [matches, setMatches] = useState<Record<number, string>>({});
  const [matchChecked, setMatchChecked] = useState(false);
  const [settlement, setSettlement] = useState<{
    words: Word[];
    results: Record<string, boolean>;
  } | null>(null);
  if (!plan) return null;
  const groups = splitPlanWords(plan.words);
  const currentGroupIndex = Math.min(
    Math.floor(plan.completed / GROUP_WORD_LIMIT),
    groups.length - 1,
  );
  const words = groups[currentGroupIndex] ?? [];
  const matchWord = words[0];
  const phrases = matchWord
    ? [
        `${matchWord.word} people`,
        `${matchWord.word} oneself`,
        `${matchWord.word} to improve`,
        `can't ${matchWord.word} doing`,
      ]
    : [];
  const definitions = [
    {
      text: '指提供服务来帮助大众',
      tip: '侧重于服务与受益对象之间的关系。',
    },
    {
      text: '常用的习语表达，意为自助',
      tip: '侧重于行动由谁完成，而非行动本身。',
    },
    {
      text: '用于描述助力达成某种积极结果',
      tip: '侧重于结果向更好方向发生变化。',
    },
    {
      text: '表示情不自禁地做某事',
      tip: '侧重于行为难以克制、自然发生的感觉。',
    },
  ];
  const allMatched = phrases.length > 0 && Object.keys(matches).length === phrases.length;
  const allCompleted = words.every(
    (word, index) => exerciseType(index) === '词义辨析' || results[word.word] !== undefined,
  );
  const choosePhrase = (phrase: string) => {
    if (matchChecked) return;
    if (Object.values(matches).includes(phrase)) return;
    if (selectedDefinition !== null) {
      setMatches((current) => ({ ...current, [selectedDefinition]: phrase }));
      setSelectedDefinition(null);
      setSelectedPhrase(null);
    } else setSelectedPhrase(phrase);
  };
  const chooseDefinition = (index: number) => {
    if (matchChecked) return;
    if (matches[index]) {
      setMatches((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
      setSelectedPhrase(null);
      setSelectedDefinition(null);
      return;
    }
    if (selectedPhrase) {
      setMatches((current) => ({ ...current, [index]: selectedPhrase }));
      setSelectedPhrase(null);
      setSelectedDefinition(null);
    } else setSelectedDefinition(index);
  };
  const checkMatches = () => {
    const correct = phrases.every((phrase, index) => matches[index] === phrase);
    setMatchChecked(true);
    if (matchWord) setResults((current) => ({ ...current, [matchWord.word]: correct }));
  };
  const answerInstantly = (word: Word, choice: string) =>
    setResults((current) => ({ ...current, [word.word]: choice === word.meaning.split('｜')[0] }));
  useEffect(() => {
    if (settlement) return;
    setResults({});
    setMatches({});
    setSelectedPhrase(null);
    setSelectedDefinition(null);
    setMatchChecked(false);
  }, [currentGroupIndex, settlement]);
  useEffect(() => {
    if (!selectedPhrase || matchChecked) return;
    const matchWithShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= definitions.length || matches[index])
        return;
      event.preventDefault();
      chooseDefinition(index);
    };
    document.addEventListener('keydown', matchWithShortcut);
    return () => document.removeEventListener('keydown', matchWithShortcut);
  }, [selectedPhrase, matchChecked, matches, definitions.length]);
  useEffect(() => {
    document.querySelectorAll<HTMLButtonElement>('.match-phrases button').forEach((button) => {
      const matched = Object.values(matches).includes(button.textContent ?? '');
      button.disabled = matched;
      button.classList.toggle('matched', matched);
    });
  }, [matches]);
  useEffect(() => {
    const card = document.querySelector<HTMLElement>('.reading-card');
    if (!card || card.querySelector('.reading-tools')) return;
    const toolbar = document.createElement('div');
    toolbar.className = 'reading-tools';
    const sentences = [
      'In the realm of cultural exchange, accessing reliable information can be challenging.',
      `Our service steps in to ${words[0]?.word ?? 'help'}.`,
      `We create and share high-quality ${words[1]?.word ?? 'resources'} for learners.`,
      'Join us and explore these enriching materials today.',
    ];
    const addTool = (label: string, icon: string, action: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = label;
      button.dataset.tip = label;
      button.setAttribute('aria-label', label);
      button.textContent = icon;
      if (label.includes('朗读')) appendSpeakerIcon(button);
      button.addEventListener('click', action);
      toolbar.append(button);
    };
    addTool('展开分句阅读', '☰', () => {
      const existing = card.querySelector('.sentence-reading');
      const original = Array.from(
        card.querySelectorAll<HTMLElement>(':scope > p:not(.reading-lede)'),
      );
      if (existing) {
        existing.remove();
        original.forEach((item) => {
          item.style.display = '';
        });
        toolbar.querySelector('button')!.title = '展开分句阅读';
        toolbar.querySelector('button')!.dataset.tip = '展开分句阅读';
        return;
      }
      original.forEach((item) => {
        item.style.display = 'none';
      });
      const list = document.createElement('div');
      list.className = 'sentence-reading';
      sentences.forEach((sentence, index) => {
        const line = document.createElement('article');
        line.className = 'sentence-line';
        const text = document.createElement('p');
        let rich = sentence;
        words.forEach((word, wordIndex) => {
          rich = rich.replace(
            new RegExp(`\\b${word.word}\\b`, 'gi'),
            `<mark style="background:${WORD_TONES[wordIndex % WORD_TONES.length].background};color:${WORD_TONES[wordIndex % WORD_TONES.length].color}">${word.word}</mark>`,
          );
        });
        text.innerHTML = `${index + 1}. ${rich}`;
        const tools = document.createElement('div');
        tools.className = 'sentence-tools';
        [
          ['复制', '⧉'],
          ['翻译', '译'],
          ['语法分析', '⌕'],
          ['简化', '✦'],
          ['朗读', '◖'],
        ].forEach(([label, icon]) => {
          const button = document.createElement('button');
          button.textContent = icon;
          if (label === '朗读') appendSpeakerIcon(button);
          button.title = label;
          button.dataset.tip = label;
          button.setAttribute('aria-label', label);
          button.addEventListener('click', () => {
            if (label === '复制') navigator.clipboard?.writeText(sentence);
            if (label === '朗读')
              window.speechSynthesis?.speak(new SpeechSynthesisUtterance(sentence));
          });
          tools.append(button);
        });
        line.append(text, tools);
        list.append(line);
      });
      card.append(list);
      toolbar.querySelector('button')!.title = '收起分句阅读';
      toolbar.querySelector('button')!.dataset.tip = '收起分句阅读';
    });
    addTool('翻译全文', '译', () => {
      const existing = card.querySelector('.reading-translation');
      if (existing) {
        existing.remove();
        return;
      }
      const translation = document.createElement('p');
      translation.className = 'reading-translation';
      translation.textContent =
        '全文翻译：在文化交流中，可靠的信息十分重要。我们的服务帮助学习者获取优质资源，并持续提升跨文化沟通能力。';
      card.append(translation);
    });
    addTool('简化全文', '✦', () => {
      const existing = card.querySelector('.reading-simple');
      if (existing) {
        existing.remove();
        return;
      }
      const simple = document.createElement('p');
      simple.className = 'reading-simple';
      simple.textContent = '简化版：我们分享有用的学习资源，帮助大家更好地交流。';
      card.append(simple);
    });
    addTool('朗读全文', '◖', () =>
      window.speechSynthesis?.speak(new SpeechSynthesisUtterance(sentences.join(' '))),
    );
    card.append(toolbar);
    return () => toolbar.remove();
  }, [currentGroupIndex, words]);
  const continueToNextGroup = async () => {
    try {
      const latestPlans = await request<Omit<LearningPlan, 'mode'>[]>(
        '/study/plans',
        {},
        session.accessToken,
      );
      const latestPlan = latestPlans.find((item) => item.id === plan.id);
      const latestGroupIndex = latestPlan
        ? Math.floor(latestPlan.completed / GROUP_WORD_LIMIT)
        : currentGroupIndex;
      const submittedWords = latestPlan
        ? (splitPlanWords(latestPlan.words)[latestGroupIndex] ?? [])
        : words;
      if (!submittedWords.length || submittedWords.some((word) => !word.id))
        throw new Error('当前学习分组缺少可提交的单词信息，请返回学习序列后重试');
      const finalResults = Object.fromEntries(
        submittedWords.map((word, index) => [
          word.word,
          exerciseType(index) === '词义辨析' || results[word.word] === true,
        ]),
      );
      const updated = await request<Omit<LearningPlan, 'mode'>>(
        `/study/plans/${plan.id}/groups/${latestGroupIndex}/complete`,
        {
          method: 'POST',
          body: JSON.stringify({
            answers: submittedWords.map((word) => ({
              bookWordId: word.id!,
              isCorrect: finalResults[word.word],
            })),
          }),
        },
        session.accessToken,
      );
      onPlanUpdated({ ...updated, mode: plan.mode });
      setSettlement({ words: submittedWords, results: finalResults });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '提交本组结果失败，请重试');
    }
  };
  if (settlement)
    return (
      <GroupSettlement words={settlement.words} results={settlement.results} onBack={onBack} />
    );
  return (
    <section className="lesson-page">
      <header className="lesson-page-head">
        <button onClick={onBack}>
          <ArrowLeft size={19} />
          返回学习序列
        </button>
        <div>
          <span>分组学习 · 正常模式</span>
          <strong>
            第 {currentGroupIndex + 1} / {groups.length} 组
          </strong>
        </div>
        <b>
          {plan.completed}/{plan.wordCount} 已掌握
        </b>
      </header>
      <div className="lesson-layout">
        <main>
          <section className="lesson-section">
            <header>
              <BookOpen size={19} />
              <h1>阅读材料</h1>
            </header>
            <article className="reading-card">
              <div className="lesson-word-chips">
                {words.map((word, index) => (
                  <span key={word.word} style={wordTone(index)}>
                    {word.word}
                    <b>{articleOccurrenceCount(index, words.length)}</b>
                  </span>
                ))}
              </div>
              <h2>
                {words.map((word, index) => (
                  <span className="reading-title-word" style={wordTone(index)} key={word.word}>
                    {word.word[0]?.toUpperCase() + word.word.slice(1)}
                    {index === words.length - 1 ? '' : ' '}
                  </span>
                ))}
              </h2>
              <p className="reading-lede">
                A short story built around this group&apos;s new words. Read it once, then use the
                exercises below to lock the words into memory.
              </p>
              <p>
                {words.map((word, index) => (
                  <span key={word.word}>
                    Learning to <mark style={wordTone(index)}>{word.word}</mark>
                    {index === words.length - 1
                      ? ' turns a small daily effort into lasting progress.'
                      : ', '}
                  </span>
                ))}
              </p>
              <p>
                Each word appears in context, so you can connect its meaning with a complete idea
                instead of memorising it in isolation.
                {words.length > 0 && (
                  <>
                    {' '}
                    Revisit{' '}
                    <mark style={wordTone(words.length - 1)}>
                      {words[words.length - 1].word}
                    </mark>{' '}
                    before you continue.
                  </>
                )}
              </p>
              <small>Powered by Lexloop AI</small>
            </article>
          </section>
          <section className="lesson-section exercises">
            <header>
              <Sparkles size={19} />
              <h2>练习题</h2>
            </header>
            {matchWord && (
              <article className="exercise-card matching-exercise">
                <span className="exercise-kind">单词匹配</span>
                <h3>
                  Match the phrases containing <mark style={wordTone(0)}>{matchWord.word}</mark>{' '}
                  with their correct descriptions.
                </h3>
                <p>单词、释义均可先点击，再选择另一侧完成匹配。</p>
                <div className="match-phrases">
                  {phrases.map((phrase) => (
                    <button
                      key={phrase}
                      className={`${selectedPhrase === phrase ? 'selected' : ''} ${matchChecked ? (Object.values(matches).includes(phrase) ? 'linked' : '') : ''}`}
                      onClick={() => choosePhrase(phrase)}
                    >
                      {phrase}
                    </button>
                  ))}
                </div>
                <div className="match-definitions">
                  {definitions.map((definition, index) => {
                    const phrase = matches[index];
                    const correct = phrase === phrases[index];
                    return (
                      <button
                        key={definition.text}
                        className={`${selectedDefinition === index ? 'selected' : ''} ${phrase ? 'linked' : ''} ${matchChecked ? (correct ? 'correct' : 'wrong') : ''}`}
                        onClick={() => chooseDefinition(index)}
                      >
                        <span className="match-definition-copy">
                          <strong>{definition.text}</strong>
                          <small>
                            <i aria-hidden="true">✳</i>
                            <b>Tips</b>
                            {definition.tip}
                          </small>
                        </span>
                        {phrase && matchChecked && !correct ? (
                          <span className="match-answer-review" aria-label={`你的答案：${phrase}；正确答案：${phrases[index]}`}>
                            <b className="match-answer-review-wrong">{phrase}</b>
                            <b className="match-answer-review-correct">{phrases[index]}</b>
                          </span>
                        ) : phrase ? (
                          <b>{phrase}</b>
                        ) : (
                          <em>{selectedPhrase ? '选择此处' : '选择上方选项'}</em>
                        )}
                      </button>
                    );
                  })}
                </div>
                {allMatched && !matchChecked && (
                  <button className="check-matches" onClick={checkMatches}>
                    ✓ 检查结果
                  </button>
                )}
                {matchChecked && (
                  <>
                    <strong
                      className={
                        results[matchWord.word] ? 'answer-feedback success' : 'answer-feedback'
                      }
                    >
                      {results[matchWord.word] ? '匹配正确！' : '有匹配错误，请查看标记结果。'}
                    </strong>
                    <WordMeaningCard word={matchWord} />
                  </>
                )}
              </article>
            )}
            {words.slice(1).map((word, index) => {
              if (exerciseType(index + 1) === '词义辨析') return <WordSenseDemo key={word.word} />;
              if (exerciseType(index + 1) === '同义替换') return <SynonymDemo key={word.word} word={word} result={results[word.word]} onAnswer={(correct) => setResults(current => ({ ...current, [word.word]: correct }))}/>;
              const answer = word.meaning.split('｜')[0];
              const options = [
                answer,
                'to work without a clear purpose',
                'to avoid taking responsibility',
                'to stop before finishing a task',
              ];
              const result = results[word.word];
              return (
                <article className="exercise-card" key={word.word}>
                  <span className="exercise-kind">{exerciseType(index + 1)}</span>
                  <h3>
                    Choose the phrase that best matches{' '}
                    <mark style={wordTone(index + 1)}>{word.word}</mark>.
                  </h3>
                  <p>点击选项后立即显示结果。</p>
                  <div className="answer-options">
                    {options.map((option) => (
                      <button
                        key={option}
                        className={`${result !== undefined && option === answer ? 'correct' : ''} ${result !== undefined && option !== answer && option !== answer ? 'muted' : ''}`}
                        onClick={() => result === undefined && answerInstantly(word, option)}
                      >
                        {option}
                        {result !== undefined && option === answer && ' ✓'}
                      </button>
                    ))}
                  </div>
                  {result !== undefined && (
                    <>
                      <strong className={result ? 'answer-feedback success' : 'answer-feedback'}>
                        {result ? '回答正确！' : '回答错误，正确答案已标出。'}
                      </strong>
                      <WordMeaningCard word={word} />
                    </>
                  )}
                </article>
              );
            })}
            {allCompleted && (
              <button className="check-matches" onClick={() => void continueToNextGroup()}>
                完成本组并安排复习
              </button>
            )}
          </section>
        </main>
        <aside className="lesson-side">
          <section>
            <h2>本组学习单词</h2>
            {words.map((word, index) => (
              <button
                key={word.word}
                className={index === 0 ? 'active' : ''}
                style={wordTone(index)}
              >
                <b>{index + 1}</b>
                <span>
                  <strong>{word.word}</strong>
                  <small>{word.meaning.split('｜')[0]}</small>
                </span>
                <Volume2 size={17} />
              </button>
            ))}
          </section>
          <section className="exercise-progress">
            <h2>练习题</h2>
            {words.map((word, index) => {
              const result = results[word.word];
              return (
                <div
                  className={result === undefined ? '' : result ? 'is-correct' : 'is-wrong'}
                  key={word.word}
                >
                  {result === undefined ? (
                    <Circle size={25} />
                  ) : result ? (
                    <CheckCircle2 size={25} />
                  ) : (
                    <CircleX size={25} />
                  )}
                  <strong>{word.word}</strong>
                  <span>{exerciseType(index)}</span>
                </div>
              );
            })}
            <p>{allCompleted ? '本组练习已完成' : '完成所有练习题后即可进入下一组'}</p>
          </section>
          <section className="lesson-helper">
            <Sparkles size={20} />
            <strong>词环学习助手</strong>
            <p>需要解释、例句或记忆方法？随时问我。</p>
            <div>
              <input placeholder="问问本组单词…" />
              <button aria-label="发送问题">
                <Send size={17} />
              </button>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function LearningHistory({
  plans,
  onContinue,
  onRetry,
}: {
  plans: LearningPlan[];
  onContinue: (id: string) => void;
  onRetry: (plan: LearningPlan) => void;
}) {
  if (!plans.length)
    return (
      <section className="plan-empty">
        <CalendarDays size={32} />
        <strong>今天还没有学习记录</strong>
        <p>创建学习计划后，学习进度会保留在这里。</p>
      </section>
    );
  return (
    <section className="history-grid">
      {plans.map((plan) => {
        const progress = Math.round((plan.completed / plan.wordCount) * 100);
        const active = plan.status === 'ACTIVE' || plan.status === 'GENERATING';
        const failed = plan.status === 'FAILED';
        return (
          <article className={active ? 'is-current' : ''} key={plan.id}>
            <header>
              <span>{modeLabel[plan.mode]}</span>
              <span>正常模式</span>
              <span>{plan.wordCount} 组单词</span>
              {active ? (
                <b>
                  <Play size={16} />
                  {plan.status === 'GENERATING' ? '生成中' : '学习中'}
                </b>
              ) : failed ? (
                <b>
                  <Sparkles size={16} />
                  生成失败
                </b>
              ) : (
                <b>
                  <Pause size={16} />
                  已完成
                </b>
              )}
            </header>
            <div>
              <strong>
                {plan.completed}/{plan.wordCount} 单词
              </strong>
              <em>（剩余：{plan.wordCount - plan.completed}）</em>
              <b>{progress}%</b>
            </div>
            <i>
              <em style={{ width: `${progress}%` }} />
            </i>
            <footer>
              <span>
                当前学习分组：{Math.min(plan.completed + 1, plan.wordCount)} / {plan.wordCount}
              </span>
              {active && (
                <button onClick={() => onContinue(plan.id)} disabled={plan.status === 'GENERATING'}>
                  <BookOpen size={18} />
                  {plan.status === 'GENERATING' ? '题目生成中' : '继续学习'}
                </button>
              )}
              {failed && (
                <button onClick={() => onRetry(plan)}>
                  <Sparkles size={18} />
                  重新生成
                </button>
              )}
            </footer>
          </article>
        );
      })}
    </section>
  );
}
