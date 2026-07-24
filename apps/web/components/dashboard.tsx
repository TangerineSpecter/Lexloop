'use client';

import {
  ArrowLeft, BarChart3, BookOpen, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleX,
  Check, CircleHelp, Copy, Eye, EyeOff, FileText, Flame, Grid2X2, LayoutList, ListRestart,
  LogOut, Menu, Pause, Play, Plus, Send, Settings2, Sparkles, TimerReset, Trophy, UserRound, Volume2, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import { StatisticsPage } from './statistics-page';

type Word = { word: string; part: string; meaning: string; state?: 'review' };
type StudyMode = 'group' | 'individual' | 'exam';
type LearningPlan = { id: number; mode: StudyMode; wordCount: number; words: Word[]; completed: number; started: boolean; createdAt: string };
const GROUP_WORD_LIMIT = 3;
const WORD_TONES = [
  { background: '#d8ebff', color: '#0b3a85' },
  { background: '#ffd9d2', color: '#9b1c1c' },
  { background: '#e8dcff', color: '#481388' },
  { background: '#d8f3dd', color: '#17613a' },
  { background: '#ffe9b6', color: '#875000' },
] as const;

function splitPlanWords(words: Word[]) { return Array.from({ length: Math.ceil(words.length / GROUP_WORD_LIMIT) }, (_, index) => words.slice(index * GROUP_WORD_LIMIT, (index + 1) * GROUP_WORD_LIMIT)); }
function wordTone(index: number) { const tone = WORD_TONES[index % WORD_TONES.length]; return { '--word-bg': tone.background, '--word-color': tone.color } as React.CSSProperties; }
function exerciseType(index: number) { return index === 0 ? '单词匹配' : index === 1 ? '同义替换' : '词义辨析'; }
function articleOccurrenceCount(index: number, total: number) { return index === total - 1 ? 3 : 2; }

const reviewWords: Word[] = [
  { word: 'business', part: 'n.', meaning: '商业；买卖；生意｜职业；行业｜企业；公司｜事情；事务', state: 'review' },
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
  { word: 'health', part: 'n.', meaning: '健康；康健｜（人的）健康状况｜（组织、系统等的）运行状况' },
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
  const [newWordCount, setNewWordCount] = useState(10);
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [previewPlan, setPreviewPlan] = useState<LearningPlan | null>(null);
  const [lessonPlanId, setLessonPlanId] = useState<number | null>(null);
  const [plansReady, setPlansReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bookPickerOpen, setBookPickerOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [page, setPage] = useState<'study' | 'statistics' | 'settings'>('study');
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const name = session.user.displayName || session.user.email.split('@')[0];
  const plansStorageKey = `lexloop.learning-plans.${session.user.id}`;

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
    const savedPlans = window.localStorage.getItem(plansStorageKey);
    if (savedPlans) {
      try { setPlans(JSON.parse(savedPlans) as LearningPlan[]); } catch { window.localStorage.removeItem(plansStorageKey); }
    }
    setPlansReady(true);
  }, [plansStorageKey]);

  useEffect(() => {
    if (plansReady) window.localStorage.setItem(plansStorageKey, JSON.stringify(plans));
  }, [plans, plansReady, plansStorageKey]);

  return <main className="study-app">
    <aside className={`study-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <div className="sidebar-account-wrap" ref={accountMenuRef}><button className="sidebar-book" onClick={() => setAccountMenuOpen((open) => !open)} aria-expanded={accountMenuOpen}><Avatar/><div><strong>{name}</strong><span>大学 CET-4 四级词汇</span></div><ChevronDown size={15}/></button>{accountMenuOpen && <AccountMenu name={name} onSettings={() => { setPage('settings'); setAccountMenuOpen(false); setSidebarOpen(false); }} onLogout={onLogout}/>}</div>
      <Calendar />
      <nav className="sidebar-nav" aria-label="主导航">
        <span className="nav-label">APP</span>
        <button className={`nav-item nav-button ${page === 'study' ? 'active' : ''}`} onClick={() => { setPage('study'); setSidebarOpen(false); }}><BookOpen size={16}/><span>词环</span></button>
        <div className="nav-group"><a className="nav-item" href="#words"><BookOpen size={16}/><span>我的单词</span><ChevronDown size={14}/></a><div className="nav-children"><a href="#learning">学习中</a><a href="#mastered">已掌握</a></div></div>
        <button className={`nav-item nav-button ${page === 'statistics' ? 'active' : ''}`} onClick={() => { setPage('statistics'); setSidebarOpen(false); }}><BarChart3 size={16}/><span>学习统计</span></button>
        <button className={`nav-item nav-button ${page === 'settings' ? 'active' : ''}`} onClick={() => { setPage('settings'); setSidebarOpen(false); }}><Settings2 size={16}/><span>账户设置</span></button>
      </nav>
      <div className="sidebar-bottom"><button className="switch-book" onClick={() => setBookPickerOpen(true)}><Plus size={15}/>切换词汇表</button></div>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}/>}

    <section className="study-shell">
      <header className="study-topbar"><button className="menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={19}/></button><span className="topbar-brand"><BookOpen size={15}/> Lexloop · 词环</span><div className="topbar-actions"><button className="topbar-account" onClick={() => setAccountMenuOpen((open) => !open)} aria-label="账户菜单"><Avatar/><span>{name}</span><ChevronDown size={15}/></button></div></header>
      {page === 'study' && lessonPlanId !== null ? <GroupStudyPage plan={plans.find(plan => plan.id === lessonPlanId) ?? null} onBack={() => setLessonPlanId(null)} onCompleteWords={(id, amount) => setPlans(current => current.map(plan => plan.id === id ? { ...plan, completed: Math.min(plan.completed + amount, plan.wordCount) } : plan))} /> : page === 'study' ? <div className="study-content">
        <h1>学习进度</h1>
        <section className="progress-grid">
          <StreakCard />
          <Metric title="词表总词数" value="4545" detail="大学 CET-4 四级词汇" backIcon={<BookOpen size={42} />} backText="海量词库等你探索" backColor="var(--sky)" />
          <Metric title="已学习词数" value="2" detail="学习进度 0.0%" backIcon={<Flame size={42} />} backText="千里之行始于足下" backColor="var(--coral)" />
        </section>

        <div className="learning-tabs" role="tablist" aria-label="学习内容"><button role="tab" aria-selected={activeTab === 'words'} className={activeTab === 'words' ? 'active' : ''} onClick={() => setActiveTab('words')}>单词列表</button><button role="tab" aria-selected={activeTab === 'plan'} className={activeTab === 'plan' ? 'active' : ''} onClick={() => setActiveTab('plan')}>当前学习序列</button><button role="tab" aria-selected={activeTab === 'history'} className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>今日学习历史</button></div>
        {activeTab === 'words' && <WordsPanel newWordCount={newWordCount} onNewWordCountChange={setNewWordCount} onCreatePlan={(mode) => {
          const wordCount = newWordCount;
          setPreviewPlan({ id: Date.now(), mode, wordCount, words: Array.from({ length: wordCount }, (_, index) => newWords[index % newWords.length]), completed: 0, started: false, createdAt: '刚刚' });
        }} />}
        {activeTab === 'plan' && <PlanPanel plan={plans.find(plan => plan.started) ?? plans[0] ?? null} onContinue={(id) => { const plan = plans.find(item => item.id === id); if (plan?.mode === 'group') setLessonPlanId(id); else setPlans(current => current.map(item => item.id === id ? { ...item, completed: Math.min(item.completed + 1, item.wordCount) } : item)); }} />}
        {activeTab === 'history' && <LearningHistory plans={plans} onContinue={(id) => { const plan = plans.find(item => item.id === id); setPlans(current => current.map(item => item.id === id ? { ...item, started: true } : item)); if (plan?.mode === 'group') setLessonPlanId(id); else setActiveTab('plan'); }} />}
      </div> : page === 'statistics' ? <StatisticsPage onBack={() => setPage('study')} /> : <AccountSettings session={session} onBack={() => setPage('study')} />}
    </section>
    {bookPickerOpen && <BookPicker onClose={() => setBookPickerOpen(false)} />}
    {previewPlan && (
      <PlanPreview
        plan={previewPlan}
        onClose={() => setPreviewPlan(null)}
        onStart={() => { setPlans(current => [{ ...previewPlan, started: true }, ...current.map(plan => ({ ...plan, started: false }))]); setPreviewPlan(null); setActiveTab('plan'); }}
      />
    )}
  </main>;
}

function Avatar() { return <span className="profile-avatar" aria-hidden="true"><i/><b/></span>; }

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

  return <div className="streak-card-wrap">
    <article className="streak-card">
      <div className="streak-front">
        <div className="streak-content">
          <div className="card-heading"><strong>学习连胜</strong><Trophy size={18}/><CheckCircle2 size={18}/></div>
          <p>每天坚持学习，就能持续积累「连胜」<br/>你的「词汇量」和「外语水平」将迎来显著突破！</p>
        </div>
        <div className="streak-count"><b>0</b><Flame size={26}/><small>Today</small></div>
      </div>
      <div className="streak-back">
        <button className={`check-in-btn ${celebrating ? 'is-celebrating' : ''}`} onClick={celebrate} aria-label={checkedIn ? '已打卡，再次播放庆祝动画' : '立刻打卡'}>
          <CheckCircle2 size={32}/><span>{checkedIn ? '打卡成功' : '立刻打卡'}</span>
          <span className="sr-only" aria-live="polite">{checkedIn ? '打卡成功，星星正在绽放' : ''}</span>
        </button>
      </div>
    </article>
    {celebrating && <span className="check-in-burst" aria-hidden="true" key={burst}>
      {checkInBursts.map((star, index) => <i key={index} style={{ '--burst-x': star.x, '--burst-y': star.y, '--burst-turn': star.turn, '--burst-delay': star.delay } as React.CSSProperties}>✦</i>)}
    </span>}
  </div>;
}

function AccountMenu({ name, onSettings, onLogout }: { name: string; onSettings: () => void; onLogout: () => void }) {
  return <div className="account-menu"><div className="account-menu-user"><Avatar/><strong>{name}</strong></div><button onClick={onSettings}><Settings2 size={22}/>账户设置</button><button onClick={onLogout}><LogOut size={22}/>退出登录</button></div>;
}

function BookPicker({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'learning' | 'mine' | 'system'>('learning');
  const cards = [{ title: '大学 CET-4 四级词汇', total: '4545', learned: '2', current: true, note: '含有大量常见词汇' }, { title: '大学 CET-6 六级词汇', total: '2345', learned: '0' }];
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return <div className="book-drawer" role="dialog" aria-modal="true" aria-label="选择词表"><header><div><h2>选择词表</h2><p>请选择一个词表开始您的学习之旅。</p></div><button onClick={onClose} aria-label="关闭"><X size={23}/></button></header><div className="book-tabs"><button className={tab === 'learning' ? 'active' : ''} onClick={() => setTab('learning')}>学习中（2）</button><button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>我的词表</button><button className={tab === 'system' ? 'active' : ''} onClick={() => setTab('system')}>系统词表（18）</button></div>{tab === 'learning' && <div className="book-card-grid">{cards.map(card => <article className="book-choice" key={card.title}><div><strong>{card.title}</strong><p>总词数: {card.total} | 已学: {card.learned}</p>{card.note && <small>{card.note}</small>}</div><button className={card.current ? 'current' : ''}>{card.current ? '当前' : '继续学习'}</button></article>)}</div>}{tab === 'mine' && <div className="book-empty"><strong>我的词表</strong><p>还没有创建任何词表</p><button><Plus size={18}/>创建新词表</button></div>}{tab === 'system' && <div className="book-system"><h3>升学与校内</h3><p>面向国内学习阶段、校内考试与升学目标的词表。</p><div className="book-card-grid">{cards.map(card => <article className="book-choice" key={`system-${card.title}`}><div><strong>{card.title}</strong><p>总词数: {card.total} | 已学: {card.learned}</p></div><button>开始学习</button></article>)}</div></div>}</div>;
}

function AccountSettings({ session, onBack }: { session: Session; onBack: () => void }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [show, setShow] = useState(false); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (password.length < 8) return setMessage('新密码至少需要 8 位。'); if (password !== confirm) return setMessage('两次输入的密码不一致。'); setBusy(true); setMessage(''); try { await request('/auth/password', { method: 'POST', body: JSON.stringify({ password }) }, session.accessToken); setPassword(''); setConfirm(''); setMessage('密码已更新。'); } catch (error) { setMessage(error instanceof Error ? error.message : '更新失败，请稍后重试。'); } finally { setBusy(false); } };
  return <div className="settings-page"><header className="settings-heading"><div><button className="settings-back" onClick={onBack}>← 返回学习</button><h1>设置</h1><p>管理您的账号和系统设置</p></div><div className="identity-card"><span>身份 ID（可用于客服联系问题）</span><div className="identity-card-value"><strong>{session.user.id}</strong><button onClick={() => navigator.clipboard?.writeText(session.user.id)} aria-label="复制身份 ID"><Copy size={20}/></button></div></div></header><div className="settings-layout"><nav><button className="active"><UserRound size={19}/>账号设置</button></nav><section><h2>账号设置</h2><form className="password-card" onSubmit={save}><h3>密码管理</h3><p>更新您的账户密码</p><label>新密码<div className="password-input"><input type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"/><button type="button" onClick={() => setShow(!show)} aria-label="显示密码">{show ? <EyeOff size={20}/> : <Eye size={20}/>}</button></div></label><label>确认密码<input type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password"/></label>{message && <p className={message === '密码已更新。' ? 'form-success' : 'form-error'}>{message}</p>}<button className="save-password" disabled={busy}>{busy ? '更新中…' : '更新密码'}</button></form></section></div></div>;
}

function Calendar() {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return <section className="mini-calendar"><div className="calendar-title"><ChevronLeft size={15}/><span>July 2026</span><ChevronRight size={15}/></div><div className="calendar-grid weekdays">{['Su','Mo','Tu','We','Th','Fr','Sa'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: 3 }, (_, i) => <span key={`e${i}`} />)}{days.map(day => <button key={day} className={day === 22 ? 'today' : ''}>{day}</button>)}<span className="muted-day">1</span></div></section>;
}

function Metric({ title, value, detail, backIcon, backText, backColor }: { title: string; value: string; detail: string; backIcon?: React.ReactNode; backText?: string; backColor?: string }) {
  return <article className="metric-card" style={{ '--back-color': backColor } as React.CSSProperties}>
    <div className="metric-front">
      <span>{title}</span><b>{value}</b><small>{detail}</small>
    </div>
    <div className="metric-back">
      {backIcon}
      <strong>{backText}</strong>
    </div>
  </article>;
}

function WordsPanel({ newWordCount, onNewWordCountChange, onCreatePlan }: { newWordCount: number; onNewWordCountChange: (value: number) => void; onCreatePlan: (mode: StudyMode) => void }) {
  const [mode, setMode] = useState<StudyMode>('group');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawer, setDrawer] = useState<'reading' | 'exam' | null>(null);
  const reviewCount = 2;
  const totalWordCount = reviewCount + newWordCount;
  const reviewShare = `${(reviewCount / totalWordCount) * 100}%`;
  return <section className="words-panel">
    <header className="panel-top"><div className="panel-title"><BookOpen size={18}/><strong>今日学习词汇</strong></div><div className="panel-progress" aria-label={`今日学习构成：待复习 ${reviewCount} 词，新单词 ${newWordCount} 词`}><div className="panel-progress-labels"><span className="is-review">待复习 <b>{reviewCount}</b></span><span className="is-new">新单词 <b>{newWordCount}</b></span><strong>{totalWordCount}<small>词</small></strong></div><div className="panel-progress-bar" aria-hidden="true"><b className="review" style={{ width: reviewShare }}/><b className="new"/></div></div><div className="toolbar"><button className={mode === 'group' ? 'selected' : ''} onClick={() => setMode('group')}><Grid2X2 size={15}/>分组</button><button className={mode === 'individual' ? 'selected' : ''} onClick={() => setMode('individual')}><LayoutList size={15}/>独立单词</button><button className={`real ${mode === 'exam' ? 'selected' : ''}`} onClick={() => setMode('exam')}><span>◎</span> 真题 <em>NEW</em></button><button className="create" onClick={() => onCreatePlan(mode)}><Sparkles size={15}/>创建学习计划</button><button className="mode-settings-trigger" aria-label={mode === 'exam' ? '真题题库设置' : '阅读材料模型设置'} onClick={() => setDrawer(mode === 'exam' ? 'exam' : 'reading')}>{mode === 'exam' ? <ExamBookIcon/> : <FilterSettingsIcon/>}</button></div></header>
    <div className="word-columns"><WordColumn title="待复习单词" count={String(reviewWords.length)} icon={<ReviewWordsIcon/>} words={reviewWords}/><WordColumn title="新单词" count={String(newWordCount)} icon={<NewWordsIcon/>} words={newWords} isNew onOpenSettings={() => setSettingsOpen(true)}/></div>
    {settingsOpen && (
      <NewWordSettings
        value={newWordCount}
        onCancel={() => setSettingsOpen(false)}
        onSave={(value) => { onNewWordCountChange(value); setSettingsOpen(false); }}
      />
    )}
    {drawer === 'reading' && <ReadingModelDrawer onClose={() => setDrawer(null)}/>}
    {drawer === 'exam' && <ExamLibraryDrawer onClose={() => setDrawer(null)}/>}
  </section>;
}

function StudySettingsDrawer({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return <div className="study-drawer-layer"><button className="study-drawer-scrim" aria-label="关闭设置" onClick={onClose}/><aside className="study-settings-drawer" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="关闭"><X size={22}/></button></header>{children}</aside></div>;
}

function ReadingModelDrawer({ onClose }: { onClose: () => void }) {
  const [model, setModel] = useState('Lexloop AI');
  const models = [
    { name: 'Lexloop AI', note: '当前生效模型', icon: <Sparkles size={24}/> },
    { name: 'DeepSeek 3.2', note: '升级 Lexloop Ultra 后可切换', icon: <span>〽</span>, ultra: true },
    { name: 'Qwen 3.5 Plus', note: '升级 Lexloop Ultra 后可切换', icon: <span>✧</span>, ultra: true },
    { name: 'Doubao Seed 2.0', note: '升级 Lexloop Ultra 后可切换', icon: <span>◒</span>, ultra: true },
  ];
  return <StudySettingsDrawer title="阅读材料模型" onClose={onClose}><p className="drawer-intro">分组和独立单词模式会使用这里的模型，生成 Lexloop 的阅读材料和练习内容。</p><div className="model-options">{models.map(item => <button key={item.name} className={`model-option ${model === item.name ? 'is-active' : ''} ${item.ultra ? 'is-locked' : ''}`} onClick={() => !item.ultra && setModel(item.name)} disabled={item.ultra}><span className="model-icon">{item.icon}</span><span><strong>{item.name}{item.ultra && <em>Ultra</em>}</strong><small>{model === item.name ? '当前生效模型' : item.note}</small></span>{model === item.name && <Check size={24}/>}</button>)}</div></StudySettingsDrawer>;
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
    const nextSelected = selected.includes(name) ? selected.filter(item => item !== name) : [...selected, name];
    setSelected(nextSelected);
    setAutomatic(nextSelected.length === 0);
  };
  return <StudySettingsDrawer title="真题题库设置" onClose={onClose}><div className={`exam-mode-card ${automatic ? 'is-current' : ''}`}><FileText size={28}/><div><button className="mode-choice" onClick={() => { setAutomatic(true); setSelected([]); }} aria-pressed={automatic}><i className={automatic ? 'checked' : ''}/><strong>自动模式</strong>{automatic ? <b>当前生效</b> : <small>跟随词表</small>}<CircleHelp size={18}/></button><span>CET4 真题</span></div></div><div className={`exam-mode-card ${!automatic ? 'is-current' : ''}`}><FileText size={28}/><div className="exam-manual"><button className="mode-choice" onClick={() => selected.length > 0 && setAutomatic(false)} aria-pressed={!automatic}><i className={!automatic ? 'checked' : ''}/><strong>手动模式</strong>{automatic ? <small>勾选下方题库后切换</small> : <><b>当前生效</b><small>已选 {selected.length}</small></>}</button>{!automatic && <div className="selected-exam-libraries" aria-label="已选题库">{selected.map(name => <span key={name}>{name}</span>)}</div>}{automatic && <p>从下方题库中勾选范围</p>}{libraries.map(([name, year, sets, count]) => <button className="exam-library" key={name} onClick={() => selectLibrary(name)} aria-pressed={selected.includes(name)}><i className={selected.includes(name) ? 'checked' : ''}/><strong>{name}</strong><span>{year}</span><span>{sets}</span><span>{count}</span></button>)}</div></div></StudySettingsDrawer>;
}

function WordColumn({ title, count, icon, words, isNew, onOpenSettings }: { title: string; count: string; icon: React.ReactNode; words: Word[]; isNew?: boolean; onOpenSettings?: () => void }) {
  const [visibleCount, setVisibleCount] = useState(10);
  const hasMore = visibleCount < words.length;
  const isScrollable = visibleCount > 10;
  return <div className="word-column"><div className={`word-column-head ${isNew ? 'is-new' : ''}`}><div>{icon}<strong>{title}</strong><span>{count}</span></div>{isNew && <div className="column-buttons"><button><Plus size={22}/>3</button><button onClick={onOpenSettings} aria-label="新单词设置"><GearIcon/></button></div>}</div><div className={`word-list ${isScrollable ? 'is-scrollable' : ''}`} aria-label={title}>{words.slice(0, visibleCount).map((word) => <WordRow key={word.word} word={word}/>)}{hasMore && <button className="load-more-words" onClick={() => setVisibleCount(current => Math.min(current + 5, words.length))}>加载更多（剩余 {words.length - visibleCount} 个）</button>}</div></div>;
}

function NewWordSettings({ value, onCancel, onSave }: { value: number; onCancel: () => void; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  return <div className="new-word-settings" role="dialog" aria-label="默认新单词数量"><strong>默认新单词数量（5-40个）</strong><input type="number" min="5" max="40" value={draft} onChange={(event) => setDraft(Number(event.target.value))} autoFocus/><div><button onClick={onCancel}>取消</button><button className="save" onClick={() => onSave(Math.min(40, Math.max(5, draft || 5)))}>保存</button></div></div>;
}

function ReviewWordsIcon() { return <svg className="review-words-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M138.752 302.592c68.608-128 201.216-237.056 360.96-237.056 255.488 0 414.208 200.704 413.696 446.464h63.488c0-315.904-210.944-506.88-477.184-506.88-185.856 0-329.216 97.792-414.208 246.784L5.12 175.616V363.52h189.952l-56.32-60.928z m331.264 230.4L322.56 659.456l42.496 42.496 168.96-147.456V258.56H471.04v274.432h-1.024z m274.432 83.968v63.488H1018.88v-63.488h-274.432z m0 401.92H1018.88v-63.488h-274.432V1018.88z m0-168.96H1018.88v-63.488h-274.432V849.92z m-147.968-169.472H680.96v-63.488h-84.48v63.488z m0 338.432H680.96v-63.488h-84.48V1018.88z m0-168.96H680.96v-63.488h-84.48V849.92z m-147.968 62.976c-152.064-17.92-275.968-107.52-355.328-292.352l-3.072-3.584H26.624c54.272 190.976 210.944 338.944 421.888 359.424 5.12.512 60.928.512 63.488 0v-63.488c-11.776 1.536-48.64 1.536-63.488 0z" fill="currentColor"/></svg>; }

function NewWordsIcon() { return <svg className="new-words-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M140.8 204.8a38.4 38.4 0 1 1 0-76.8L883.2 128a38.4 38.4 0 1 1 0 76.8l-742.4 0z m0 230.4a38.4 38.4 0 1 1 0-76.8l384 0a38.4 38.4 0 1 1 0 76.8l-384 0zM688.4352 647.0656a25.6 25.6 0 0 1-4.8128-14.8992l0-240.3328a25.6 25.6 0 0 1 40.4992-20.8384L892.416 491.1616a25.6 25.6 0 0 1 0 41.6768l-168.2944 120.1664a25.6 25.6 0 0 1-35.6864-5.9392zM140.8 665.6a38.4 38.4 0 1 1 0-76.8l384 0a38.4 38.4 0 0 1 0 76.8l-384 0z m0 230.4a38.4 38.4 0 1 1 0-76.8L883.2 819.2a38.4 38.4 0 0 1 0 76.8l-742.4 0z" fill="currentColor"/></svg>; }

function GearIcon() { return <svg className="gear-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 315.9c-108.3 0-196.1 87.8-196.1 196.1S403.7 708.1 512 708.1 708.1 620.3 708.1 512 620.3 315.9 512 315.9z m93.41 289.51A132.11 132.11 0 1 1 644.1 512a131.25 131.25 0 0 1-38.69 93.41zM851.37 512c0-7.13-0.23-14.33-0.69-21.54l68.83-62.15-4.73-18.69a413.07 413.07 0 0 0-45.62-110L859.29 283l-92.59 4.73a340.49 340.49 0 0 0-30.45-30.45l4.75-92.57-16.56-9.87a413.07 413.07 0 0 0-110-45.62l-18.69-4.74-62.15 68.84a336.56 336.56 0 0 0-43.08 0l-62.15-68.84-18.69 4.74a413.07 413.07 0 0 0-110 45.62L283 164.71l4.73 92.59a341.81 341.81 0 0 0-30.45 30.45L164.71 283l-9.87 16.56a413.07 413.07 0 0 0-45.62 110l-4.74 18.69 68.84 62.15c-0.46 7.21-0.69 14.41-0.69 21.54s0.23 14.33 0.69 21.54l-68.84 62.15 4.74 18.69a413.07 413.07 0 0 0 45.62 110l9.87 16.68 92.59-4.73a340.49 340.49 0 0 0 30.45 30.45L283 859.29l16.56 9.87a413.07 413.07 0 0 0 110 45.62l18.69 4.73 62.15-68.83a336.56 336.56 0 0 0 43.08 0l62.15 68.83 18.69-4.73a413.07 413.07 0 0 0 110-45.62l16.68-9.87-4.73-92.59a341.81 341.81 0 0 0 30.45-30.45l92.57 4.75 9.87-16.56a413.07 413.07 0 0 0 45.62-110l4.73-18.69-68.83-62.15c0.46-7.27 0.69-14.47 0.69-21.6z m-65.75-31.06a276.51 276.51 0 0 1 0 62.12l-1.83 16.32L847.57 617a349.88 349.88 0 0 1-24.1 58.1l-85.81-4.38-10.25 12.85a277.6 277.6 0 0 1-43.88 43.88l-12.85 10.25 4.38 85.81a349.88 349.88 0 0 1-58.1 24.1l-57.58-63.78-16.32 1.83a276.51 276.51 0 0 1-62.12 0l-16.32-1.83L407 847.57a349.88 349.88 0 0 1-58.1-24.1l4.38-85.81-12.85-10.25a277.66 277.66 0 0 1-43.89-43.88l-10.24-12.85-85.81 4.38A349 349 0 0 1 176.44 617l63.77-57.58-1.83-16.32a276.51 276.51 0 0 1 0-62.12l1.83-16.32L176.43 407a349.88 349.88 0 0 1 24.1-58.1l85.81 4.38 10.24-12.85a278.57 278.57 0 0 1 43.89-43.89l12.85-10.24-4.38-85.81a349.88 349.88 0 0 1 58.1-24.1l57.58 63.78 16.32-1.83a276.51 276.51 0 0 1 62.12 0l16.32 1.83L617 176.44a349 349 0 0 1 58.1 24.09l-4.38 85.81 12.85 10.24a277.66 277.66 0 0 1 43.88 43.89l10.25 12.85 85.81-4.38a349.88 349.88 0 0 1 24.1 58.1l-63.78 57.58z" fill="currentColor"/></svg>; }

function FilterSettingsIcon() {
  return <svg className="filter-settings-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M686.973887 582.412635l78.915922-79.63495a61.836403 61.836403 0 0 0-36.774632-104.905135l-111.866159-13.588586a1.844463 1.844463 0 0 1-1.458897-0.937863l-52.103474-98.923656c-11.045937-20.976859-32.106161-34.075672-56.511429-33.14823a61.857245 61.857245 0 0 0-54.917061 35.638776l-47.591314 101.08074a1.834042 1.834042 0 0 1-1.396373 1.04207l-111.147131 18.475892a61.815562 61.815562 0 0 0-32.054058 106.436977l82.896628 77.321556-16.537643 110.38642a61.4821 61.4821 0 0 0 25.822482 59.83563 62.076079 62.076079 0 0 0 65.785847 3.501354l98.527669-54.104248a2.209187 2.209187 0 0 1 1.979932 0l100.851485 49.706714a62.076079 62.076079 0 0 0 65.587854-6.502513 61.4821 61.4821 0 0 0 23.10268-60.929803z m-59.616795 12.879979l21.529156 109.490241c0.093786 0.489773 0.14589 0.812814-0.583559 1.385952a1.844463 1.844463 0 0 1-2.24045 0.208414l-100.851484-49.696294a62.524169 62.524169 0 0 0-57.688967 1.271325l-98.485987 54.125089a1.80278 1.80278 0 0 1-2.219608-0.114628c-0.791973-0.552297-0.75029-0.9066-0.677345-1.396373l16.568905-110.365579a61.721776 61.721776 0 0 0-19.226182-54.521075l-82.907049-77.446604a1.552684 1.552684 0 0 1 1.479739-1.18796l111.115869-18.496733a62.24281 62.24281 0 0 0 46.069892-34.7947l47.601734-101.08074a1.583946 1.583946 0 0 1 1.708994-1.04207h0.104207a1.563104 1.563104 0 0 1 1.677732 0.958704l52.103474 98.913236a62.138603 62.138603 0 0 0 47.560051 32.720982l111.845318 13.546903c0.59398 0.083366 1.19838 0.15631 1.177539 2.563491l-78.926343 79.655791a61.753038 61.753038 0 0 0-16.735636 55.302628zM512 156.831457a45.236236 45.236236 0 0 0 45.246657-45.246657V45.246657a45.246657 45.246657 0 0 0-90.493314 0v66.338143a45.246657 45.246657 0 0 0 45.246657 45.246657zM512 867.168543a45.246657 45.246657 0 0 0-45.246657 45.246657v66.338143a45.246657 45.246657 0 0 0 90.493314 0v-66.338143a45.236236 45.236236 0 0 0-45.246657-45.246657zM978.753343 466.742922h-66.338143a45.246657 45.246657 0 1 0 0 90.493314h66.338143a45.246657 45.246657 0 0 0 0-90.493314zM156.831458 512a45.246657 45.246657 0 0 0-45.246657-45.246657H45.246657a45.246657 45.246657 0 0 0 0 90.493314h66.338144a45.246657 45.246657 0 0 0 45.246657-45.246657zM795.130279 274.116378a45.069505 45.069505 0 0 0 31.991533-13.255124l46.893127-46.893127a45.246657 45.246657 0 1 0-63.983066-63.983066l-46.893127 46.893127a45.257078 45.257078 0 0 0 31.991533 77.23819zM196.878188 763.138746l-46.893127 46.893127a45.246657 45.246657 0 1 0 63.983066 63.983066l46.893127-46.893127a45.246657 45.246657 0 0 0-63.983066-63.983066zM827.121812 763.138746a45.246657 45.246657 0 0 0-63.983066 63.983066l46.893127 46.893127a45.246657 45.246657 0 0 0 63.993487-63.983066zM196.878188 260.861254a45.246657 45.246657 0 1 0 63.983066-63.993487l-46.893127-46.893127a45.253952 45.253952 0 0 0-64.003907 63.993487z"/></svg>;
}

function WordRow({ word }: { word: Word }) {
  return <article className="word-row"><div className="word-copy"><strong>{word.word}</strong><p><span>{word.part}</span>{word.meaning}</p></div><div className="word-actions">{word.state === 'review' && <button className="reviewing"><TimerReset size={14}/>复习中</button>}{!word.state && <button aria-label="加入复习" data-tooltip="加入复习"><ListRestart size={16}/></button>}<button aria-label="标记掌握" data-tooltip="标记掌握"><CheckCircle2 size={16}/></button><button aria-label="稍后再学" data-tooltip="稍后再学"><TimerReset size={16}/></button></div></article>;
}

function ExamBookIcon() { return <svg className="exam-book-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M658.285714 512m-182.857143 0a182.857143 182.857143 0 1 0 365.714286 0 182.857143 182.857143 0 1 0-365.714286 0Z" fill="#D4FD46" /><path d="M362.660571 149.284571H360.228571c-33.097143 0-61.622857 0-84.443428 3.072-24.484571 3.291429-47.926857 10.697143-66.962286 29.732572-19.017143 19.017143-26.441143 42.477714-29.732571 66.962286-3.072 22.838857-3.072 51.346286-3.072 84.443428v431.798857c0 72.155429 58.514286 130.651429 130.669714 130.651429H810.660571a37.339429 37.339429 0 1 0 0-74.660572H306.669714a56.009143 56.009143 0 0 1 0-112H663.771429c33.097143 0 61.622857 0 84.443428-3.072 24.484571-3.291429 47.945143-10.697143 66.962286-29.732571 19.017143-19.017143 26.441143-42.477714 29.732571-66.962286 3.072-22.820571 3.072-51.346286 3.072-84.443428V333.494857c0-33.097143 0-61.622857-3.072-84.443428-3.291429-24.466286-10.697143-47.926857-29.732571-66.962286-19.017143-19.017143-42.477714-26.441143-66.962286-29.732572-22.838857-3.072-51.346286-3.072-84.443428-3.072H362.660571z m-55.990857 485.339429a130.176 130.176 0 0 0-56.009143 12.562286v-311.222857c0-36.260571 0.091429-59.702857 2.413715-76.982858 2.176-16.182857 5.668571-21.248 8.521143-24.100571 2.852571-2.834286 7.917714-6.345143 24.118857-8.521143 17.261714-2.322286 40.704-2.413714 76.946285-2.413714h298.678858c36.242286 0 59.684571 0.091429 76.946285 2.413714 16.201143 2.176 21.266286 5.686857 24.118857 8.521143 2.834286 2.852571 6.345143 7.917714 8.521143 24.118857 2.322286 17.261714 2.413714 40.704 2.413715 76.946286v186.678857c0 36.242286-0.091429 59.684571-2.413715 76.946286-2.176 16.201143-5.668571 21.266286-8.521143 24.118857-2.852571 2.834286-7.917714 6.345143-24.118857 8.521143-17.261714 2.322286-40.704 2.413714-76.946285 2.413714H306.651429z" fill="currentColor" /><path d="M609.554286 363.190857l-3.072 91.392c0 31.488 2.56 57.984 7.68 79.488 5.376 21.504 15.232 36.352 29.568 44.544-17.664 11.008-35.584 16.512-53.76 16.512-32 0-51.712-25.856-59.136-77.568h-78.336c-4.864 16.64-7.296 29.44-7.296 38.4 0 8.704 1.024 15.744 3.072 21.12-18.944 12.032-35.84 18.048-50.688 18.048-22.784 0-34.176-13.824-34.176-41.472 0-13.824 4.224-31.232 12.672-52.224 8.704-20.992 20.096-45.056 34.176-72.192 14.336-27.136 23.424-45.056 27.264-53.76a674.102857 674.102857 0 0 0-9.6-40.704c13.312-9.216 26.112-16.128 38.4-20.736a110.555429 110.555429 0 0 1 40.32-7.296c14.592 0 24.704 3.2 30.336 9.6 14.592-6.4 26.624-9.6 36.096-9.6s16.512 1.536 21.12 4.608c4.608 3.072 7.936 7.552 9.984 13.44 3.584 10.24 5.376 23.04 5.376 38.4z m-77.184 8.832h-12.288c-23.04 44.544-40.192 79.616-51.456 105.216h59.52c0-27.904 1.408-62.976 4.224-105.216z" fill="currentColor" /></svg>; }

const modeLabel = { group: '分组学习', individual: '单词模式', exam: '真题' } as const;

function PlanPreview({ plan, onClose, onStart }: { plan: LearningPlan; onClose: () => void; onStart: () => void }) {
  const [index, setIndex] = useState(0);
  const word = plan.words[index] ?? newWords[index % newWords.length];
  const previous = () => setIndex(current => Math.max(0, current - 1));
  const next = () => setIndex(current => Math.min(plan.wordCount - 1, current + 1));

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex(current => Math.max(0, current - 1));
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIndex(current => Math.min(plan.wordCount - 1, current + 1));
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [onClose, plan.wordCount]);

  return <div className="plan-preview-layer" role="dialog" aria-modal="true" aria-label="学习计划预习" aria-keyshortcuts="ArrowLeft ArrowRight Escape">
    <button className="plan-preview-scrim" onClick={onClose} aria-label="关闭预习"/>
    <section className="plan-preview">
      <header><div><p>学习计划生成完毕</p><span>预习第 {index + 1} / {plan.wordCount} 个单词</span></div><button onClick={onClose} aria-label="关闭"><X size={22}/></button></header>
      <div className="preview-progress"><b style={{ width: `${((index + 1) / plan.wordCount) * 100}%` }}/></div>
      <div className="preview-card-wrap"><button className="preview-arrow" onClick={previous} disabled={index === 0} aria-label="上一个单词"><ChevronLeft size={26}/></button><article className="preview-word-card"><div className="preview-word-title"><strong>{word.word}</strong><span>New</span></div><div className="preview-pronunciation">/{word.word}/ <button aria-label={`播放 ${word.word} 发音`}>◖</button></div><hr/><p><b>{word.part}</b>{word.meaning}</p><small>可使用左右方向键切换，空格键播放发音</small></article><button className="preview-arrow" onClick={next} disabled={index === plan.wordCount - 1} aria-label="下一个单词"><ChevronRight size={26}/></button></div>
      <button className="start-challenge" onClick={onStart}><Play size={19}/>开始今天的挑战</button>
    </section>
  </div>;
}

function PlanPanel({ plan, onContinue }: { plan: LearningPlan | null; onContinue: (id: number) => void }) {
  if (!plan) return <section className="plan-empty"><CalendarDays size={32}/><strong>还没有学习序列</strong><p>在单词列表中创建学习计划后，会在这里显示。</p></section>;
  const groups = splitPlanWords(plan.words);
  const progress = Math.round((plan.completed / plan.wordCount) * 100);
  return <section className="sequence-panel"><header className="sequence-head"><div><BookOpen size={23}/><strong>学习序列</strong><span>{modeLabel[plan.mode]}</span><span>正常模式</span><span>第 1/{groups.length} 组</span></div><div className="sequence-summary"><small>{plan.completed}/{plan.wordCount}</small><b>{progress}%</b><i><em style={{ width: `${progress}%` }}/></i><button onClick={() => onContinue(plan.id)}><BookOpen size={18}/>{plan.completed === plan.wordCount ? '已完成' : '继续学习'}</button></div></header><div className="sequence-body"><header><strong>学习分组</strong><span>共 {groups.length} 组</span><small>New 新单词</small></header><div className="sequence-words">{groups.map((group, index) => <article key={`${plan.id}-${index}`}><b className={index === 0 ? 'done' : ''}>{index + 1}</b><strong>{group.map(word => word.word).join(' · ')}</strong><BookOpen size={20}/></article>)}</div></div></section>;
}

function SenseLevelBadge({ word }: { word: Word }) {
  const levels: Record<string, [number, string]> = { health: [5, 'A1'], view: [4, 'B1'], first: [3, 'B2'], public: [4, 'A2'], video: [3, 'B1'] };
  const [frequency, cefr] = levels[word.word] ?? [3, 'B2'];
  return <span className={`sense-level level-${frequency}`} tabIndex={0} aria-label={`使用频率 ${frequency}/5，CEFR ${cefr}`}><i>{Array.from({ length: 5 }, (_, index) => <b key={index} className={index < frequency ? 'filled' : ''}/>)}</i><em>{cefr}</em><span className="sense-level-tooltip"><strong>词义级别说明</strong><b>使用频率 {frequency}/5</b><p>{frequency >= 4 ? '高频词义，日常对话和常见阅读中经常出现。' : frequency >= 2 ? '常用词义，在新闻、书籍和正式场合中稳定出现。' : '低频词义，适合在特定语境中重点辨认。'}</p><b>CEFR 级别 <em>{cefr}</em></b><p>{cefr === 'A1' ? '基础入门词义，适合日常简单交流。' : cefr.startsWith('B') ? '进阶表达词义，用于更复杂的交流与阅读。' : '常用学习阶段词义。'}</p></span></span>;
}

function WordMeaningCard({ word }: { word: Word }) {
  const senses = word.meaning.split('｜');
  return <section className="word-meaning-card"><header><span>{word.part}</span><strong>{word.word}</strong><SenseLevelBadge word={word}/></header><div className="meaning-senses">{senses.map((sense, index) => <p key={sense}><b>{index + 1}</b>{sense}</p>)}</div></section>;
}

function GroupStudyPage({ plan, onBack, onCompleteWords }: { plan: LearningPlan | null; onBack: () => void; onCompleteWords: (id: number, amount: number) => void }) {
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [selectedPhrase, setSelectedPhrase] = useState<string | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<number | null>(null);
  const [matches, setMatches] = useState<Record<number, string>>({});
  const [matchChecked, setMatchChecked] = useState(false);
  if (!plan) return null;
  const groups = splitPlanWords(plan.words);
  const currentGroupIndex = Math.min(Math.floor(plan.completed / GROUP_WORD_LIMIT), groups.length - 1);
  const words = groups[currentGroupIndex] ?? [];
  const matchWord = words[0];
  const phrases = matchWord ? [`${matchWord.word} people`, `${matchWord.word} oneself`, `${matchWord.word} to improve`, `can't ${matchWord.word} doing`] : [];
  const definitions = ['用于描述助力达成某种积极结果', '指提供服务来帮助大众', '表示情不自禁地做某事', '常用的习语表达，意为自助'];
  const allMatched = phrases.length > 0 && Object.keys(matches).length === phrases.length;
  const allCompleted = words.every(word => results[word.word] !== undefined);
  const choosePhrase = (phrase: string) => {
    if (matchChecked) return;
    if (Object.values(matches).includes(phrase)) return;
    if (selectedDefinition !== null) { setMatches(current => ({ ...current, [selectedDefinition]: phrase })); setSelectedDefinition(null); setSelectedPhrase(null); }
    else setSelectedPhrase(phrase);
  };
  const chooseDefinition = (index: number) => {
    if (matchChecked) return;
    if (matches[index]) {
      setMatches(current => { const next = { ...current }; delete next[index]; return next; });
      setSelectedPhrase(null);
      setSelectedDefinition(null);
      return;
    }
    if (selectedPhrase) { setMatches(current => ({ ...current, [index]: selectedPhrase })); setSelectedPhrase(null); setSelectedDefinition(null); }
    else setSelectedDefinition(index);
  };
  const checkMatches = () => {
    const correct = phrases.every((phrase, index) => matches[index] === phrase);
    setMatchChecked(true);
    if (matchWord) setResults(current => ({ ...current, [matchWord.word]: correct }));
  };
  const answerInstantly = (word: Word, choice: string) => setResults(current => ({ ...current, [word.word]: choice === word.meaning.split('｜')[0] }));
  useEffect(() => { setResults({}); setMatches({}); setSelectedPhrase(null); setSelectedDefinition(null); setMatchChecked(false); }, [currentGroupIndex]);
  useEffect(() => {
    const card = document.querySelector<HTMLElement>('.reading-card');
    if (!card || card.querySelector('.reading-tools')) return;
    const toolbar = document.createElement('div'); toolbar.className = 'reading-tools';
    const sentences = ['In the realm of cultural exchange, accessing reliable information can be challenging.', `Our service steps in to ${words[0]?.word ?? 'help'}.`, `We create and share high-quality ${words[1]?.word ?? 'resources'} for learners.`, 'Join us and explore these enriching materials today.'];
    const addTool = (label: string, icon: string, action: () => void) => { const button = document.createElement('button'); button.type = 'button'; button.title = label; button.dataset.tip = label; button.setAttribute('aria-label', label); button.textContent = icon; button.addEventListener('click', action); toolbar.append(button); };
    addTool('展开分句阅读', '☰', () => { const existing = card.querySelector('.sentence-reading'); const original = Array.from(card.querySelectorAll<HTMLElement>(':scope > p:not(.reading-lede)')); if (existing) { existing.remove(); original.forEach(item => { item.style.display = ''; }); toolbar.querySelector('button')!.title = '展开分句阅读'; toolbar.querySelector('button')!.dataset.tip = '展开分句阅读'; return; } original.forEach(item => { item.style.display = 'none'; }); const list = document.createElement('div'); list.className = 'sentence-reading'; sentences.forEach((sentence, index) => { const line = document.createElement('article'); line.className = 'sentence-line'; const text = document.createElement('p'); let rich = sentence; words.forEach((word, wordIndex) => { rich = rich.replace(new RegExp(`\\b${word.word}\\b`, 'gi'), `<mark style="background:${WORD_TONES[wordIndex % WORD_TONES.length].background};color:${WORD_TONES[wordIndex % WORD_TONES.length].color}">${word.word}</mark>`); }); text.innerHTML = `${index + 1}. ${rich}`; const tools = document.createElement('div'); tools.className = 'sentence-tools'; [['复制', '⧉'], ['翻译', '译'], ['语法分析', '⌕'], ['简化', '✦'], ['朗读', '◖']].forEach(([label, icon]) => { const button = document.createElement('button'); button.textContent = icon; button.title = label; button.dataset.tip = label; button.setAttribute('aria-label', label); button.addEventListener('click', () => { if (label === '复制') navigator.clipboard?.writeText(sentence); if (label === '朗读') window.speechSynthesis?.speak(new SpeechSynthesisUtterance(sentence)); }); tools.append(button); }); line.append(text, tools); list.append(line); }); card.append(list); toolbar.querySelector('button')!.title = '收起分句阅读'; toolbar.querySelector('button')!.dataset.tip = '收起分句阅读'; });
    addTool('翻译全文', '译', () => { const existing = card.querySelector('.reading-translation'); if (existing) { existing.remove(); return; } const translation = document.createElement('p'); translation.className = 'reading-translation'; translation.textContent = '全文翻译：在文化交流中，可靠的信息十分重要。我们的服务帮助学习者获取优质资源，并持续提升跨文化沟通能力。'; card.append(translation); });
    addTool('简化全文', '✦', () => { const existing = card.querySelector('.reading-simple'); if (existing) { existing.remove(); return; } const simple = document.createElement('p'); simple.className = 'reading-simple'; simple.textContent = '简化版：我们分享有用的学习资源，帮助大家更好地交流。'; card.append(simple); });
    addTool('朗读全文', '◖', () => window.speechSynthesis?.speak(new SpeechSynthesisUtterance(sentences.join(' '))));
    card.append(toolbar);
    return () => toolbar.remove();
  }, [currentGroupIndex, words]);
  const continueToNextGroup = () => onCompleteWords(plan.id, words.length);
  return <section className="lesson-page"><header className="lesson-page-head"><button onClick={onBack}><ArrowLeft size={19}/>返回学习序列</button><div><span>分组学习 · 正常模式</span><strong>第 {currentGroupIndex + 1} / {groups.length} 组</strong></div><b>{plan.completed}/{plan.wordCount} 已掌握</b></header><div className="lesson-layout"><main><section className="lesson-section"><header><BookOpen size={19}/><h1>阅读材料</h1></header><article className="reading-card"><div className="lesson-word-chips">{words.map((word, index) => <span key={word.word} style={wordTone(index)}>{word.word}<b>{articleOccurrenceCount(index, words.length)}</b></span>)}</div><h2>{words.map((word, index) => <span className="reading-title-word" style={wordTone(index)} key={word.word}>{word.word[0]?.toUpperCase() + word.word.slice(1)}{index === words.length - 1 ? '' : ' '}</span>)}</h2><p className="reading-lede">A short story built around this group&apos;s new words. Read it once, then use the exercises below to lock the words into memory.</p><p>{words.map((word, index) => <span key={word.word}>Learning to <mark style={wordTone(index)}>{word.word}</mark>{index === words.length - 1 ? ' turns a small daily effort into lasting progress.' : ', '}</span>)}</p><p>Each word appears in context, so you can connect its meaning with a complete idea instead of memorising it in isolation.{words.length > 0 && <> Revisit <mark style={wordTone(words.length - 1)}>{words[words.length - 1].word}</mark> before you continue.</>}</p><small>Powered by Lexloop AI</small></article></section><section className="lesson-section exercises"><header><Sparkles size={19}/><h2>练习题</h2></header>{matchWord && <article className="exercise-card matching-exercise"><span className="exercise-kind">单词匹配</span><h3>Match the phrases containing <mark style={wordTone(0)}>{matchWord.word}</mark> with their correct descriptions.</h3><p>单词、释义均可先点击，再选择另一侧完成匹配。</p><div className="match-phrases">{phrases.map(phrase => <button key={phrase} className={`${selectedPhrase === phrase ? 'selected' : ''} ${matchChecked ? (Object.values(matches).includes(phrase) ? 'linked' : '') : ''}`} onClick={() => choosePhrase(phrase)}>{phrase}</button>)}</div><div className="match-definitions">{definitions.map((definition, index) => { const phrase = matches[index]; const correct = phrase === phrases[index]; return <button key={definition} className={`${selectedDefinition === index ? 'selected' : ''} ${phrase ? 'linked' : ''} ${matchChecked ? (correct ? 'correct' : 'wrong') : ''}`} onClick={() => chooseDefinition(index)}><span>{definition}</span>{phrase ? <b>{phrase}</b> : <em>{selectedPhrase ? '选择此处' : '选择上方选项'}</em>}</button>; })}</div>{allMatched && !matchChecked && <button className="check-matches" onClick={checkMatches}>✓ 检查结果</button>}{matchChecked && <><strong className={results[matchWord.word] ? 'answer-feedback success' : 'answer-feedback'}>{results[matchWord.word] ? '匹配正确！' : '有匹配错误，请查看标记结果。'}</strong><WordMeaningCard word={matchWord}/></>}</article>}{words.slice(1).map((word, index) => { const answer = word.meaning.split('｜')[0]; const options = [answer, 'to work without a clear purpose', 'to avoid taking responsibility', 'to stop before finishing a task']; const result = results[word.word]; return <article className="exercise-card" key={word.word}><span className="exercise-kind">{exerciseType(index + 1)}</span><h3>Choose the phrase that best matches <mark style={wordTone(index + 1)}>{word.word}</mark>.</h3><p>点击选项后立即显示结果。</p><div className="answer-options">{options.map(option => <button key={option} className={`${result !== undefined && option === answer ? 'correct' : ''} ${result !== undefined && option !== answer && option !== answer ? 'muted' : ''}`} onClick={() => result === undefined && answerInstantly(word, option)}>{option}{result !== undefined && option === answer && ' ✓'}</button>)}</div>{result !== undefined && <><strong className={result ? 'answer-feedback success' : 'answer-feedback'}>{result ? '回答正确！' : '回答错误，正确答案已标出。'}</strong><WordMeaningCard word={word}/></>}</article>; })}</section></main><aside className="lesson-side"><section><h2>本组学习单词</h2>{words.map((word, index) => <button key={word.word} className={index === 0 ? 'active' : ''} style={wordTone(index)}><b>{index + 1}</b><span><strong>{word.word}</strong><small>{word.meaning.split('｜')[0]}</small></span><Volume2 size={17}/></button>)}</section><section className="exercise-progress"><h2>练习题</h2>{words.map((word, index) => { const result = results[word.word]; return <div className={result === undefined ? '' : result ? 'is-correct' : 'is-wrong'} key={word.word}>{result === undefined ? <Circle size={25}/> : result ? <CheckCircle2 size={25}/> : <CircleX size={25}/>}<strong>{word.word}</strong><span>{exerciseType(index)}</span></div>; })}<p>{allCompleted ? '本组练习已完成' : '完成所有练习题后即可进入下一组'}</p></section><section className="lesson-helper"><Sparkles size={20}/><strong>词环学习助手</strong><p>需要解释、例句或记忆方法？随时问我。</p><div><input placeholder="问问本组单词…"/><button aria-label="发送问题"><Send size={17}/></button></div></section></aside></div></section>;
}

function LearningHistory({ plans, onContinue }: { plans: LearningPlan[]; onContinue: (id: number) => void }) {
  if (!plans.length) return <section className="plan-empty"><CalendarDays size={32}/><strong>今天还没有学习记录</strong><p>创建学习计划后，学习进度会保留在这里。</p></section>;
  return <section className="history-grid">{plans.map(plan => { const progress = Math.round((plan.completed / plan.wordCount) * 100); return <article className={plan.started ? 'is-current' : ''} key={plan.id}><header><span>{modeLabel[plan.mode]}</span><span>正常模式</span><span>{plan.wordCount} 组单词</span>{plan.started ? <b><Play size={16}/>学习中</b> : <b><Pause size={16}/>未完成</b>}</header><div><strong>{plan.completed}/{plan.wordCount} 单词</strong><em>（剩余：{plan.wordCount - plan.completed}）</em><b>{progress}%</b></div><i><em style={{ width: `${progress}%` }}/></i><footer><span>当前学习分组：{Math.min(plan.completed + 1, plan.wordCount)} / {plan.wordCount}</span><button onClick={() => onContinue(plan.id)}><BookOpen size={18}/>继续学习</button></footer></article>; })}</section>;
}
