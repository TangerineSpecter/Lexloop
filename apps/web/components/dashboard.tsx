'use client';
import { CollectWordForm } from './learning-lab/collect-word-form';
import type {
  ReadingSentenceRewriteFeedback,
  ReadingWordUseFeedback,
  VocabularyArchivePage,
} from '@lexloop/types';

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
  Copy,
  Eye,
  EyeOff,
  Flame,
  Grid2X2,
  LayoutList,
  ListRestart,
  LogOut,
  Menu,
  Pause,
  PenLine,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  TimerReset,
  ToggleLeft,
  Trophy,
  Swords,
  Trash2,
  Undo2,
  UserRound,
  Volume2,
  PlaneTakeoff,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { browserTimeZone, request, type Session, userFacingError } from '../lib/api';
import { speakEnglish } from './english-audio-controls';
import { findTargetWordMatches } from '../lib/target-word-highlighting';
import { clearMicroStoryDrafts } from '../lib/micro-story-drafts';
import {
  clearStudyDraft,
  clearStudyDraftIfMatches,
  readStudyDraftSnapshot,
  saveStudyDraft,
  studyDraftIdentity,
  type StudyDraftAnswers,
} from '../lib/study-drafts';
import { studyGroupCompletion } from '../lib/study-sequence';
import { Tooltip } from './tooltip';
import { ReadingModelDrawer } from './reading-model-drawer';
import { TutorPanel } from './tutor-panel';
import { UpdatesLink } from './updates-link';
import { DailySentenceCard } from './daily-sentence/daily-sentence-card';
import { PracticeEntries } from './practice/practice-entries';

const TravelScenarioPage = dynamic(
  () => import('./travel-scenario-page').then((module) => module.TravelScenarioPage),
  { loading: () => <DashboardPageLoading page="travel" title="场景口语" /> },
);
const MistakesPage = dynamic(
  () => import('./mistakes-page').then((module) => module.MistakesPage),
  { loading: () => <DashboardPageLoading page="mistakes" title="待巩固" /> },
);
const LearningHistoryPage = dynamic(
  () => import('./learning-history-page').then((module) => module.LearningHistoryPage),
  { loading: () => <DashboardPageLoading page="history" title="学习历史" /> },
);
const StatisticsPage = dynamic(
  () => import('./statistics-page').then((module) => module.StatisticsPage),
  { loading: () => <DashboardPageLoading page="statistics" title="学习统计" /> },
);
const SystemSettings = dynamic(
  () => import('./system-settings').then((module) => module.SystemSettings),
  {
    loading: () => (
      <div role="status" aria-live="polite">
        正在加载系统设置…
      </div>
    ),
  },
);

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
  pairs?: Array<{ left: string; right: string; tip?: string }>;
};
type ReadingSentence = { english: string; chinese: string; simplified: string; grammar?: string };
type GeneratedGroup = {
  index: number;
  title: string;
  wordOccurrences: Record<string, number>;
  sentences: ReadingSentence[];
  questions: GeneratedQuestion[];
};
type MeaningLine = { part: string; text: string };
type Word = {
  id?: string;
  word: string;
  part: string;
  meaning: string;
  meanings?: MeaningLine[];
  ukPhonetic?: string | null;
  usPhonetic?: string | null;
  cefrLevel?: string | null;
  state?: 'review';
  source?: 'NEW' | 'REVIEW';
  groupIndex?: number;
  question?: GeneratedQuestion;
  completed?: boolean;
  result?: boolean;
  savedContext?: { scenario: string | null; example: string };
  nextReviewAt?: string | null;
  activeWeaknesses?: Array<{
    questionType: string;
    wrongCount: number;
    consecutiveCorrect: number;
    remainingCorrect: number;
  }>;
};
type DashboardWords = { defaultNewWordCount: number; reviewWords: Word[]; newWords: Word[] };
type MasteredWord = Word & { id: string; masteredAt: string };
type StudyMode = 'group' | 'individual' | 'exam';
type IndividualWordSource = 'book' | 'mistakes' | 'random' | 'frequent';
const INDIVIDUAL_SOURCES: Array<{ id: IndividualWordSource; label: string; hint: string }> = [
  { id: 'book', label: '词表', hint: '按默认词书顺序，取还没学过的词，一词一组。' },
  { id: 'mistakes', label: '错词', hint: '从错题本里待巩固的词开刷，不另建薄弱专项。' },
  { id: 'random', label: '随机', hint: '从默认词书尚未掌握的词里随机抽取。' },
  {
    id: 'frequent',
    label: '高频',
    hint: '优先已学次数、口语优先度和较低 CEFR；词表没有这些标记时取词书前部。',
  },
];
export type LearningPlan = {
  id: string;
  mode: StudyMode;
  purpose?: 'normal' | 'weakness';
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
  blocksNewPlanCreation?: boolean;
  createdAt: string;
  completedAt?: string | null;
};
type StudyPlanListStatus = 'loading' | 'ready' | 'error';
type DashboardPage =
  | 'study'
  | 'travel'
  | 'assessment'
  | 'learning'
  | 'mistakes'
  | 'mastered'
  | 'history'
  | 'statistics'
  | 'settings';
const dashboardPages = new Set<DashboardPage>([
  'study',
  'travel',
  'assessment',
  'learning',
  'mistakes',
  'mastered',
  'history',
  'statistics',
  'settings',
]);
function isDashboardPage(value: unknown): value is DashboardPage {
  return typeof value === 'string' && dashboardPages.has(value as DashboardPage);
}
type ProgressSummary = { totalWords: number; masteredWords: number; progress: number };
type ProgressSummaryState = {
  ownerId: string;
  status: 'loading' | 'ready' | 'failed';
  summary: ProgressSummary | null;
};
type DefaultBook = { id: string; title: string; totalWords: number };
type DefaultBookState = {
  ownerId: string;
  status: 'loading' | 'ready' | 'failed';
  book: DefaultBook | null;
};
type LearningWord = Omit<Word, 'state'> & {
  id: string;
  state: 'LEARNING' | 'REVIEWING';
  accuracy: number;
  reinforcement: string;
  reviewCount: number;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  bookTitle: string;
};
const VOCABULARY_ARCHIVE_PAGE_SIZE = 50;
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
const MAX_DAILY_REVIEW_WORDS = 40;
const WORD_TONES = [
  { background: '#d8ebff', color: '#0b3a85' },
  { background: '#ffd9d2', color: '#9b1c1c' },
  { background: '#e8dcff', color: '#481388' },
  { background: '#d8f3dd', color: '#17613a' },
  { background: '#ffe9b6', color: '#875000' },
] as const;

function splitPlanWords(words: Word[]) {
  const indexes = [
    ...new Set(words.map((word, index) => word.groupIndex ?? Math.floor(index / GROUP_WORD_LIMIT))),
  ];
  return indexes.map((groupIndex) =>
    words.filter(
      (word, index) => (word.groupIndex ?? Math.floor(index / GROUP_WORD_LIMIT)) === groupIndex,
    ),
  );
}
function meaningLinesOf(word: Pick<Word, 'part' | 'meaning' | 'meanings'>): MeaningLine[] {
  if (word.meanings?.length) return word.meanings;
  if (word.meaning.includes('｜')) {
    return word.meaning
      .split('｜')
      .filter(Boolean)
      .map((text, index) => ({ part: index === 0 ? word.part : '', text }));
  }
  return [{ part: word.part, text: word.meaning }];
}

function formatPhonetic(value: string | null | undefined, wordText: string) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed === '无') return null;
  const wrapped =
    (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length > 2);
  const inner = (wrapped ? trimmed.slice(1, -1) : trimmed).trim();
  if (!inner || inner.toLowerCase() === wordText.trim().toLowerCase()) return null;
  return `/${inner}/`;
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

function DashboardPageLoading({
  page,
  title,
}: {
  page: 'travel' | 'mistakes' | 'history' | 'statistics';
  title: string;
}) {
  return (
    <div
      className="study-content dashboard-chunk-loading"
      data-dashboard-page={page}
      aria-busy="true"
    >
      <h1>{title}</h1>
      <div className="dashboard-chunk-loading-card">
        <span className="dashboard-chunk-loading-mark" aria-hidden="true" />
        <p role="status" aria-live="polite">
          正在打开栏目…
        </p>
      </div>
    </div>
  );
}

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState<'words' | 'plan' | 'history'>('words');
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [plansOwnerId, setPlansOwnerId] = useState(session.user.id);
  const [plansLoadStatus, setPlansLoadStatus] = useState<StudyPlanListStatus>('loading');
  const [plansLoadAttempt, setPlansLoadAttempt] = useState(0);
  const [previewPlan, setPreviewPlan] = useState<LearningPlan | null>(null);
  const [previewOwnerId, setPreviewOwnerId] = useState(session.user.id);
  const [readingSettingsOpen, setReadingSettingsOpen] = useState(false);
  const [lessonPlanId, setLessonPlanId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bookPickerOpen, setBookPickerOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountMenuPortalContainer, setAccountMenuPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const [accountMenuPosition, setAccountMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [page, setCurrentPage] = useState<DashboardPage>('study');
  const currentPageRef = useRef<DashboardPage>('study');
  currentPageRef.current = page;
  const setPage = (nextPage: DashboardPage) => {
    if (currentPageRef.current === nextPage) return;
    const previousPage = currentPageRef.current;
    currentPageRef.current = nextPage;
    setCurrentPage(nextPage);
    const state =
      window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
    window.history.pushState(
      { ...state, lexloopDashboardPage: nextPage, lexloopPreviousDashboardPage: previousPage },
      '',
      window.location.href,
    );
  };
  const returnToPage = (target: DashboardPage) => {
    if (window.history.state?.lexloopPreviousDashboardPage === target) {
      window.history.back();
    } else {
      setPage(target);
    }
  };
  const [historyBackPage, setHistoryBackPage] = useState<'study' | 'statistics'>('study');
  const [settingsSection, setSettingsSection] = useState<'account' | 'system'>('account');
  const [currentBookState, setCurrentBookState] = useState<DefaultBookState>({
    ownerId: session.user.id,
    status: 'loading',
    book: null,
  });
  const [currentBookLoadAttempt, setCurrentBookLoadAttempt] = useState(0);
  const [progressSummaryState, setProgressSummaryState] = useState<ProgressSummaryState>({
    ownerId: session.user.id,
    status: 'loading',
    summary: null,
  });
  const [progressSummaryAttempt, setProgressSummaryAttempt] = useState(0);
  const [progressRevision, setProgressRevision] = useState(0);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuPopoverRef = useRef<HTMLDivElement>(null);
  const accountMenuHoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defaultBookRequestRef = useRef(0);
  const sidebarAccountButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarAccountHoveredRef = useRef(false);
  const topbarAccountButtonRef = useRef<HTMLButtonElement>(null);
  const lastAccountMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const currentUserIdRef = useRef(session.user.id);
  currentUserIdRef.current = session.user.id;
  const cancelAccountMenuHoverClose = () => {
    if (accountMenuHoverCloseTimeoutRef.current !== null) {
      clearTimeout(accountMenuHoverCloseTimeoutRef.current);
      accountMenuHoverCloseTimeoutRef.current = null;
    }
  };
  const scheduleAccountMenuHoverClose = () => {
    cancelAccountMenuHoverClose();
    accountMenuHoverCloseTimeoutRef.current = setTimeout(() => {
      accountMenuHoverCloseTimeoutRef.current = null;
      sidebarAccountHoveredRef.current = false;
      setAccountMenuOpen(false);
    }, 180);
  };
  const visiblePlans = plansOwnerId === session.user.id ? plans : [];
  const visiblePlansStatus = plansOwnerId === session.user.id ? plansLoadStatus : 'loading';
  const visiblePreviewPlan = previewOwnerId === session.user.id ? previewPlan : null;
  const visibleProgressSummaryState =
    progressSummaryState.ownerId === session.user.id
      ? progressSummaryState
      : { ownerId: session.user.id, status: 'loading' as const, summary: null };
  const visibleCurrentBookState =
    currentBookState.ownerId === session.user.id
      ? currentBookState
      : { ownerId: session.user.id, status: 'loading' as const, book: null };
  const currentBook = visibleCurrentBookState.book;
  const name = session.user.displayName || session.user.email.split('@')[0];
  const closeBookPicker = useCallback(() => setBookPickerOpen(false), []);
  const openPlanPreview = (plan: LearningPlan) => {
    setPreviewOwnerId(session.user.id);
    setPreviewPlan(plan);
  };
  const retryPlanLoad = () => {
    setPlansLoadStatus('loading');
    setPlansLoadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    setAccountMenuPortalContainer(document.body);
  }, []);

  useEffect(
    () => () => {
      if (accountMenuHoverCloseTimeoutRef.current !== null) {
        clearTimeout(accountMenuHoverCloseTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!accountMenuOpen || !accountMenuPortalContainer) {
      setAccountMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = sidebarAccountButtonRef.current;
      const menu = accountMenuPopoverRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      if (!menuRect.width || !menuRect.height) return;

      const desktop = window.matchMedia('(min-width: 921px)').matches;
      const preferredLeft = desktop ? triggerRect.right + 8 : 8;
      const preferredTop = desktop ? triggerRect.top + 10 : triggerRect.bottom + 8;
      const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - menuRect.height - 8);
      const nextPosition = {
        left: Math.round(Math.min(Math.max(8, preferredLeft), maxLeft)),
        top: Math.round(Math.min(Math.max(8, preferredTop), maxTop)),
      };

      setAccountMenuPosition((current) =>
        current?.left === nextPosition.left && current.top === nextPosition.top
          ? current
          : nextPosition,
      );
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const sidebar = sidebarAccountButtonRef.current?.closest('.study-sidebar');
    sidebar?.addEventListener('transitionend', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      sidebar?.removeEventListener('transitionend', updatePosition);
    };
  }, [accountMenuOpen, accountMenuPortalContainer, sidebarOpen]);

  useEffect(() => {
    const existingState =
      window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
    const requestedView = new URLSearchParams(window.location.search).get('view');
    const initialPage: DashboardPage = requestedView === 'mistakes' ? 'mistakes' : 'study';
    currentPageRef.current = initialPage;
    setCurrentPage(initialPage);
    window.history.replaceState(
      {
        ...existingState,
        lexloopDashboardPage: initialPage,
        lexloopPreviousDashboardPage: null,
      },
      '',
      window.location.href,
    );

    const handlePopState = (event: PopStateEvent) => {
      const nextPage = isDashboardPage(event.state?.lexloopDashboardPage)
        ? event.state.lexloopDashboardPage
        : 'study';
      currentPageRef.current = nextPage;
      setCurrentPage(nextPage);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    let active = true;
    const ownerId = session.user.id;
    const requestId = ++defaultBookRequestRef.current;
    setCurrentBookState({ ownerId, status: 'loading', book: null });
    request<DefaultBook | null>('/vocabulary/default', {}, session.accessToken)
      .then((book) => {
        if (
          book !== null &&
          (!book.id || !book.title || !Number.isSafeInteger(book.totalWords) || book.totalWords < 0)
        ) {
          throw new Error('默认词表数据无效');
        }
        if (
          !active ||
          defaultBookRequestRef.current !== requestId ||
          currentUserIdRef.current !== ownerId
        )
          return;
        setCurrentBookState({ ownerId, status: 'ready', book });
      })
      .catch(() => {
        if (
          !active ||
          defaultBookRequestRef.current !== requestId ||
          currentUserIdRef.current !== ownerId
        )
          return;
        setCurrentBookState({ ownerId, status: 'failed', book: null });
      });
    return () => {
      active = false;
      if (defaultBookRequestRef.current === requestId) defaultBookRequestRef.current++;
    };
  }, [session.accessToken, session.user.id, currentBookLoadAttempt]);

  const retryCurrentBookLoad = () => {
    setCurrentBookLoadAttempt((attempt) => attempt + 1);
  };

  const activateCurrentBook = (book: DefaultBook) => {
    defaultBookRequestRef.current++;
    setCurrentBookState({ ownerId: session.user.id, status: 'ready', book });
  };

  useEffect(() => {
    let active = true;
    const ownerId = session.user.id;
    setProgressSummaryState({ ownerId, status: 'loading', summary: null });
    request<ProgressSummary>('/vocabulary/progress-summary', {}, session.accessToken)
      .then((summary) => {
        if (!active || currentUserIdRef.current !== ownerId) return;
        if (
          !Number.isFinite(summary.totalWords) ||
          !Number.isFinite(summary.masteredWords) ||
          !Number.isFinite(summary.progress)
        ) {
          throw new Error('学习统计数据无效');
        }
        setProgressSummaryState({ ownerId, status: 'ready', summary });
      })
      .catch(() => {
        if (!active || currentUserIdRef.current !== ownerId) return;
        setProgressSummaryState({ ownerId, status: 'failed', summary: null });
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, session.user.id, plans, progressRevision, progressSummaryAttempt]);

  const retryProgressSummary = () => {
    setProgressSummaryAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !accountMenuRef.current?.contains(target) &&
        !accountMenuPopoverRef.current?.contains(target)
      ) {
        setAccountMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountMenuOpen(false);
        const trigger = lastAccountMenuTriggerRef.current;
        if (trigger === topbarAccountButtonRef.current) setSidebarOpen(false);
        trigger?.focus();
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    let active = true;
    setPlansOwnerId(session.user.id);
    setPlans([]);
    setPlansLoadStatus('loading');
    request<LearningPlan[]>('/study/plans', {}, session.accessToken)
      .then((nextPlans) => {
        if (!active) return;
        setPlans(nextPlans);
        setPlansLoadStatus('ready');
      })
      .catch(() => {
        if (!active) return;
        setPlans([]);
        setPlansLoadStatus('error');
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, session.user.id, plansLoadAttempt]);

  useEffect(() => {
    setActiveTab('words');
    setLessonPlanId(null);
    setPreviewPlan(null);
    setPreviewOwnerId(session.user.id);
  }, [session.user.id]);

  return (
    <main className="study-app">
      <aside className={`study-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div
          className={`sidebar-account-wrap${accountMenuOpen ? ' is-menu-open' : ''}`}
          ref={accountMenuRef}
          onPointerEnter={(event) => {
            cancelAccountMenuHoverClose();
            sidebarAccountHoveredRef.current = event.pointerType === 'mouse';
            if (!sidebarAccountHoveredRef.current) return;
            lastAccountMenuTriggerRef.current = sidebarAccountButtonRef.current;
            setAccountMenuOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'mouse') return;
            const relatedTarget = event.relatedTarget;
            if (
              relatedTarget instanceof Node &&
              accountMenuPopoverRef.current?.contains(relatedTarget)
            ) {
              cancelAccountMenuHoverClose();
              sidebarAccountHoveredRef.current = true;
              return;
            }
            sidebarAccountHoveredRef.current = false;
            if (!accountMenuOpen) return;
            scheduleAccountMenuHoverClose();
          }}
        >
          <button
            ref={sidebarAccountButtonRef}
            className="sidebar-book"
            onClick={(event) => {
              cancelAccountMenuHoverClose();
              lastAccountMenuTriggerRef.current = sidebarAccountButtonRef.current;
              const mouseHover = event.detail > 0 && sidebarAccountHoveredRef.current;
              setAccountMenuOpen((open) => (mouseHover ? true : !open));
            }}
            aria-expanded={accountMenuOpen}
            aria-controls="account-menu"
          >
            <Avatar />
            <div>
              <strong>{name}</strong>
              <span>
                {currentBook?.title ??
                  (visibleCurrentBookState.status === 'loading'
                    ? '正在读取词表…'
                    : visibleCurrentBookState.status === 'failed'
                      ? '词表读取失败'
                      : '请选择词表')}
              </span>
            </div>
            <ChevronDown size={15} />
          </button>
        </div>
        <div className="sidebar-scroll">
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
            <button
              className={`nav-item nav-button ${page === 'travel' || page === 'assessment' ? 'active' : ''}`}
              onClick={() => {
                setPage('travel');
                setSidebarOpen(false);
              }}
            >
              <PlaneTakeoff size={16} />
              <span>场景口语</span>
            </button>
            <a className="nav-item" href="/dashboard/adventure">
              <Swords size={16} />
              <span>地下词环</span>
            </a>
            <a className="nav-item" href="/dashboard/notebook">
              <BookOpen size={16} />
              <span>生词本与收藏</span>
            </a>
            <a className="nav-item" href="/dashboard/micro-stories">
              <BookOpen size={16} />
              <span>一分钟微故事</span>
            </a>
            <a className="nav-item" href="/dashboard/notebook?tab=reading">
              <BookOpen size={16} />
              <span>生词短文精读</span>
            </a>
            <a className="nav-item" href="/dashboard/notebook?tab=grammar">
              <Sparkles size={16} />
              <span>语法薄弱项专项</span>
            </a>
            <a className="nav-item" href="/dashboard/practice?tab=output">
              <Sparkles size={16} />
              <span>学习专项与处方</span>
            </a>
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
                  className={page === 'mistakes' ? 'active' : ''}
                  onClick={() => {
                    setPage('mistakes');
                    setSidebarOpen(false);
                  }}
                >
                  待巩固
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
              className={`nav-item nav-button ${page === 'history' ? 'active' : ''}`}
              onClick={() => {
                setHistoryBackPage('study');
                setPage('history');
                setSidebarOpen(false);
              }}
            >
              <CalendarDays size={16} />
              <span>学习历史</span>
            </button>
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
        </div>
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
            <UpdatesLink />
            <button
              ref={topbarAccountButtonRef}
              className="topbar-account"
              onClick={() => {
                lastAccountMenuTriggerRef.current = topbarAccountButtonRef.current;
                if (window.matchMedia('(max-width: 920px)').matches) {
                  if (accountMenuOpen) {
                    setAccountMenuOpen(false);
                    setSidebarOpen(false);
                  } else {
                    setSidebarOpen(true);
                    setAccountMenuOpen(true);
                  }
                } else {
                  setAccountMenuOpen((open) => !open);
                }
              }}
              aria-label="账户菜单"
              aria-expanded={accountMenuOpen}
              aria-controls="account-menu"
            >
              <Avatar />
              <span>{name}</span>
              <ChevronDown size={15} />
            </button>
          </div>
        </header>
        {page === 'study' && lessonPlanId !== null && visiblePlansStatus !== 'ready' ? (
          <div className="study-content">
            <StudyPlanLoadNotice status={visiblePlansStatus} onRetry={retryPlanLoad} />
          </div>
        ) : page === 'study' && lessonPlanId !== null ? (
          <GeneratedStudyPage
            key={`${session.user.id}:${lessonPlanId}`}
            plan={visiblePlans.find((plan) => plan.id === lessonPlanId) ?? null}
            session={session}
            onBack={() => setLessonPlanId(null)}
            onOpenMistakes={() => setPage('mistakes')}
            onOpenTutorSettings={
              session.user.role === 'ADMIN'
                ? () => {
                    setSettingsSection('system');
                    setPage('settings');
                  }
                : undefined
            }
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
              <StreakCard session={session} />
              <Metric
                title="词表总词数"
                value={currentBook ? String(currentBook.totalWords) : '—'}
                detail={
                  currentBook?.title ??
                  (visibleCurrentBookState.status === 'loading' ? (
                    <span role="status">正在读取词表…</span>
                  ) : visibleCurrentBookState.status === 'failed' ? (
                    <>
                      <span role="alert">词表信息暂时无法加载</span>
                      <button type="button" onClick={retryCurrentBookLoad}>
                        重试
                      </button>
                    </>
                  ) : (
                    '请选择一个系统词表'
                  ))
                }
                detailClassName={
                  visibleCurrentBookState.status === 'failed' ? 'metric-detail-error' : ''
                }
                className={visibleCurrentBookState.status === 'failed' ? 'has-detail-action' : ''}
                backIcon={<BookOpen size={42} />}
                backText="海量词库等你探索"
                backColor="var(--sky)"
              />
              <Metric
                title="已掌握词数"
                value={
                  visibleProgressSummaryState.status === 'ready' &&
                  visibleProgressSummaryState.summary
                    ? String(visibleProgressSummaryState.summary.masteredWords)
                    : '—'
                }
                detail={
                  visibleProgressSummaryState.status === 'ready' &&
                  visibleProgressSummaryState.summary ? (
                    `学习进度 ${visibleProgressSummaryState.summary.progress.toFixed(1)}%`
                  ) : visibleProgressSummaryState.status === 'failed' ? (
                    <>
                      <span role="alert">统计暂时无法加载</span>
                      <button type="button" onClick={retryProgressSummary}>
                        重试
                      </button>
                    </>
                  ) : (
                    <span role="status">正在读取学习统计…</span>
                  )
                }
                detailClassName={
                  visibleProgressSummaryState.status === 'failed' ? 'metric-detail-error' : ''
                }
                className={
                  visibleProgressSummaryState.status === 'failed' ? 'has-detail-action' : ''
                }
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
            {visiblePlansStatus !== 'ready' && (
              <StudyPlanLoadNotice status={visiblePlansStatus} onRetry={retryPlanLoad} />
            )}
            {activeTab === 'words' && (
              <WordsPanel
                session={session}
                bookId={currentBook?.id ?? null}
                onCreatePlan={openPlanPreview}
                existingPlan={visiblePlans.find((plan) => plan.blocksNewPlanCreation) ?? null}
                onOpenExistingPlan={openPlanPreview}
                onOpenReadingSettings={() => setReadingSettingsOpen(true)}
                planListReady={visiblePlansStatus === 'ready'}
                onProgressChanged={() => setProgressRevision((current) => current + 1)}
              />
            )}
            {activeTab === 'plan' && visiblePlansStatus === 'ready' && (
              <PlanPanel
                plan={
                  visiblePlans.find(
                    (plan) => plan.status === 'ACTIVE' || plan.status === 'GENERATING',
                  ) ?? null
                }
                onContinue={(id) => setLessonPlanId(id)}
              />
            )}
            {activeTab === 'history' && visiblePlansStatus === 'ready' && (
              <LearningHistory
                plans={visiblePlans}
                onContinue={(id) => setLessonPlanId(id)}
                onRetry={openPlanPreview}
              />
            )}
            <DailySentenceCard key={session.user.id} session={session} layout="strip" />
            <PracticeEntries />
          </div>
        ) : page === 'travel' || page === 'assessment' ? (
          <TravelScenarioPage
            key={session.user.id}
            session={session}
            startWithAssessment={page === 'assessment'}
            onBack={() => returnToPage('study')}
          />
        ) : page === 'learning' ? (
          <LearningWordsPage
            key={session.user.id}
            session={session}
            onBack={() => returnToPage('study')}
          />
        ) : page === 'mistakes' ? (
          <MistakesPage
            key={session.user.id}
            session={session}
            onBack={() => returnToPage('study')}
            onOpenTutorSettings={
              session.user.role === 'ADMIN'
                ? () => {
                    setSettingsSection('system');
                    setPage('settings');
                  }
                : undefined
            }
            onPlanCreated={(plan) => {
              setPlans((current) => [plan, ...current.filter((item) => item.id !== plan.id)]);
              openPlanPreview(plan);
            }}
          />
        ) : page === 'mastered' ? (
          <MasteredWordsPage
            key={session.user.id}
            session={session}
            onBack={() => returnToPage('study')}
            onProgressChanged={() => setProgressRevision((current) => current + 1)}
          />
        ) : page === 'history' ? (
          <LearningHistoryPage
            session={session}
            backLabel={historyBackPage === 'statistics' ? '返回学习统计' : '返回学习进度'}
            onBack={() => returnToPage(historyBackPage)}
          />
        ) : page === 'statistics' ? (
          <StatisticsPage
            session={session}
            onBack={() => returnToPage('study')}
            onOpenHistory={() => {
              setHistoryBackPage('statistics');
              setPage('history');
            }}
            onNavigate={(target) => {
              if (target === 'mistakes') setPage('mistakes');
              else if (target === 'assessment') setPage('assessment');
              else if (target === 'travel') setPage('travel');
              else {
                setActiveTab('words');
                setPage('study');
              }
            }}
          />
        ) : (
          <AccountSettings
            session={session}
            initialSection={settingsSection}
            onBack={() => returnToPage('study')}
            onLearningReset={() => {
              setPlans([]);
              setPreviewPlan(null);
              setLessonPlanId(null);
              setProgressRevision((current) => current + 1);
            }}
          />
        )}
      </section>
      {accountMenuOpen && accountMenuPortalContainer
        ? createPortal(
            <AccountMenu
              name={name}
              isAdmin={session.user.role === 'ADMIN'}
              popoverRef={accountMenuPopoverRef}
              position={accountMenuPosition}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') {
                  cancelAccountMenuHoverClose();
                  sidebarAccountHoveredRef.current = true;
                }
              }}
              onPointerLeave={(event) => {
                if (event.pointerType !== 'mouse') return;
                const relatedTarget = event.relatedTarget;
                if (
                  relatedTarget instanceof Node &&
                  sidebarAccountButtonRef.current?.contains(relatedTarget)
                ) {
                  cancelAccountMenuHoverClose();
                  sidebarAccountHoveredRef.current = true;
                  return;
                }
                scheduleAccountMenuHoverClose();
              }}
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
            />,
            accountMenuPortalContainer,
          )
        : null}
      {bookPickerOpen && (
        <BookPicker session={session} onClose={closeBookPicker} onActivated={activateCurrentBook} />
      )}
      {visiblePreviewPlan && (
        <PlanPreview
          key={`${previewOwnerId}:${visiblePreviewPlan.id}`}
          plan={visiblePreviewPlan}
          session={session}
          onPlanUpdated={(updated) => {
            if (currentUserIdRef.current !== previewOwnerId) return;
            setPlans((current) => {
              if (currentUserIdRef.current !== previewOwnerId) return current;
              return [updated, ...current.filter((item) => item.id !== updated.id)];
            });
            setPreviewPlan((current) => {
              if (currentUserIdRef.current !== previewOwnerId || current?.id !== updated.id) {
                return current;
              }
              return updated;
            });
          }}
          onClose={() => setPreviewPlan(null)}
          onOpenModelSettings={() => {
            setPreviewPlan(null);
            setReadingSettingsOpen(true);
          }}
          onStart={() => {
            if (currentUserIdRef.current !== previewOwnerId) return;
            setPlans((current) => {
              if (currentUserIdRef.current !== previewOwnerId) return current;
              return [
                { ...visiblePreviewPlan },
                ...current.filter((plan) => plan.id !== visiblePreviewPlan.id),
              ];
            });
            setPreviewPlan(null);
            setPage('study');
            setLessonPlanId(visiblePreviewPlan.id);
          }}
        />
      )}
      {readingSettingsOpen && (
        <ReadingModelDrawer
          key={session.user.id}
          session={session}
          onClose={() => setReadingSettingsOpen(false)}
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
  const queryClient = useQueryClient();
  const queryKey = [
    'vocabulary',
    'mastered',
    session.user.id,
    VOCABULARY_ARCHIVE_PAGE_SIZE,
  ] as const;
  const learningQueryKey = [
    'vocabulary',
    'learning-words',
    session.user.id,
    VOCABULARY_ARCHIVE_PAGE_SIZE,
  ] as const;
  const archiveQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : '';
      return request<VocabularyArchivePage<MasteredWord>>(
        `/vocabulary/mastered?pageSize=${VOCABULARY_ARCHIVE_PAGE_SIZE}${cursor}`,
        {},
        session.accessToken,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnMount: 'always',
    retry: false,
  });
  const words = archiveQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = archiveQuery.data?.pages.at(-1)?.total ?? 0;
  const message =
    archiveQuery.error instanceof Error ? archiveQuery.error.message : '已掌握单词加载失败';
  const [removingId, setRemovingId] = useState<string>();
  const [actionMessage, setActionMessage] = useState('');
  const retryLoad = () => void archiveQuery.refetch();
  const removeMastered = async (word: MasteredWord) => {
    setRemovingId(word.id);
    setActionMessage('');
    try {
      await queryClient.cancelQueries({ queryKey });
      await request(`/vocabulary/mastered/${word.id}`, { method: 'DELETE' }, session.accessToken);
      queryClient.setQueryData<InfiniteData<VocabularyArchivePage<MasteredWord>, string | null>>(
        queryKey,
        (current) => {
          if (!current?.pages.some((page) => page.items.some((item) => item.id === word.id))) {
            return current;
          }
          return {
            ...current,
            pages: current.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => item.id !== word.id),
              total: Math.max(0, page.total - 1),
            })),
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: learningQueryKey });
      onProgressChanged();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : '移除已掌握失败');
      void queryClient.invalidateQueries({ queryKey });
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
          <b>{archiveQuery.data ? total : '—'}</b>
          <span>词</span>
        </div>
      </header>
      {archiveQuery.isPending && (
        <WordArchiveLoadState kind="mastered" status="loading" onRetry={retryLoad} />
      )}
      {archiveQuery.isError && !archiveQuery.data && (
        <WordArchiveLoadState
          kind="mastered"
          status="error"
          message={message}
          onRetry={retryLoad}
        />
      )}
      {archiveQuery.data && actionMessage && (
        <p className="book-message" role="alert">
          {actionMessage}
        </p>
      )}
      {archiveQuery.data && archiveQuery.isRefetchError && !archiveQuery.isFetchNextPageError && (
        <div className="word-archive-pagination">
          <p role="alert">{message}，仍显示已加载的记录。</p>
          <button type="button" onClick={retryLoad} disabled={archiveQuery.isFetching}>
            重试更新
          </button>
        </div>
      )}
      {archiveQuery.data && archiveQuery.isFetching && !archiveQuery.isFetchingNextPage && (
        <p className="word-archive-refresh" role="status">
          正在更新已掌握的单词…
        </p>
      )}
      {archiveQuery.data && !words.length && (
        <div className="mastered-empty word-archive-state">
          <CheckCircle2 size={34} />
          <strong>还没有已掌握的单词</strong>
          <p>在新单词列表中点击“标记掌握”，它就会出现在这里。</p>
          <button onClick={onBack}>去学习单词</button>
        </div>
      )}
      {archiveQuery.data && words.length > 0 && (
        <div className="mastered-list">
          {words.map((word) => (
            <article key={word.id}>
              <div>
                <strong>{word.word}</strong>
                <PhoneticLine word={word} />
                <MeaningLines word={word} />
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
      {archiveQuery.data && (archiveQuery.hasNextPage || archiveQuery.isFetchNextPageError) && (
        <div className="word-archive-pagination" aria-live="polite">
          {archiveQuery.isFetchNextPageError && <p role="alert">{message}，已加载的单词仍保留。</p>}
          <button
            type="button"
            onClick={() => void archiveQuery.fetchNextPage({ cancelRefetch: false })}
            disabled={archiveQuery.isFetchingNextPage}
          >
            {archiveQuery.isFetchingNextPage
              ? '正在加载…'
              : archiveQuery.isFetchNextPageError
                ? '重试加载更多'
                : `加载更多（已显示 ${words.length} / ${total}）`}
          </button>
        </div>
      )}
    </section>
  );
}

function LearningWordsPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const queryKey = [
    'vocabulary',
    'learning-words',
    session.user.id,
    VOCABULARY_ARCHIVE_PAGE_SIZE,
  ] as const;
  const archiveQuery = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : '';
      return request<VocabularyArchivePage<LearningWord>>(
        `/vocabulary/learning-words?pageSize=${VOCABULARY_ARCHIVE_PAGE_SIZE}${cursor}`,
        {},
        session.accessToken,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnMount: 'always',
    retry: false,
  });
  const words = archiveQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = archiveQuery.data?.pages.at(-1)?.total ?? 0;
  const message =
    archiveQuery.error instanceof Error ? archiveQuery.error.message : '学习中单词加载失败';
  const retryLoad = () => void archiveQuery.refetch();
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
          <b>{archiveQuery.data ? total : '—'}</b>
          <span>词</span>
        </div>
      </header>
      {archiveQuery.isPending && (
        <WordArchiveLoadState kind="learning" status="loading" onRetry={retryLoad} />
      )}
      {archiveQuery.isError && !archiveQuery.data && (
        <WordArchiveLoadState
          kind="learning"
          status="error"
          message={message}
          onRetry={retryLoad}
        />
      )}
      {archiveQuery.data && archiveQuery.isRefetchError && !archiveQuery.isFetchNextPageError && (
        <div className="word-archive-pagination">
          <p role="alert">{message}，仍显示已加载的记录。</p>
          <button type="button" onClick={retryLoad} disabled={archiveQuery.isFetching}>
            重试更新
          </button>
        </div>
      )}
      {archiveQuery.data && archiveQuery.isFetching && !archiveQuery.isFetchingNextPage && (
        <p className="word-archive-refresh" role="status">
          正在更新学习中的单词…
        </p>
      )}
      {archiveQuery.data && !words.length && (
        <div className="mastered-empty word-archive-state">
          <BookOpen size={34} />
          <strong>还没有学习中的单词</strong>
          <p>创建学习计划或将新单词加入复习后，会在这里追踪学习表现。</p>
          <button onClick={onBack}>去学习单词</button>
        </div>
      )}
      {archiveQuery.data && words.length > 0 && (
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
                <PhoneticLine word={word} />
                <MeaningLines word={word} />
                <small>{word.bookTitle}</small>
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
      {archiveQuery.data && (archiveQuery.hasNextPage || archiveQuery.isFetchNextPageError) && (
        <div className="word-archive-pagination" aria-live="polite">
          {archiveQuery.isFetchNextPageError && <p role="alert">{message}，已加载的单词仍保留。</p>}
          <button
            type="button"
            onClick={() => void archiveQuery.fetchNextPage({ cancelRefetch: false })}
            disabled={archiveQuery.isFetchingNextPage}
          >
            {archiveQuery.isFetchingNextPage
              ? '正在加载…'
              : archiveQuery.isFetchNextPageError
                ? '重试加载更多'
                : `加载更多（已显示 ${words.length} / ${total}）`}
          </button>
        </div>
      )}
    </section>
  );
}

function WordArchiveLoadState({
  kind,
  status,
  message,
  onRetry,
}: {
  kind: 'learning' | 'mastered';
  status: 'loading' | 'error';
  message?: string;
  onRetry: () => void;
}) {
  const isLearning = kind === 'learning';
  const Icon = status === 'loading' ? (isLearning ? BookOpen : CheckCircle2) : AlertTriangle;
  const noun = isLearning ? '学习中的单词' : '已掌握的单词';

  return (
    <div
      className={`mastered-empty word-archive-state ${status === 'loading' ? 'is-loading' : 'is-error'}`}
      role={status === 'loading' ? 'status' : 'alert'}
      aria-busy={status === 'loading'}
    >
      <Icon size={34} />
      <strong>{status === 'loading' ? `正在读取${noun}…` : `${noun}暂时无法加载`}</strong>
      {status === 'loading' ? (
        <span className="word-archive-skeleton" aria-hidden="true">
          <i />
          <i />
        </span>
      ) : (
        <>
          <p>{message || '请检查网络连接后重试。'}</p>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </>
      )}
    </div>
  );
}

type LearningStreakSummary = { currentStreak: number; todayActive: boolean };

function StreakCard({ session }: { session: Session }) {
  const [summary, setSummary] = useState<LearningStreakSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    request<LearningStreakSummary>(
      `/reports/streak?timeZone=${encodeURIComponent(browserTimeZone())}`,
      {},
      session.accessToken,
    )
      .then((result) => {
        if (!isLearningStreakSummary(result)) throw new Error('Invalid learning streak response');
        if (active) setSummary(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [session.accessToken]);

  return (
    <div className="streak-card-wrap">
      <article className="streak-card">
        <div className="streak-front">
          <div className="streak-content">
            <div className="card-heading">
              <strong>连续学习</strong>
              <Flame size={18} />
            </div>
            <p role="status">
              {!summary
                ? failed
                  ? '学习记录暂时无法加载。'
                  : '正在读取真实学习记录…'
                : summary.todayActive
                  ? '今天已有学习记录。'
                  : '今天还没有已完成的学习活动。'}
            </p>
            <a className="streak-start-link" href="/dashboard/micro-stories">
              <BookOpen size={17} aria-hidden="true" />
              <span>开始一分钟微故事</span>
              <ChevronRight size={17} aria-hidden="true" />
            </a>
          </div>
          <div className="streak-count">
            <b>{summary ? summary.currentStreak : '—'}</b>
            <Flame size={26} aria-hidden="true" />
            <small>连续天</small>
          </div>
        </div>
      </article>
    </div>
  );
}

function isLearningStreakSummary(value: unknown): value is LearningStreakSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger((value as LearningStreakSummary).currentStreak) &&
    (value as LearningStreakSummary).currentStreak >= 0 &&
    typeof (value as LearningStreakSummary).todayActive === 'boolean'
  );
}

function AccountMenu({
  name,
  isAdmin,
  popoverRef,
  position,
  onPointerEnter,
  onPointerLeave,
  onSettings,
  onSystemSettings,
  onLogout,
}: {
  name: string;
  isAdmin: boolean;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  position: { left: number; top: number } | null;
  onPointerEnter: React.PointerEventHandler<HTMLDivElement>;
  onPointerLeave: React.PointerEventHandler<HTMLDivElement>;
  onSettings: () => void;
  onSystemSettings: () => void;
  onLogout: () => void;
}) {
  return (
    <div
      className="account-menu"
      id="account-menu"
      aria-label="账户菜单"
      aria-hidden={!position}
      data-positioned={position ? 'true' : 'false'}
      ref={popoverRef}
      style={{
        left: position?.left ?? -10000,
        top: position?.top ?? -10000,
        visibility: position ? 'visible' : 'hidden',
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="account-menu-user">
        <Avatar />
        <strong aria-label={name} title={name}>
          {name}
        </strong>
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
      await request('/vocabulary/learning-records', { method: 'DELETE' }, session.accessToken);
      try {
        localStorage.removeItem(`lexloop.output.draft.${session.user.id}`);
      } catch {
        /* Storage is optional. */
      }
      clearMicroStoryDrafts(session.user.id);
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
                <p>
                  清除所有个人学习计划、旅行场景会话、水平测评、答题结果、复习排期、个人生词本、精读与语法专项记录、微故事进度及理解偏差、学习中及已掌握单词。账号、系统词书、模型、偏好设置和可复用的
                  AI 内容都会保留。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setClearMessage('');
                  setClearDialogOpen(true);
                }}
              >
                <Trash2 size={18} />
                清理学习记录
              </button>
            </section>
            {clearMessage && (
              <p
                className={
                  clearMessage.startsWith('学习记录已')
                    ? 'settings-clear-success'
                    : 'settings-clear-error'
                }
              >
                {clearMessage}
              </p>
            )}
          </section>
        )}
      </div>
      {clearDialogOpen && (
        <div
          className="learning-clear-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="learning-clear-title"
        >
          <button
            className="learning-clear-scrim"
            aria-label="取消清理"
            onClick={() => !clearing && setClearDialogOpen(false)}
          />
          <section className="learning-clear-dialog">
            <span className="learning-clear-icon">
              <AlertTriangle size={29} />
            </span>
            <p>DANGER ZONE</p>
            <h2 id="learning-clear-title">确认清理全部学习记录？</h2>
            <div>
              <strong>此操作无法撤销</strong>
              <span>
                当前学习序列、输出挑战、易混词训练、旅行场景、水平画像、旅行生词、历史答题、复习时间、统计数据和已掌握状态都会被清空。
              </span>
              <small>
                账号、已添加词书、大模型配置、每日新词数量以及公共 AI 阅读材料与题目不会改变。
              </small>
            </div>
            {clearMessage && <p className="settings-clear-error">{clearMessage}</p>}
            <footer>
              <button
                type="button"
                className="secondary"
                disabled={clearing}
                onClick={() => setClearDialogOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="confirm-danger"
                disabled={clearing}
                onClick={() => void clearLearningRecords()}
              >
                <Trash2 size={17} />
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
  detailClassName,
  className,
  backIcon,
  backText,
  backColor,
}: {
  title: string;
  value: string;
  detail: React.ReactNode;
  detailClassName?: string;
  className?: string;
  backIcon?: React.ReactNode;
  backText?: string;
  backColor?: string;
}) {
  return (
    <article
      className={`metric-card ${className ?? ''}`}
      style={{ '--back-color': backColor } as React.CSSProperties}
    >
      <div className="metric-front">
        <span>{title}</span>
        <b>{value}</b>
        <small className={detailClassName}>{detail}</small>
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
  bookId,
  onCreatePlan,
  existingPlan,
  onOpenExistingPlan,
  onOpenReadingSettings,
  planListReady,
  onProgressChanged,
}: {
  session: Session;
  bookId: string | null;
  onCreatePlan: (plan: LearningPlan) => void;
  existingPlan: LearningPlan | null;
  onOpenExistingPlan: (plan: LearningPlan) => void;
  onOpenReadingSettings: () => void;
  planListReady: boolean;
  onProgressChanged: () => void;
}) {
  const [mode, setMode] = useState<StudyMode>('group');
  const [individualSource, setIndividualSource] = useState<IndividualWordSource>('book');
  const [individualCount, setIndividualCount] = useState(10);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dashboardWords, setDashboardWords] = useState<DashboardWords>({
    defaultNewWordCount: 10,
    reviewWords: [],
    newWords: [],
  });
  const [reviewSelection, setReviewSelection] = useState<{ scope: string; count: number } | null>(
    null,
  );
  const [displayNewWordCount, setDisplayNewWordCount] = useState<number>();
  const [message, setMessage] = useState('');
  const [loadedBookId, setLoadedBookId] = useState<string | null>(null);
  const [wordsLoadStatus, setWordsLoadStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [wordsLoadError, setWordsLoadError] = useState('');
  const [failedWordCount, setFailedWordCount] = useState<number>();
  const wordsLoadRequestRef = useRef(0);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const creatingPlanRef = useRef(false);
  const bookWordsReady = bookId !== null && loadedBookId === bookId && wordsLoadStatus === 'ready';
  const visibleDashboardWords = bookWordsReady
    ? dashboardWords
    : { defaultNewWordCount: dashboardWords.defaultNewWordCount, reviewWords: [], newWords: [] };
  const newWordCount = displayNewWordCount ?? visibleDashboardWords.defaultNewWordCount;
  const reviewScope = `${session.user.id}:${bookId ?? ''}`;
  const loadWords = useCallback(
    async (count?: number) => {
      const requestId = ++wordsLoadRequestRef.current;
      setWordsLoadStatus('loading');
      setWordsLoadError('');
      setFailedWordCount(undefined);
      try {
        const query = count ? `?newWordCount=${count}` : '';
        const next = await request<DashboardWords>(
          `/vocabulary/dashboard-words${query}`,
          {},
          session.accessToken,
        );
        if (requestId !== wordsLoadRequestRef.current) return;
        setDashboardWords(next);
        setDisplayNewWordCount(count ?? next.defaultNewWordCount);
        setLoadedBookId(bookId);
        setWordsLoadStatus('ready');
        setMessage('');
      } catch (error) {
        if (requestId !== wordsLoadRequestRef.current) return;
        setWordsLoadError(error instanceof Error ? error.message : '学习词汇加载失败');
        setFailedWordCount(count);
        setWordsLoadStatus('failed');
      }
    },
    [bookId, session.accessToken],
  );
  useEffect(() => {
    void loadWords();
    return () => {
      wordsLoadRequestRef.current++;
    };
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
  const reviewCount = visibleDashboardWords.reviewWords.length;
  const reviewLimit = Math.min(reviewCount, MAX_DAILY_REVIEW_WORDS);
  const existingReviewCount =
    existingPlan?.words.filter((word) => word.source === 'REVIEW').length ?? 0;
  const existingNewWordCount =
    existingPlan?.words.filter((word) => word.source === 'NEW').length ?? 0;
  const selectedReviewCount = Math.min(
    existingPlan
      ? existingReviewCount
      : reviewSelection?.scope === reviewScope
        ? reviewSelection.count
        : reviewLimit,
    existingPlan ? existingReviewCount : reviewLimit,
  );
  const selectedNewWordCount = existingPlan
    ? existingNewWordCount
    : visibleDashboardWords.newWords.length;
  const totalWordCount = existingPlan
    ? existingPlan.wordCount
    : selectedReviewCount + selectedNewWordCount;
  const reviewShare = totalWordCount ? `${(selectedReviewCount / totalWordCount) * 100}%` : '0%';
  const createPlan = async () => {
    if (existingPlan) {
      onOpenExistingPlan(existingPlan);
      return;
    }
    if (creatingPlanRef.current || !bookWordsReady) return;
    creatingPlanRef.current = true;
    setCreatingPlan(true);
    try {
      const plan = await request<LearningPlan>(
        '/study/plans',
        {
          method: 'POST',
          body: JSON.stringify(
            mode === 'individual'
              ? {
                  mode,
                  selection: individualSource,
                  newWordCount: individualCount,
                  reviewWordCount: 0,
                }
              : {
                  newWordCount: visibleDashboardWords.newWords.length,
                  reviewWordCount: selectedReviewCount,
                  mode,
                },
          ),
        },
        session.accessToken,
      );
      onCreatePlan(plan);
    } catch (error) {
      const text = error instanceof Error ? error.message : '创建学习计划失败';
      setMessage(text);
      if (text.includes('大模型')) onOpenReadingSettings();
    } finally {
      creatingPlanRef.current = false;
      setCreatingPlan(false);
    }
  };
  return (
    <section className="words-panel">
      <header className="panel-top">
        <div className="panel-title">
          <BookOpen size={18} />
          <strong>今日学习词汇</strong>
        </div>
        <div
          className="panel-progress"
          aria-label={
            existingPlan
              ? `当前计划：复习 ${selectedReviewCount} 词，新单词 ${selectedNewWordCount} 词`
              : `今日学习构成：本次复习 ${selectedReviewCount} 词，共有 ${reviewCount} 词到期，新单词 ${selectedNewWordCount} 词`
          }
        >
          <div className="panel-progress-labels">
            <span className="is-review">
              {existingPlan ? '当前计划复习' : '本次复习'} <b>{selectedReviewCount}</b>
            </span>
            <span className="is-new">
              新单词 <b>{selectedNewWordCount}</b>
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
          <Tooltip label="原创应试语境，练熟词僻义和搭配">
            <button
              className={`real ${mode === 'exam' ? 'selected' : ''}`}
              onClick={() => setMode('exam')}
            >
              <span>◎</span> 应试语境
            </button>
          </Tooltip>
          <button
            className="create"
            onClick={() => void createPlan()}
            disabled={
              creatingPlan ||
              !planListReady ||
              (!existingPlan &&
                mode === 'individual' &&
                individualSource !== 'mistakes' &&
                !bookWordsReady) ||
              (!existingPlan && mode !== 'individual' && !bookWordsReady) ||
              (!existingPlan &&
                mode !== 'individual' &&
                !visibleDashboardWords.newWords.length &&
                selectedReviewCount === 0)
            }
          >
            {existingPlan?.status === 'FAILED' ? <Sparkles size={15} /> : <BookOpen size={15} />}
            {creatingPlan
              ? '正在创建学习计划…'
              : !planListReady
                ? '先读取已有计划'
                : existingPlan?.status === 'FAILED'
                  ? '打开并重试当前计划'
                  : existingPlan
                    ? '打开当前学习计划'
                    : '创建学习计划'}
          </button>
          <Tooltip label="模型设置">
            <button
              className="mode-settings-trigger"
              aria-label="阅读材料模型设置"
              onClick={onOpenReadingSettings}
            >
              <FilterSettingsIcon />
            </button>
          </Tooltip>
        </div>
      </header>
      {mode === 'exam' && !existingPlan && (
        <p className="mode-note">
          应试语境使用本次复习词和新词，生成原创短文。题型侧重熟词僻义、固定搭配和同义替换，不引用真题原卷。
        </p>
      )}
      {mode === 'individual' && !existingPlan && (
        <div className="word-source-bar">
          <span>选词来源</span>
          <div role="group" aria-label="独立单词来源">
            {INDIVIDUAL_SOURCES.map((source) => (
              <button
                key={source.id}
                type="button"
                className={individualSource === source.id ? 'selected' : ''}
                aria-pressed={individualSource === source.id}
                onClick={() => setIndividualSource(source.id)}
              >
                {source.label}
              </button>
            ))}
          </div>
          <label htmlFor="individual-word-count">
            数量
            <input
              id="individual-word-count"
              type="range"
              min={1}
              max={20}
              step={1}
              value={individualCount}
              onChange={(event) => setIndividualCount(Number(event.target.value))}
            />
            <output htmlFor="individual-word-count">{individualCount}</output>
          </label>
          <p>{INDIVIDUAL_SOURCES.find((source) => source.id === individualSource)?.hint}</p>
        </div>
      )}
      {existingPlan ? (
        <div className="review-session-control" role="status">
          <strong>
            {existingPlan.status === 'FAILED'
              ? '今天的计划生成失败'
              : existingPlan.status === 'GENERATING'
                ? '已有计划正在生成'
                : '先完成当前学习计划'}
          </strong>
          <p>
            当前计划包含 {existingReviewCount} 个复习词和 {existingNewWordCount}{' '}
            个新词；打开它不会创建新计划或改变词汇数量。
            {existingPlan.status !== 'FAILED' && ' 完成后可再选择下一次的复习数量。'}
          </p>
        </div>
      ) : mode !== 'individual' && reviewCount > 0 ? (
        <div className="review-session-control">
          <label htmlFor="review-session-count">本次复习数量</label>
          <input
            id="review-session-count"
            aria-label="本次复习数量"
            type="range"
            min={0}
            max={reviewLimit}
            step={1}
            value={selectedReviewCount}
            onChange={(event) =>
              setReviewSelection({ scope: reviewScope, count: Number(event.target.value) })
            }
          />
          <output htmlFor="review-session-count">
            {selectedReviewCount} / {reviewCount} 个到期
          </output>
          <p aria-live="polite">
            {reviewCount > selectedReviewCount
              ? `${reviewCount - selectedReviewCount} 个仍待复习，可留到下一次计划。`
              : '本次会安排当前全部到期词。'}
            {reviewCount > MAX_DAILY_REVIEW_WORDS &&
              ` 每份计划最多安排 ${MAX_DAILY_REVIEW_WORDS} 个复习词。`}
          </p>
        </div>
      ) : null}
      {message && <p className="book-message">{message}</p>}
      {wordsLoadStatus === 'loading' && (
        <p className="book-message" role="status">
          正在读取当前词表的单词…
        </p>
      )}
      {wordsLoadError && (
        <div className="book-message words-load-error" role="alert">
          <span>{wordsLoadError}</span>
          <button type="button" onClick={() => void loadWords(failedWordCount)}>
            重试加载
          </button>
        </div>
      )}
      <div className="word-columns">
        <WordColumn
          title="待复习单词"
          count={String(reviewCount)}
          icon={<ReviewWordsIcon />}
          words={visibleDashboardWords.reviewWords.map((word) => ({ ...word, state: 'review' }))}
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
          count={String(visibleDashboardWords.newWords.length)}
          icon={<NewWordsIcon />}
          words={visibleDashboardWords.newWords}
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
          value={visibleDashboardWords.defaultNewWordCount}
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
    </section>
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
            <Tooltip label="单词数量">
              <button onClick={onOpenSettings} aria-label="单词数量">
                <GearIcon />
              </button>
            </Tooltip>
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
        <PhoneticLine word={word} />
        <MeaningLines word={word} />
      </div>
      <div className="word-actions">
        {word.state === 'review' && (
          <button className="reviewing">
            <TimerReset size={14} />
            复习中
          </button>
        )}
        {!word.state && (
          <Tooltip label="加入复习">
            <button aria-label="加入复习" onClick={() => void onAddToReview?.(word)}>
              <ListRestart size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip label="标记掌握">
          <button aria-label="标记掌握" onClick={() => void onMarkMastered?.(word)}>
            <CheckCircle2 size={16} />
          </button>
        </Tooltip>
        <Tooltip label="稍后再学">
          <button aria-label="稍后再学" onClick={() => void onDefer?.(word)}>
            <TimerReset size={16} />
          </button>
        </Tooltip>
      </div>
    </article>
  );
}

function MeaningLines({ word }: { word: Pick<Word, 'part' | 'meaning' | 'meanings'> }) {
  const lines = meaningLinesOf(word);
  return (
    <div className="meaning-lines">
      {lines.map((line, index) => (
        <p key={`${line.part}-${index}`}>
          {line.part ? <span>{line.part}</span> : null}
          {line.text}
        </p>
      ))}
    </div>
  );
}

function PhoneticLine({ word }: { word: Pick<Word, 'word' | 'ukPhonetic' | 'usPhonetic'> }) {
  const uk = formatPhonetic(word.ukPhonetic, word.word);
  const us = formatPhonetic(word.usPhonetic, word.word);
  if (!uk && !us) return null;
  return (
    <small className="word-phonetic">
      {uk ? <span>英 {uk}</span> : null}
      {us ? <span>美 {us}</span> : null}
    </small>
  );
}

const modeLabel = { group: '分组学习', individual: '单词模式', exam: '应试语境' } as const;

function PlanPreview({
  plan,
  session,
  onClose,
  onOpenModelSettings,
  onStart,
  onPlanUpdated,
}: {
  plan: LearningPlan;
  session: Session;
  onClose: () => void;
  onOpenModelSettings: () => void;
  onStart: () => void;
  onPlanUpdated: (plan: LearningPlan) => void;
}) {
  const [index, setIndex] = useState(0);
  const [generating, setGenerating] = useState(plan.status === 'GENERATING');
  const [generationMessage, setGenerationMessage] = useState('');
  const [audioNote, setAudioNote] = useState('');
  const needsModelSelection = generationMessage.includes('阅读材料模型设置');
  const generationStartedRef = useRef(false);
  const generationRequestInFlightRef = useRef(false);
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
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        const result = speakEnglish(word.word);
        setAudioNote(
          result === 'played'
            ? ''
            : result === 'no-voice'
              ? '浏览器没有提供标记为本地服务的英语语音，可直接看词。'
              : '当前浏览器不支持语音播放。',
        );
      }
    };
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [onClose, plan.wordCount, word.word]);

  const refreshPlan = useCallback(async () => {
    const plans = await request<LearningPlan[]>('/study/plans', {}, session.accessToken);
    return plans.find((item) => item.id === plan.id) ?? null;
  }, [plan.id, session.accessToken]);

  const generate = useCallback(async () => {
    if (generationRequestInFlightRef.current) return;
    generationRequestInFlightRef.current = true;
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
      void refreshPlan()
        .then((updated) => {
          if (updated) onPlanUpdated(updated);
        })
        .catch(() => undefined);
    } finally {
      generationRequestInFlightRef.current = false;
      setGenerating(false);
    }
  }, [onPlanUpdated, plan.id, refreshPlan, session.accessToken]);

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
      void refreshPlan()
        .then((updated) => {
          if (!cancelled && updated) onPlanUpdated(updated);
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
  }, [generating, onPlanUpdated, plan.id, plan.status, refreshPlan, session.accessToken]);

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
            <p>
              {generating || plan.status === 'GENERATING'
                ? `${plan.purpose === 'weakness' ? '薄弱词专项' : '学习计划'}生成中，先预习一下…`
                : plan.status === 'FAILED'
                  ? '学习计划生成失败'
                  : plan.purpose === 'weakness'
                    ? '薄弱词专项生成完毕'
                    : '学习计划生成完毕'}
            </p>
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
              {formatPhonetic(word.ukPhonetic, word.word) ||
              formatPhonetic(word.usPhonetic, word.word) ? (
                <>
                  {formatPhonetic(word.ukPhonetic, word.word) && (
                    <span>英 {formatPhonetic(word.ukPhonetic, word.word)}</span>
                  )}
                  {formatPhonetic(word.usPhonetic, word.word) && (
                    <span>美 {formatPhonetic(word.usPhonetic, word.word)}</span>
                  )}
                </>
              ) : (
                <span className="phonetic-empty">暂无音标</span>
              )}
              <button
                type="button"
                aria-label={`播放 ${word.word} 发音`}
                onClick={() => {
                  const result = speakEnglish(word.word);
                  setAudioNote(
                    result === 'played'
                      ? ''
                      : result === 'no-voice'
                        ? '浏览器没有提供标记为本地服务的英语语音，可直接看词。'
                        : '当前浏览器不支持语音播放。',
                  );
                }}
              >
                <SpeakerIcon />
              </button>
            </div>
            {audioNote && <p className="phonetic-note">{audioNote}</p>}
            <hr />
            <MeaningLines word={word} />
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
        {generationMessage && (
          <p className="book-message" role="alert" aria-live="assertive">
            {generationMessage}
          </p>
        )}
        {plan.status === 'FAILED' || generationMessage ? (
          <button
            className="start-challenge"
            onClick={needsModelSelection ? onOpenModelSettings : () => void generate()}
            disabled={generating}
          >
            <Sparkles size={19} />
            {generating
              ? '正在重新生成…'
              : needsModelSelection
                ? '设置阅读材料模型'
                : '重新生成学习计划'}
          </button>
        ) : (
          <button
            className="start-challenge"
            onClick={onStart}
            disabled={generating || plan.status !== 'ACTIVE'}
          >
            <Play size={19} />
            {generating || plan.status === 'GENERATING'
              ? '题目生成中，请稍候'
              : plan.purpose === 'weakness'
                ? '开始薄弱词专项'
                : '开始今天的挑战'}
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
  const groupCompletion = studyGroupCompletion(groups);
  const currentGroupIndex = groupCompletion.currentGroupIndex;
  const groupProgressLabel =
    currentGroupIndex >= 0
      ? `第 ${currentGroupIndex + 1}/${groups.length} 组`
      : `已完成 ${groups.length} 组`;
  return (
    <section className="sequence-panel">
      <header className="sequence-head">
        <div>
          <BookOpen size={23} />
          <strong>学习序列</strong>
          <span>{modeLabel[plan.mode]}</span>
          <span>{plan.purpose === 'weakness' ? '薄弱词专项' : '正常模式'}</span>
          <span>{groupProgressLabel}</span>
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
            {plan.status === 'GENERATING' ? <Sparkles size={18} /> : <BookOpen size={18} />}
            {plan.status === 'GENERATING'
              ? '题目生成中'
              : plan.completed === plan.wordCount
                ? '已完成'
                : '继续学习'}
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
              <b className={groupCompletion.completedGroups[index] ? 'done' : ''}>{index + 1}</b>
              <strong>{group.map((word) => word.word).join(' · ')}</strong>
              <BookOpen size={20} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CefrBadge({ level }: { level: string }) {
  return (
    <span className="sense-level" tabIndex={0} aria-label={`CEFR ${level}`}>
      <em>{level}</em>
      <span className="sense-level-tooltip">
        <strong>CEFR {level}</strong>
        <p>这是词条上记录的等级。没有等级时不显示徽章。</p>
      </span>
    </span>
  );
}

function WordMeaningCard({ word }: { word: Word }) {
  const lines = meaningLinesOf(word);
  return (
    <section className="word-meaning-card">
      <div className="word-meaning-word">
        <strong>{word.word}</strong>
      </div>
      <div className="meaning-senses">
        {lines.map((line, index) => (
          <p key={`${line.part}-${index}`}>
            {line.part ? <b className="pos-label">{line.part}</b> : <b>{index + 1}</b>}
            {line.text}
          </p>
        ))}
      </div>
      {word.cefrLevel ? <CefrBadge level={word.cefrLevel} /> : null}
    </section>
  );
}

function SavedReviewContext({ context }: { context: NonNullable<Word['savedContext']> }) {
  return (
    <aside className="saved-review-context">
      <strong>收藏时的原句</strong>
      {context.scenario && <small>{context.scenario}</small>}
      <p lang="en">{context.example}</p>
    </aside>
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

function SynonymDemo({
  word,
  result,
  onAnswer,
}: {
  word: Word;
  result: boolean | undefined;
  onAnswer: (correct: boolean) => void;
}) {
  return (
    <article className={`exercise-card synonym-demo ${result !== undefined ? 'is-answered' : ''}`}>
      <span className="exercise-kind">同义替换</span>
      <h3>
        In the sentence, &quot;Have you read that interesting <mark>book</mark> we saw at the local
        cultural center?&quot;, which word best replaces <mark>book</mark> without changing the
        original meaning?
      </h3>
      <p>先观察候选词；将鼠标停在提示区，或用键盘聚焦选项后可查看词义提示。</p>
      <div className="synonym-options" aria-label="同义替换演示选项">
        {SYNONYM_DEMO_OPTIONS.map((option) => (
          <button
            key={option.word}
            className={`${result !== undefined && option.correct ? 'correct' : ''} ${result !== undefined && !option.correct ? 'muted' : ''}`}
            aria-label={`${option.word}，提示：${option.hint}`}
            disabled={result !== undefined}
            onClick={() => onAnswer(option.correct)}
          >
            <strong>{option.word}</strong>
            <span className="synonym-hint-trigger">
              <i aria-hidden="true">✳</i>
              <span className="synonym-hint-label">悬停查看提示</span>
              <em>{option.hint}</em>
            </span>
          </button>
        ))}
      </div>
      {result !== undefined && (
        <>
          <strong className={result ? 'answer-feedback success' : 'answer-feedback'}>
            {result ? '回答正确！“volume” 可指一册书。' : '回答错误，正确答案已标出。'}
          </strong>
          <WordMeaningCard word={word} />
        </>
      )}
    </article>
  );
}

function GroupSettlement({
  words,
  results,
  summary,
  onBack,
  onOpenMistakes,
}: {
  words: Word[];
  results: Record<string, boolean>;
  summary?: LearningPlan['summary'];
  onBack: () => void;
  onOpenMistakes?: () => void;
}) {
  const [scheduleClock, setScheduleClock] = useState<{ now: number; timeZone: string } | null>(
    null,
  );
  useEffect(() => {
    const updateClock = () => setScheduleClock({ now: Date.now(), timeZone: browserTimeZone() });
    updateClock();
    const timer = window.setInterval(updateClock, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const correct = words.filter((word) => results[word.word]).length;
  const accuracy = words.length ? Math.round((correct / words.length) * 100) : 0;
  const reviewCount = words.filter((word) => word.source === 'REVIEW').length;
  const newCount = words.length - reviewCount;
  const incorrect = words.filter((word) => !results[word.word]);
  const activeWeaknesses = words.flatMap((word) =>
    (word.activeWeaknesses ?? []).map((weakness) => ({ word, weakness })),
  );
  const scheduledWords = words
    .filter((word) => word.nextReviewAt && !Number.isNaN(new Date(word.nextReviewAt).getTime()))
    .sort(
      (left, right) =>
        new Date(left.nextReviewAt!).getTime() - new Date(right.nextReviewAt!).getTime(),
    );
  const unknownScheduleCount = words.filter(
    (word) =>
      word.completed && (!word.nextReviewAt || Number.isNaN(new Date(word.nextReviewAt).getTime())),
  ).length;
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
          <span>
            下方是本组首次有效作答结果，以及用户当前的排期和薄弱项状态；后两者不是本组完成时快照。
          </span>
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
              <small>首次提交正确率</small>
              <strong>
                {accuracy}
                <em>%</em>
              </strong>
              <i>
                <b style={{ width: `${accuracy}%` }} />
              </i>
              <p>
                {correct} / {words.length} 道首次提交答对
              </p>
            </article>
            <article>
              <small>学习时长</small>
              <strong>
                {durationMinutes}
                <em>min</em>
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
                    style={{ width: `${total ? Math.max(8, (value / total) * 100) : 8}%` }}
                  />
                </i>
                <strong>
                  {value}/{total} 正确
                </strong>
              </div>
            ))}
          </section>
          <section className="settlement-card settlement-schedule">
            <header>
              <TimerReset size={20} />
              <h2>下次复习时间</h2>
            </header>
            <p className="settlement-schedule-caption">
              这是用户当前保存的排期，后续练习可能更新它。按本地设备时区显示；到期时刻及之后会进入首页“今日待复习”。
            </p>
            {scheduledWords.length ? (
              <ul className="settlement-schedule-list">
                {scheduledWords.map((word) => (
                  <li key={word.id ?? word.word}>
                    <div>
                      <strong>{word.word}</strong>
                      <small>{results[word.word] ? '首次提交答对' : '首次提交答错'}</small>
                    </div>
                    <time dateTime={word.nextReviewAt!}>
                      {scheduleClock
                        ? `${new Date(word.nextReviewAt!).toLocaleString('zh-CN', {
                            timeZone: scheduleClock.timeZone,
                            year: 'numeric',
                            month: 'numeric',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })} (${scheduleClock.timeZone})`
                        : `${new Date(word.nextReviewAt!).toISOString().slice(0, 16).replace('T', ' ')} UTC`}
                    </time>
                    <small className="settlement-schedule-state">
                      {scheduleClock
                        ? new Date(word.nextReviewAt!).getTime() <= scheduleClock.now
                          ? '已到期 · 可进入首页复习'
                          : '尚未到期'
                        : '正在读取设备时区与到期状态'}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="settlement-schedule-empty">
                没有有效排期时间，状态未知；这里不会推测日期或是否到期。
              </p>
            )}
            {unknownScheduleCount > 0 && (
              <p className="settlement-schedule-empty">
                {unknownScheduleCount} 个词没有有效排期时间，状态未知；未将其标为已到期或未来复习。
              </p>
            )}
          </section>
        </div>
        <aside className="settlement-side">
          <section className="settlement-card settlement-words">
            <header>
              <CheckCircle2 size={21} />
              <h2>{activeWeaknesses.length ? '仍待巩固的题型' : '待巩固状态'}</h2>
              <span>{activeWeaknesses.length || incorrect.length}</span>
            </header>
            {activeWeaknesses.length ? (
              activeWeaknesses.map(({ word, weakness }) => {
                const matchesCurrentQuestion = word.question?.type === weakness.questionType;
                const typeLabel = weaknessLabels[weakness.questionType] ?? weakness.questionType;
                return (
                  <article key={`${word.id ?? word.word}:${weakness.questionType}`}>
                    <strong>{word.word}</strong>
                    <p>
                      {typeLabel} · 累计答错 {weakness.wrongCount} 次
                    </p>
                    <small>
                      连续答对 {weakness.consecutiveCorrect}/2，还需答对 {weakness.remainingCorrect}{' '}
                      次
                    </small>
                    {matchesCurrentQuestion &&
                      word.result === false &&
                      word.question?.explanation && (
                        <p className="settlement-weakness-explanation">
                          本次解析：{word.question.explanation}
                        </p>
                      )}
                    {matchesCurrentQuestion && word.result === true && (
                      <p className="settlement-weakness-explanation">
                        首次提交答对了；这项当前薄弱记录仍需达到连续答对两次才会纠正。
                      </p>
                    )}
                    {!matchesCurrentQuestion && (
                      <p className="settlement-weakness-explanation">
                        这是该词的其他题型薄弱项；本组首次提交不会改变它的连续答对记录。
                      </p>
                    )}
                  </article>
                );
              })
            ) : incorrect.length ? (
              <p className="settlement-all-correct">
                本次有 {incorrect.length}{' '}
                个词答错，但薄弱项状态暂未返回；请在错题本核对，不把它们视为已纠正。
              </p>
            ) : (
              <p className="settlement-all-correct">
                当前没有开放的题型薄弱项；这不等于本组答对就自动代表掌握。上方正确率记录本组首次提交，单词仍按当前排期复习。
              </p>
            )}
            {onOpenMistakes && (activeWeaknesses.length > 0 || incorrect.length > 0) && (
              <button className="settlement-mistakes-link" onClick={onOpenMistakes}>
                打开错题本
              </button>
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
const weaknessLabels: Record<string, string> = {
  ...exerciseLabels,
  OUTPUT: '每日输出',
  CONFUSION: '易混词辨析',
};

function GeneratedStudyPage({
  plan,
  session,
  onBack,
  onOpenMistakes,
  onOpenTutorSettings,
  onPlanUpdated,
}: {
  plan: LearningPlan | null;
  session: Session;
  onBack: () => void;
  onOpenMistakes?: () => void;
  onOpenTutorSettings?: () => void;
  onPlanUpdated: (plan: LearningPlan) => void;
}) {
  const [draftState, setDraftState] = useState<{
    scopeKey: string | null;
    answers: StudyDraftAnswers;
    snapshotId: string | null;
  }>({ scopeKey: null, answers: {}, snapshotId: null });
  const [draftRevision, setDraftRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [finishedPlan, setFinishedPlan] = useState<LearningPlan | null>(null);
  const [submittedPlan, setSubmittedPlan] = useState<LearningPlan | null>(null);
  const [feedbackGroupIndex, setFeedbackGroupIndex] = useState<number | null>(null);
  const groupStartedAt = useRef(Date.now());
  const activePlan = plan && submittedPlan?.id === plan.id ? submittedPlan : plan;
  const groups = activePlan?.content?.groups ?? [];
  const firstPendingWord = activePlan?.words.find((word) => !word.completed);
  const currentGroupIndex = firstPendingWord?.groupIndex ?? Math.max(0, groups.length - 1);
  const displayGroupIndex = feedbackGroupIndex ?? currentGroupIndex;
  const group =
    groups.find((item) => item.index === displayGroupIndex) ?? groups[displayGroupIndex];
  const words =
    activePlan && group ? activePlan.words.filter((word) => word.groupIndex === group.index) : [];
  const draftScopeKey =
    activePlan && group
      ? studyDraftIdentity(session.user.id, activePlan.id, group.index, group.questions)
      : null;
  useEffect(() => {
    if (!draftScopeKey || !activePlan || !group) {
      setDraftState({ scopeKey: null, answers: {}, snapshotId: null });
      return;
    }
    const snapshot = readStudyDraftSnapshot(
      session.user.id,
      activePlan.id,
      group.index,
      group.questions,
    );
    setDraftState({ scopeKey: draftScopeKey, ...snapshot });
  }, [draftScopeKey]);
  const draftReady = draftScopeKey !== null && draftState.scopeKey === draftScopeKey;
  const answers = draftReady ? draftState.answers : {};
  const showingFeedback = feedbackGroupIndex !== null;
  const allAnswered =
    draftReady &&
    words.every((word) => {
      const answer = word.id ? answers[word.id] : undefined;
      return Boolean(answer?.confirmed);
    });
  const hasDraftAnswers = Object.keys(answers).length > 0;

  if (!plan?.content?.groups?.length || !activePlan || !group) {
    return (
      <section className="plan-empty">
        <Sparkles size={32} />
        <strong>学习内容还没有生成好</strong>
        <p>{plan?.generationError ?? '返回预习页等待生成完成后再开始挑战。'}</p>
        <button onClick={onBack}>返回学习序列</button>
      </section>
    );
  }

  const recordAnswer = (question: GeneratedQuestion, selected: string[], confirmed: boolean) => {
    if (!draftReady || !draftScopeKey) return;
    const nextAnswers = { ...answers };
    if (selected.length) {
      nextAnswers[question.bookWordId] = { selected, confirmed };
    } else {
      delete nextAnswers[question.bookWordId];
    }
    const snapshotId = saveStudyDraft(
      session.user.id,
      activePlan.id,
      group.index,
      group.questions,
      nextAnswers,
    );
    setDraftState({ scopeKey: draftScopeKey, answers: nextAnswers, snapshotId });
  };
  const completeGroup = async () => {
    if (!allAnswered || submitting || showingFeedback || !draftScopeKey) return;
    const submittedAnswers = answers;
    const submittedSnapshotId = draftState.snapshotId;
    setSubmitting(true);
    try {
      const elapsed = Math.round((Date.now() - groupStartedAt.current) / Math.max(1, words.length));
      const updated = await request<LearningPlan>(
        `/study/plans/${activePlan.id}/groups/${group.index}/complete`,
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
      clearStudyDraftIfMatches(
        session.user.id,
        activePlan.id,
        group.index,
        group.questions,
        submittedAnswers,
        submittedSnapshotId,
      );
      setSubmittedPlan(updated);
      onPlanUpdated(updated);
      if (updated.status === 'COMPLETED') setFinishedPlan(updated);
      setFeedbackGroupIndex(group.index);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '提交本组结果失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };
  if (finishedPlan && !showingFeedback) {
    const results = Object.fromEntries(
      finishedPlan.words.map((word) => [word.word, word.result === true]),
    );
    return (
      <GroupSettlement
        words={finishedPlan.words}
        results={results}
        summary={finishedPlan.summary}
        onBack={onBack}
        onOpenMistakes={onOpenMistakes}
      />
    );
  }
  const continueAfterFeedback = () => {
    setFeedbackGroupIndex(null);
    setDraftState({ scopeKey: draftScopeKey, answers: {}, snapshotId: null });
    setDraftRevision((current) => current + 1);
    groupStartedAt.current = Date.now();
  };
  const discardDraft = () => {
    clearStudyDraft(session.user.id, activePlan.id, group.index);
    setDraftState({ scopeKey: draftScopeKey, answers: {}, snapshotId: null });
    setDraftRevision((current) => current + 1);
  };
  return (
    <section className="lesson-page">
      <header className="lesson-page-head">
        <button onClick={onBack}>
          <ArrowLeft size={19} />
          返回学习序列
        </button>
        <div>
          <span>
            {activePlan.purpose === 'weakness'
              ? '薄弱词专项'
              : `${modeLabel[activePlan.mode]} · 正常模式`}
          </span>
          <strong>
            第 {group.index + 1} / {activePlan.groupCount}{' '}
            {activePlan.mode === 'individual' ? '篇' : '组'}
          </strong>
        </div>
        <b>
          {activePlan.completed}/{activePlan.wordCount} 已完成
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
                  <span key={word.id} style={wordTone(index)}>
                    {word.word}
                    <b>{group.wordOccurrences[word.word] ?? 1}</b>
                  </span>
                ))}
              </div>
              <h2>{group.title}</h2>
              <p className="reading-lede">先在短文中理解本组单词，再完成每个单词对应的一道练习。</p>
              <GeneratedReadingContent
                session={session}
                key={`${session.user.id}:${activePlan.id}:${group.index}`}
                sentences={group.sentences}
                words={words}
              />
              <small>Powered by Lexloop AI</small>
            </article>
          </section>
          <section className="lesson-section exercises">
            <header>
              <Sparkles size={19} />
              <h2>练习题</h2>
            </header>
            {group.questions.map((question, index) => {
              const word = words.find((item) => item.id === question.bookWordId);
              if (!word) return null;
              return (
                <GeneratedQuestionCard
                  key={`${question.bookWordId}:${draftRevision}`}
                  question={question}
                  word={word}
                  toneIndex={index}
                  answer={answers[question.bookWordId]}
                  busy={!draftReady || submitting || showingFeedback}
                  revealed={showingFeedback}
                  onAnswer={(selected, confirmed) => recordAnswer(question, selected, confirmed)}
                />
              );
            })}
            <div className="lesson-draft-actions">
              {hasDraftAnswers && !showingFeedback && (
                <>
                  <span className="lesson-draft-note">
                    恢复草稿依赖此浏览器的本地存储，不跨设备同步。
                  </span>
                  <button
                    type="button"
                    className="lesson-draft-clear"
                    disabled={submitting}
                    onClick={discardDraft}
                  >
                    清空本组作答
                  </button>
                </>
              )}
              <button
                className="check-matches"
                disabled={!showingFeedback && (!allAnswered || submitting)}
                onClick={() => (showingFeedback ? continueAfterFeedback() : void completeGroup())}
              >
                {showingFeedback
                  ? finishedPlan
                    ? '查看今日总结'
                    : `继续下一${activePlan.mode === 'individual' ? '篇' : '组'}`
                  : submitting
                    ? '正在记录学习结果…'
                    : '提交本组并查看答案'}
              </button>
            </div>
          </section>
        </main>
        <aside className="lesson-side">
          <section>
            <h2>本组学习单词</h2>
            {words.map((word, index) => (
              <div key={word.id} className="lesson-word-entry" style={wordTone(index)}>
                <b>{index + 1}</b>
                <div className="lesson-word-entry-copy">
                  <strong>{word.word}</strong>
                  <details className="lesson-word-meaning">
                    <summary>需要提示时查看词义</summary>
                    <small>{word.meaning.split('｜')[0]}</small>
                  </details>
                </div>
              </div>
            ))}
          </section>
          <section className="exercise-progress">
            <h2>练习题</h2>
            {words.map((word) => {
              const answer = word.id ? answers[word.id] : undefined;
              const question = group.questions.find((item) => item.bookWordId === word.id);
              const questionAnswer =
                answer && showingFeedback && question
                  ? gradeGeneratedAnswer(question, answer.selected)
                  : undefined;
              return (
                <div
                  className={
                    questionAnswer === undefined ? '' : questionAnswer ? 'is-correct' : 'is-wrong'
                  }
                  key={word.id}
                >
                  {questionAnswer === undefined ? (
                    <Circle size={25} />
                  ) : questionAnswer ? (
                    <CheckCircle2 size={25} />
                  ) : (
                    <CircleX size={25} />
                  )}
                  <strong>{word.word}</strong>
                  <span>{question ? exerciseLabels[question.type] : '练习题'}</span>
                </div>
              );
            })}
            <p>
              {showingFeedback
                ? '答案与解析已揭晓，可以结合刚才的选择回顾。'
                : allAnswered
                  ? '本组已作答，提交后查看答案与解析。'
                  : '完成所有练习题后即可提交'}
            </p>
          </section>
          <TutorPanel
            session={session}
            context={{ type: 'STUDY_GROUP', planId: activePlan.id, groupIndex: group.index }}
            compact
            onOpenSettings={onOpenTutorSettings}
          />
        </aside>
      </div>
    </section>
  );
}

function GeneratedReadingContent({
  sentences,
  words,
  session,
}: {
  sentences: ReadingSentence[];
  words: Word[];
  session: Session;
}) {
  type Detail = 'translation' | 'grammar' | 'simplified';
  const [sentenceMode, setSentenceMode] = useState(false);
  const [fullDetail, setFullDetail] = useState<'none' | 'translation' | 'simplified'>('none');
  const [sentenceDetails, setSentenceDetails] = useState<Record<number, Detail | undefined>>({});
  const [rewriteSentenceIndex, setRewriteSentenceIndex] = useState<number | null>(null);
  const [wordUseOpen, setWordUseOpen] = useState(false);
  const [speechNotice, setSpeechNotice] = useState('');

  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
    },
    [],
  );

  const speak = (text: string) => {
    if (!text.trim()) {
      setSpeechNotice('暂无可朗读的英文内容。');
      return;
    }
    const result = speakEnglish(text);
    setSpeechNotice(
      result === 'no-voice'
        ? '浏览器没有提供标记为本地服务的英语语音；可直接阅读原文。'
        : result === 'unsupported'
          ? '当前浏览器不支持语音播放，可直接阅读原文。'
          : '',
    );
  };
  const toggleDetail = (index: number, detail: Detail) =>
    setSentenceDetails((current) => ({
      ...current,
      [index]: current[index] === detail ? undefined : detail,
    }));
  const detailText = (sentence: ReadingSentence, detail?: Detail) => {
    if (detail === 'translation') return sentence.chinese;
    if (detail === 'simplified') return sentence.simplified;
    if (detail === 'grammar')
      return (
        sentence.grammar?.trim() ||
        '句子结构提示：先找主语和谓语，再结合上下文判断目标词在句中的作用。'
      );
    return '';
  };
  return (
    <>
      <div className="reading-tools generated-reading-tools">
        <button
          aria-label={sentenceMode ? '收起分句阅读' : '展开分句阅读'}
          aria-pressed={sentenceMode}
          data-tip={sentenceMode ? '收起分句阅读' : '展开分句阅读'}
          onClick={() => {
            window.speechSynthesis?.cancel();
            setSpeechNotice('');
            setRewriteSentenceIndex(null);
            setSentenceMode((value) => !value);
          }}
        >
          ☰
        </button>
        <button
          aria-label="翻译全文"
          aria-pressed={fullDetail === 'translation'}
          data-tip="翻译全文"
          onClick={() =>
            setFullDetail((value) => (value === 'translation' ? 'none' : 'translation'))
          }
        >
          译
        </button>
        <button
          aria-label="简化全文"
          aria-pressed={fullDetail === 'simplified'}
          data-tip="简化全文"
          onClick={() => setFullDetail((value) => (value === 'simplified' ? 'none' : 'simplified'))}
        >
          ✦
        </button>
        <button
          aria-label="朗读全文"
          data-tip="朗读全文"
          onClick={() => speak(sentences.map((sentence) => sentence.english).join(' '))}
        >
          <Volume2 size={18} />
        </button>
      </div>
      <p className="reading-speech-status" role="status" aria-live="polite">
        {speechNotice}
      </p>
      <CollectWordForm
        session={session}
        sourceType="READING"
        source="分组阅读"
        example={sentences[0]?.english ?? ''}
      />
      <div className={sentenceMode ? 'sentence-reading generated-sentences' : 'generated-passage'}>
        {sentences.map((sentence, index) => (
          <article
            className={sentenceMode ? 'sentence-line' : ''}
            key={`${index}:${sentence.english}`}
          >
            <p>
              {sentenceMode && <b>{index + 1}. </b>}
              <HighlightedSentence text={sentence.english} words={words} />
            </p>
            {sentenceMode && (
              <div className="sentence-tools" aria-label={`第 ${index + 1} 句操作`}>
                <button
                  aria-label="复制"
                  data-tip="复制"
                  onClick={() => void navigator.clipboard?.writeText(sentence.english)}
                >
                  <Copy size={16} />
                </button>
                <button
                  aria-label="翻译"
                  aria-pressed={sentenceDetails[index] === 'translation'}
                  data-tip="翻译"
                  onClick={() => toggleDetail(index, 'translation')}
                >
                  译
                </button>
                <button
                  aria-label="语法分析"
                  aria-pressed={sentenceDetails[index] === 'grammar'}
                  data-tip="语法分析"
                  onClick={() => toggleDetail(index, 'grammar')}
                >
                  ⌕
                </button>
                <button
                  aria-label="简化"
                  aria-pressed={sentenceDetails[index] === 'simplified'}
                  data-tip="简化"
                  onClick={() => toggleDetail(index, 'simplified')}
                >
                  ✦
                </button>
                <button aria-label="朗读" data-tip="朗读" onClick={() => speak(sentence.english)}>
                  <Volume2 size={16} />
                </button>
                <button
                  aria-label={`换种说法第 ${index + 1} 句`}
                  aria-expanded={rewriteSentenceIndex === index}
                  aria-controls={`sentence-rewrite-${index}`}
                  data-tip="换种说法"
                  onClick={() => {
                    setWordUseOpen(false);
                    setRewriteSentenceIndex((current) => (current === index ? null : index));
                  }}
                >
                  <PenLine size={16} />
                </button>
              </div>
            )}
            {sentenceMode && sentenceDetails[index] && (
              <small className={`sentence-detail is-${sentenceDetails[index]}`}>
                {detailText(sentence, sentenceDetails[index])}
              </small>
            )}
            <ReadingSentenceRewritePractice
              session={session}
              sourceSentence={sentence.english}
              id={`sentence-rewrite-${index}`}
              open={sentenceMode && rewriteSentenceIndex === index}
            />
          </article>
        ))}
      </div>
      <div className="reading-word-use-entry">
        <button
          type="button"
          className="reading-word-use-toggle"
          aria-expanded={wordUseOpen}
          aria-controls="reading-word-use-practice"
          onClick={() => {
            setRewriteSentenceIndex(null);
            setWordUseOpen((open) => !open);
          }}
        >
          {wordUseOpen ? '收起造句练习' : '试着用本组词造一句'}
        </button>
        <ReadingWordUsePractice
          id="reading-word-use-practice"
          open={wordUseOpen}
          session={session}
          words={words}
        />
      </div>
      {!sentenceMode && fullDetail !== 'none' && (
        <p className={fullDetail === 'translation' ? 'reading-translation' : 'reading-simple'}>
          {sentences
            .map((sentence) =>
              fullDetail === 'translation' ? sentence.chinese : sentence.simplified,
            )
            .join('')}
        </p>
      )}
    </>
  );
}

function ReadingWordUsePractice({
  id,
  open,
  session,
  words,
}: {
  id: string;
  open: boolean;
  session: Session;
  words: Word[];
}) {
  const wordKey = (word: Word) => word.id ?? word.word;
  const [selectedWordKey, setSelectedWordKey] = useState(words[0] ? wordKey(words[0]) : '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{
    wordKey: string;
    answer: string;
    value: ReadingWordUseFeedback;
  } | null>(null);
  const [error, setError] = useState<{
    wordKey: string;
    answer: string;
    message: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectedWord = words.find((word) => wordKey(word) === selectedWordKey);
  const answer = drafts[selectedWordKey] ?? '';
  const visibleFeedback =
    feedback?.wordKey === selectedWordKey && feedback.answer === answer ? feedback.value : null;
  const visibleError =
    error?.wordKey === selectedWordKey && error.answer === answer ? error.message : '';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const learnerSentence = answer.trim();
    if (!selectedWord || !learnerSentence || submitting) return;
    const submittedWordKey = selectedWordKey;
    const submittedAnswer = learnerSentence;
    setSubmitting(true);
    setError(null);
    try {
      const result = await request<ReadingWordUseFeedback>(
        '/ai/reading-word-use-feedback',
        {
          method: 'POST',
          body: JSON.stringify({
            word: selectedWord.word,
            meaning: selectedWord.meaning,
            learnerSentence: submittedAnswer,
          }),
        },
        session.accessToken,
      );
      if (mountedRef.current) {
        setFeedback({ wordKey: submittedWordKey, answer: submittedAnswer, value: result });
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError({
          wordKey: submittedWordKey,
          answer: submittedAnswer,
          message: userFacingError(cause, '造句建议暂时不可用。'),
        });
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  return (
    <section id={id} className="sentence-word-use-panel" aria-label="使用本组词造句" hidden={!open}>
      <h3>换到自己的语境里用一次</h3>
      <p className="sentence-rewrite-note">
        先选一个本组词，写一句你自己的英文。只有点击提交后，目标词、词义和句子才会发送给当前选择的模型；不会保存、计分或调整复习计划。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor={`${id}-word`}>本组目标词</label>
        <select
          id={`${id}-word`}
          value={selectedWordKey}
          disabled={submitting}
          onChange={(event) => setSelectedWordKey(event.target.value)}
        >
          {words.map((word) => (
            <option key={wordKey(word)} value={wordKey(word)}>
              {word.word}
            </option>
          ))}
        </select>
        {!selectedWord && (
          <p className="sentence-rewrite-error" role="status">
            当前学习组没有可用的目标词，暂时无法造句。
          </p>
        )}
        {selectedWord && (
          <details className="word-use-meaning-hint">
            <summary id={`${id}-meaning-hint`}>需要时查看词义提示</summary>
            <small>{selectedWord.meaning}</small>
          </details>
        )}
        <label htmlFor={`${id}-answer`}>你的英文句子</label>
        <textarea
          id={`${id}-answer`}
          aria-label="使用目标词造句"
          maxLength={1200}
          value={answer}
          disabled={submitting}
          onChange={(event) =>
            setDrafts((current) => ({ ...current, [selectedWordKey]: event.target.value }))
          }
          placeholder="写一句与你自己的生活或想法有关的英文。"
        />
        <div className="sentence-rewrite-actions">
          <button type="submit" disabled={!selectedWord || !answer.trim() || submitting}>
            {submitting ? '正在整理建议…' : '提交并查看建议'}
          </button>
          <span>{answer.length}/1200</span>
        </div>
      </form>
      {visibleError && (
        <p className="sentence-rewrite-error" role="alert">
          {visibleError} {visibleFeedback ? '上次成功的反馈仍保留。' : ''}草稿保留，可检查后重试。
        </p>
      )}
      {submitting && (
        <p className="word-use-loading" role="status" aria-live="polite">
          {visibleFeedback ? '正在更新建议…' : '正在整理建议…'}
        </p>
      )}
      {visibleFeedback && (
        <section className="sentence-rewrite-feedback" aria-label="造句参考反馈" aria-live="polite">
          <h4>造句参考反馈</h4>
          <dl>
            <div>
              <dt>词语使用</dt>
              <dd>{visibleFeedback.wordUse}</dd>
            </div>
            <div>
              <dt>意思</dt>
              <dd>{visibleFeedback.meaning}</dd>
            </div>
            <div>
              <dt>语法</dt>
              <dd>{visibleFeedback.grammar}</dd>
            </div>
            <div>
              <dt>自然度</dt>
              <dd>{visibleFeedback.naturalness}</dd>
            </div>
            {visibleFeedback.alternative && (
              <div>
                <dt>参考表达</dt>
                <dd lang="en">{visibleFeedback.alternative}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </section>
  );
}

function ReadingSentenceRewritePractice({
  id,
  open,
  session,
  sourceSentence,
}: {
  id: string;
  open: boolean;
  session: Session;
  sourceSentence: string;
}) {
  const [rewrite, setRewrite] = useState('');
  const [feedback, setFeedback] = useState<ReadingSentenceRewriteFeedback | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = rewrite.trim();
    if (!answer || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await request<ReadingSentenceRewriteFeedback>(
        '/ai/reading-rewrite-feedback',
        {
          method: 'POST',
          body: JSON.stringify({ sourceSentence, learnerRewrite: answer }),
        },
        session.accessToken,
      );
      setFeedback(result);
    } catch (cause) {
      setError(userFacingError(cause, '改写反馈暂时不可用。'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section id={id} className="sentence-rewrite-panel" aria-label="单句改写练习" hidden={!open}>
      <h3>保留原意，换一种英文表达</h3>
      <p className="sentence-rewrite-note">
        只在提交后把原句和你的改写发送给当前选择的模型；不会保存作答、计分或调整复习计划。反馈是参考建议。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor={`${id}-answer`}>你的改写</label>
        <textarea
          id={`${id}-answer`}
          aria-label="你的英文改写"
          maxLength={1200}
          value={rewrite}
          disabled={submitting}
          onChange={(event) => {
            setRewrite(event.target.value);
            setFeedback(null);
            setError('');
          }}
          placeholder="先写下你的表达，再提交查看意思、语法和自然度建议。"
        />
        <div className="sentence-rewrite-actions">
          <button type="submit" disabled={!rewrite.trim() || submitting}>
            {submitting ? (feedback ? '正在更新建议…' : '正在整理建议…') : '提交并查看建议'}
          </button>
          <span>{rewrite.length}/1200</span>
        </div>
      </form>
      {error && (
        <p className="sentence-rewrite-error" role="alert">
          {error} {feedback ? '上次成功的反馈仍保留。' : ''}再次提交会重新请求所选模型。
        </p>
      )}
      {feedback && (
        <section className="sentence-rewrite-feedback" aria-label="改写参考反馈" aria-live="polite">
          <h4>改写参考反馈</h4>
          <dl>
            <div>
              <dt>意思</dt>
              <dd>{feedback.meaning}</dd>
            </div>
            <div>
              <dt>语法</dt>
              <dd>{feedback.grammar}</dd>
            </div>
            <div>
              <dt>自然度</dt>
              <dd>{feedback.naturalness}</dd>
            </div>
            {feedback.alternative && (
              <div>
                <dt>另一种表达</dt>
                <dd lang="en">{feedback.alternative}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </section>
  );
}

function HighlightedSentence({ text, words }: { text: string; words: Word[] }) {
  const matches = findTargetWordMatches(
    text,
    words.map((word) => word.word),
  );
  if (!matches.length) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let offset = 0;
  matches.forEach((match, index) => {
    if (match.start > offset) {
      parts.push(<span key={`text-${offset}`}>{text.slice(offset, match.start)}</span>);
    }
    parts.push(
      <mark key={`target-${match.start}-${index}`} style={wordTone(match.wordIndex)}>
        {text.slice(match.start, match.end)}
      </mark>,
    );
    offset = match.end;
  });
  if (offset < text.length) parts.push(<span key={`text-${offset}`}>{text.slice(offset)}</span>);
  return <>{parts}</>;
}

function gradeGeneratedAnswer(question: GeneratedQuestion, selected: string[]) {
  const expected = (
    question.type === 'WORD_MATCHING' && question.pairs?.length
      ? question.pairs.map((pair) => `${pair.left}=>${pair.right}`)
      : (question.correctAnswers ?? [])
  )
    .slice()
    .sort();
  const actual = [...selected].sort();
  return (
    expected.length === actual.length && expected.every((value, index) => value === actual[index])
  );
}

function GeneratedQuestionCard({
  question,
  word,
  toneIndex,
  answer,
  busy,
  revealed,
  onAnswer,
}: {
  question: GeneratedQuestion;
  word: Word;
  toneIndex: number;
  answer?: { selected: string[]; confirmed: boolean };
  busy: boolean;
  revealed: boolean;
  onAnswer: (selected: string[], confirmed: boolean) => void;
}) {
  const selected = answer?.selected ?? [];
  const isMultiple = question.type === 'WORD_MNEMONIC';
  const correct = Boolean(
    answer?.confirmed && revealed && gradeGeneratedAnswer(question, answer.selected),
  );
  const submit = (option?: string, confirmed = true) => {
    const next = option ? [option] : selected;
    onAnswer(next, confirmed);
  };
  const explanation = /[\u3400-\u9fff]/.test(question.explanation)
    ? question.explanation
    : question.type === 'WORD_MATCHING' && question.pairs?.length
      ? `正确配对为：${question.pairs.map((pair) => `${pair.left} 对应 ${pair.right}`).join('；')}。`
      : `正确答案为：${question.correctAnswers?.join('、') ?? '交卷后揭晓'}。请结合文章语境和单词释义理解本题。`;
  return (
    <article className="exercise-card generated-question">
      <span className="exercise-kind">{exerciseLabels[question.type]}</span>
      <h3>
        <mark style={wordTone(toneIndex)}>{word.word}</mark>　{question.prompt}
      </h3>
      {question.type === 'WORD_MATCHING' && question.pairs?.length ? (
        <GeneratedMatchingQuestion
          pairs={question.pairs}
          answer={answer}
          busy={busy}
          revealed={revealed}
          onAnswer={onAnswer}
        />
      ) : (
        <div className="answer-options">
          {question.options.map((option, index) => {
            const checked = selected.includes(option);
            const isCorrectOption = question.correctAnswers?.includes(option) ?? false;
            const resultClass = !revealed
              ? ''
              : checked && !isCorrectOption
                ? 'wrong'
                : isCorrectOption && (checked || !isMultiple)
                  ? 'correct'
                  : isCorrectOption
                    ? 'missed'
                    : '';
            return (
              <button
                key={option}
                disabled={busy || Boolean(answer?.confirmed)}
                className={`${checked ? 'selected' : ''} ${resultClass}`}
                onClick={() => {
                  if (isMultiple) {
                    onAnswer(
                      checked ? selected.filter((item) => item !== option) : [...selected, option],
                      false,
                    );
                  } else {
                    submit(option, true);
                  }
                }}
              >
                {option}
                {revealed && answer && isCorrectOption && (!isMultiple || checked) ? ' ✓' : ''}
                {revealed && answer && checked && !isCorrectOption ? ' ×' : ''}
                {revealed && answer && isMultiple && !checked && isCorrectOption ? '（漏选）' : ''}
              </button>
            );
          })}
        </div>
      )}
      {isMultiple && !answer?.confirmed && (
        <button
          className="check-matches"
          disabled={busy || !selected.length}
          onClick={() => submit(undefined, true)}
        >
          确认多选答案
        </button>
      )}
      {answer && !revealed && (
        <p role="status" className="question-answer">
          {answer.confirmed
            ? '答案已记录，提交本组后查看对错与解析。'
            : '选择已暂存，确认后计入本组。'}
        </p>
      )}
      {answer?.confirmed && revealed && (
        <>
          <strong className={correct ? 'answer-feedback success' : 'answer-feedback'}>
            {correct ? '回答正确！' : '回答错误，正确答案已标出。'}
          </strong>
          <p className="question-answer">
            正确答案：
            {question.type === 'WORD_MATCHING' && question.pairs?.length
              ? question.pairs.map((pair) => `${pair.right} → ${pair.left}`).join('；')
              : question.correctAnswers.join('、')}
          </p>
          <p className="question-explanation">{explanation}</p>
          <WordMeaningCard word={word} />
          {word.savedContext && <SavedReviewContext context={word.savedContext} />}
        </>
      )}
    </article>
  );
}

function GeneratedMatchingQuestion({
  pairs,
  answer,
  busy,
  revealed,
  onAnswer,
}: {
  pairs: NonNullable<GeneratedQuestion['pairs']>;
  answer?: { selected: string[]; confirmed: boolean };
  busy: boolean;
  revealed: boolean;
  onAnswer: (selected: string[], confirmed: boolean) => void;
}) {
  const [selectedPhrase, setSelectedPhrase] = useState<string | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<number | null>(null);
  const matchingRootRef = useRef<HTMLDivElement>(null);
  const phraseOptions = pairs.map((_, index) => pairs[(index + 1) % pairs.length]);
  const matches = Object.fromEntries(
    (answer?.selected ?? []).flatMap((value) => {
      const separator = value.lastIndexOf('=>');
      if (separator < 0) return [];
      const phrase = value.slice(0, separator);
      const definition = value.slice(separator + 2);
      const index = pairs.findIndex((pair) => pair.right === definition);
      return index < 0 ? [] : [[String(index), phrase]];
    }),
  ) as Record<number, string>;
  const assignMatch = (index: number, phrase: string) => {
    const nextMatches = {
      ...Object.fromEntries(
        Object.entries(matches).filter(([key, value]) => value !== phrase || Number(key) === index),
      ),
      [index]: phrase,
    };
    const selected = Object.entries(nextMatches).map(
      ([key, value]) => `${value}=>${pairs[Number(key)].right}`,
    );
    onAnswer(selected, false);
  };
  const choosePhrase = (phrase: string) => {
    if (busy || answer?.confirmed) return;
    if (selectedDefinition !== null) {
      assignMatch(selectedDefinition, phrase);
      setSelectedDefinition(null);
      return;
    }
    setSelectedPhrase(phrase);
  };
  const chooseDefinition = (index: number) => {
    if (busy || answer?.confirmed) return;
    if (selectedPhrase) {
      assignMatch(index, selectedPhrase);
      setSelectedPhrase(null);
      return;
    }
    setSelectedDefinition(index);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        busy ||
        answer?.confirmed ||
        !selectedPhrase ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (!matchingRootRef.current?.contains(document.activeElement)) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
      )
        return;
      const index = Number(event.key) - 1;
      if (index < 0 || index >= pairs.length) return;
      event.preventDefault();
      assignMatch(index, selectedPhrase);
      setSelectedPhrase(null);
      setSelectedDefinition(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answer, busy, pairs.length, selectedPhrase]);
  const displayedMatches =
    revealed && answer?.confirmed
      ? Object.fromEntries(
          pairs.map((pair, index) => {
            const match = answer.selected
              .map((value) => {
                const separator = value.lastIndexOf('=>');
                return separator < 0
                  ? null
                  : { left: value.slice(0, separator), right: value.slice(separator + 2) };
              })
              .find((value) => value?.right === pair.right);
            return [index, match?.left ?? ''];
          }),
        )
      : matches;
  const selectedAnswers = answer?.selected ?? [];
  return (
    <div ref={matchingRootRef} className="generated-matching matching-exercise">
      <p className="matching-instruction">英文短语 · 点击选中后可按键盘数字插入对应释义槽</p>
      <div className="match-phrases">
        {phraseOptions.map((pair) => {
          const isMatched = Object.values(displayedMatches).includes(pair.left);
          return (
            <button
              key={pair.left}
              disabled={busy || Boolean(answer?.confirmed) || isMatched}
              className={`${selectedPhrase === pair.left ? 'selected' : ''} ${isMatched ? 'linked matched' : ''}`}
              onClick={() => choosePhrase(pair.left)}
            >
              {pair.left}
            </button>
          );
        })}
      </div>
      <p className="matching-instruction">释义 - 可先点释义，也可先点单词</p>
      <div className="match-definitions">
        {pairs.map((pair, index) => {
          const phrase = displayedMatches[index];
          const correct = phrase === pair.left;
          return (
            <button
              key={`${pair.right}-${index}`}
              disabled={busy || Boolean(answer?.confirmed)}
              className={`${selectedDefinition === index ? 'selected' : ''} ${phrase ? 'linked' : ''} ${revealed && answer?.confirmed ? (correct ? 'correct' : 'wrong') : ''}`}
              onClick={() => chooseDefinition(index)}
            >
              <span className="match-definition-copy">
                <strong>{pair.right}</strong>
                <small>{pair.tip?.trim() || '侧重于理解该描述强调的语义维度。'}</small>
              </span>
              {revealed && answer?.confirmed && phrase && !correct ? (
                <span className="match-answer-review">
                  <b className="match-answer-review-wrong">你的答案：{phrase}</b>
                  <b className="match-answer-review-correct">正确答案：{pair.left}</b>
                </span>
              ) : phrase ? (
                <b>{phrase}</b>
              ) : (
                <em>{selectedPhrase ? '插入此处' : '选择此处'}</em>
              )}
            </button>
          );
        })}
      </div>
      {!answer?.confirmed && (
        <button
          className="check-matches"
          disabled={busy || Object.keys(matches).length !== pairs.length}
          onClick={() => onAnswer(selectedAnswers, true)}
        >
          确认匹配答案
        </button>
      )}
      {answer && !revealed && (
        <p role="status" className="question-answer">
          {answer.confirmed
            ? '答案已记录，提交本组后查看对错与解析。'
            : '匹配已暂存，完成后确认本题。'}
        </p>
      )}
    </div>
  );
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
            if (label === '朗读') speakEnglish(sentence);
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
    addTool('朗读全文', '◖', () => speakEnglish(sentences.join(' ')));
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
                          <span
                            className="match-answer-review"
                            aria-label={`你的答案：${phrase}；正确答案：${phrases[index]}`}
                          >
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
              if (exerciseType(index + 1) === '同义替换')
                return (
                  <SynonymDemo
                    key={word.word}
                    word={word}
                    result={results[word.word]}
                    onAnswer={(correct) =>
                      setResults((current) => ({ ...current, [word.word]: correct }))
                    }
                  />
                );
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

function StudyPlanLoadNotice({
  status,
  onRetry,
}: {
  status: Exclude<StudyPlanListStatus, 'ready'>;
  onRetry: () => void;
}) {
  const failed = status === 'error';
  return (
    <section
      className={`study-plan-load-notice ${failed ? 'is-error' : ''}`}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
    >
      <div>
        <strong>{failed ? '暂时无法读取学习计划' : '正在读取已保存的学习计划'}</strong>
        <p>
          {failed
            ? '学习记录仍保存在账户中。读取成功前不会把它显示为空记录，也不会开放创建普通计划。'
            : '确认当前计划后，就可以继续学习或开始新的计划。'}
        </p>
      </div>
      {failed && <button onClick={onRetry}>重试读取</button>}
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
  const todayPlans = plans.filter((plan) => isToday(plan.createdAt));
  if (!todayPlans.length)
    return (
      <section className="plan-empty">
        <CalendarDays size={32} />
        <strong>今天还没有学习记录</strong>
        <p>创建学习计划后，学习进度会保留在这里。</p>
      </section>
    );
  return (
    <section className="history-grid">
      {todayPlans.map((plan) => {
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

function isToday(value: string) {
  const date = new Date(value);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}
