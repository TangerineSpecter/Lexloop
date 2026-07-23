'use client';

import {
  BookOpen, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, Copy, Eye, EyeOff, Flame, Grid2X2, LayoutList, ListRestart, LogOut, Menu,
  Plus, Settings2, Sparkles, TimerReset, Trophy, UserRound, X,
} from 'lucide-react';
import { useState } from 'react';
import { request, type Session } from '../lib/api';

type Word = { word: string; part: string; meaning: string; state?: 'review' };
type StudyMode = 'group' | 'individual' | 'exam';

const reviewWords: Word[] = [
  { word: 'business', part: 'n.', meaning: '商业；买卖；生意｜职业；行业｜企业；公司｜事情；事务', state: 'review' },
  { word: 'help', part: 'vt.', meaning: '帮助，协助｜改善，促进｜避免，防止', state: 'review' },
];
const newWords: Word[] = [
  { word: 'health', part: 'n.', meaning: '健康；康健｜（人的）健康状况｜（组织、系统等的）运行状况' },
  { word: 'view', part: 'n.', meaning: '查看，观察｜观点，看法｜景色，风景' },
  { word: 'first', part: 'adj.', meaning: '第一的；最早的；首要的｜一流的；最重要的' },
  { word: 'click', part: 'vt.', meaning: '使发出咔嗒声｜点击' },
  { word: 'like', part: 'vt.', meaning: '喜欢；喜爱｜希望；想要' },
  { word: 'find', part: 'vt.', meaning: '找到；发现｜（经历后）获得；得到' },
];

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState<'words' | 'plan'>('words');
  const [plannedMode, setPlannedMode] = useState<StudyMode>('group');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bookPickerOpen, setBookPickerOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [page, setPage] = useState<'study' | 'settings'>('study');
  const name = session.user.displayName || session.user.email.split('@')[0];

  return <main className="study-app">
    <aside className={`study-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <div className="sidebar-account-wrap"><button className="sidebar-book" onClick={() => setAccountMenuOpen((open) => !open)} aria-expanded={accountMenuOpen}><Avatar/><div><strong>{name}</strong><span>大学 CET-4 四级词汇</span></div><ChevronDown size={15}/></button>{accountMenuOpen && <AccountMenu name={name} onSettings={() => { setPage('settings'); setAccountMenuOpen(false); setSidebarOpen(false); }} onLogout={onLogout}/>}</div>
      <Calendar />
      <nav className="sidebar-nav" aria-label="主导航">
        <span className="nav-label">APP</span>
        <button className={`nav-item nav-button ${page === 'study' ? 'active' : ''}`} onClick={() => { setPage('study'); setSidebarOpen(false); }}><BookOpen size={16}/><span>词环</span></button>
        <div className="nav-group"><a className="nav-item" href="#words"><BookOpen size={16}/><span>我的单词</span><ChevronDown size={14}/></a><div className="nav-children"><a href="#learning">学习中</a><a href="#mastered">已掌握</a></div></div>
        <button className="nav-item nav-button" onClick={() => { setPage('settings'); setSidebarOpen(false); }}><Settings2 size={16}/><span>账户设置</span></button>
      </nav>
      <div className="sidebar-bottom"><button className="switch-book" onClick={() => setBookPickerOpen(true)}><Plus size={15}/>切换词汇表</button><button className="feedback"><CircleHelp size={15}/>反馈建议</button></div>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}/>}

    <section className="study-shell">
      <header className="study-topbar"><button className="menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={19}/></button><span className="topbar-brand"><BookOpen size={15}/> Lexloop · 词环</span><div className="topbar-actions"><button className="topbar-account" onClick={() => setAccountMenuOpen((open) => !open)} aria-label="账户菜单"><Avatar/><span>{name}</span><ChevronDown size={15}/></button></div></header>
      {page === 'study' ? <div className="study-content">
        <h1>学习进度</h1>
        <section className="progress-grid">
          <article className="streak-card"><div><div className="card-heading"><strong>学习连胜</strong><Trophy size={18}/><CheckCircle2 size={18}/></div><p>每天坚持学习，就能持续积累「连胜」<br/>你的「词汇量」和「外语水平」将迎来显著突破！</p></div><div className="streak-count"><b>0</b><Flame size={26}/><button aria-label="签到"><CheckCircle2 size={22}/></button><small>Today</small></div></article>
          <Metric title="词表总词数" value="4545" detail="大学 CET-4 四级词汇" />
          <Metric title="已学习词数" value="2" detail="学习进度 0.0%" />
        </section>

        <div className="learning-tabs"><button className={activeTab === 'words' ? 'active' : ''} onClick={() => setActiveTab('words')}>单词列表</button><button className={activeTab === 'plan' ? 'active' : ''} onClick={() => setActiveTab('plan')}>今天的学习序列</button></div>
        {activeTab === 'words' ? <WordsPanel onCreatePlan={(mode) => { setPlannedMode(mode); setActiveTab('plan'); }} /> : <PlanPanel mode={plannedMode} />}
      </div> : <AccountSettings session={session} onBack={() => setPage('study')} />}
    </section>
    {bookPickerOpen && <BookPicker onClose={() => setBookPickerOpen(false)} />}
  </main>;
}

function Avatar() { return <span className="profile-avatar" aria-hidden="true"><i/><b/></span>; }

function AccountMenu({ name, onSettings, onLogout }: { name: string; onSettings: () => void; onLogout: () => void }) {
  return <div className="account-menu"><div className="account-menu-user"><Avatar/><strong>{name}</strong></div><button onClick={onSettings}><Settings2 size={22}/>账户设置</button><button onClick={onLogout}><LogOut size={22}/>退出登录</button></div>;
}

function BookPicker({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'learning' | 'mine' | 'system'>('learning');
  const cards = [{ title: '大学 CET-4 四级词汇', total: '4545', learned: '2', current: true, note: '含有大量常见词汇' }, { title: '大学 CET-6 六级词汇', total: '2345', learned: '0' }];
  return <div className="book-drawer" role="dialog" aria-modal="true" aria-label="选择词表"><header><div><h2>选择词表</h2><p>请选择一个词表开始您的学习之旅。</p></div><button onClick={onClose} aria-label="关闭"><X size={23}/></button></header><div className="book-tabs"><button className={tab === 'learning' ? 'active' : ''} onClick={() => setTab('learning')}>学习中（2）</button><button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>我的词表</button><button className={tab === 'system' ? 'active' : ''} onClick={() => setTab('system')}>系统词表（18）</button></div>{tab === 'learning' && <div className="book-card-grid">{cards.map(card => <article className="book-choice" key={card.title}><div><strong>{card.title}</strong><p>总词数: {card.total} | 已学: {card.learned}</p>{card.note && <small>{card.note}</small>}</div><button className={card.current ? 'current' : ''}>{card.current ? '当前' : '继续学习'}</button></article>)}</div>}{tab === 'mine' && <div className="book-empty"><strong>我的词表</strong><p>还没有创建任何词表</p><button><Plus size={18}/>创建新词表</button></div>}{tab === 'system' && <div className="book-system"><h3>升学与校内</h3><p>面向国内学习阶段、校内考试与升学目标的词表。</p><div className="book-card-grid">{cards.map(card => <article className="book-choice" key={`system-${card.title}`}><div><strong>{card.title}</strong><p>总词数: {card.total} | 已学: {card.learned}</p></div><button>开始学习</button></article>)}</div></div>}</div>;
}

function AccountSettings({ session, onBack }: { session: Session; onBack: () => void }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [show, setShow] = useState(false); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (password.length < 8) return setMessage('新密码至少需要 8 位。'); if (password !== confirm) return setMessage('两次输入的密码不一致。'); setBusy(true); setMessage(''); try { await request('/auth/password', { method: 'POST', body: JSON.stringify({ password }) }, session.accessToken); setPassword(''); setConfirm(''); setMessage('密码已更新。'); } catch (error) { setMessage(error instanceof Error ? error.message : '更新失败，请稍后重试。'); } finally { setBusy(false); } };
  return <div className="settings-page"><header className="settings-heading"><div><button className="settings-back" onClick={onBack}>← 返回学习</button><h1>设置</h1><p>管理您的账号和系统设置</p></div><div className="identity-card"><span>身份 ID（可用于客服联系问题）</span><strong>{session.user.id}</strong><button onClick={() => navigator.clipboard?.writeText(session.user.id)} aria-label="复制身份 ID"><Copy size={20}/></button></div></header><div className="settings-layout"><nav><button className="active"><UserRound size={19}/>账号设置</button></nav><section><h2>账号设置</h2><form className="password-card" onSubmit={save}><h3>密码管理</h3><p>更新您的账户密码</p><label>新密码<div className="password-input"><input type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password"/><button type="button" onClick={() => setShow(!show)} aria-label="显示密码">{show ? <EyeOff size={20}/> : <Eye size={20}/>}</button></div></label><label>确认密码<input type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password"/></label>{message && <p className={message === '密码已更新。' ? 'form-success' : 'form-error'}>{message}</p>}<button className="save-password" disabled={busy}>{busy ? '更新中…' : '更新密码'}</button></form></section></div></div>;
}

function Calendar() {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return <section className="mini-calendar"><div className="calendar-title"><ChevronLeft size={15}/><span>July 2026</span><ChevronRight size={15}/></div><div className="calendar-grid weekdays">{['Su','Mo','Tu','We','Th','Fr','Sa'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: 3 }, (_, i) => <span key={`e${i}`} />)}{days.map(day => <button key={day} className={day === 22 ? 'today' : ''}>{day}</button>)}<span className="muted-day">1</span></div></section>;
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <article className="metric-card"><span>{title}</span><b>{value}</b><small>{detail}</small></article>;
}

function WordsPanel({ onCreatePlan }: { onCreatePlan: (mode: StudyMode) => void }) {
  const [mode, setMode] = useState<StudyMode>('group');
  const [newWordCount, setNewWordCount] = useState(15);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return <section className="words-panel">
    <header className="panel-top"><div className="panel-title"><BookOpen size={18}/><strong>今日学习词汇</strong></div><div className="panel-progress"><span>待复习: 2</span><span>新单词: {newWordCount}</span><i><b/></i></div><div className="toolbar"><button className={mode === 'group' ? 'selected' : ''} onClick={() => setMode('group')}><Grid2X2 size={15}/>分组</button><button className={mode === 'individual' ? 'selected' : ''} onClick={() => setMode('individual')}><LayoutList size={15}/>独立单词</button><button className={`real ${mode === 'exam' ? 'selected' : ''}`} onClick={() => setMode('exam')}><span>◎</span> 真题 <em>NEW</em></button><button className="create" onClick={() => onCreatePlan(mode)}><Sparkles size={15}/>创建学习计划</button><button aria-label="筛选设置">{mode === 'exam' ? <ExamBookIcon/> : <FilterSettingsIcon/>}</button></div></header>
    <div className="word-columns"><WordColumn title="待复习单词" count="2" icon={<TimerReset size={17}/>} words={reviewWords}/><WordColumn title="新单词" count={String(newWordCount)} icon={<NewWordsIcon/>} words={newWords} isNew onOpenSettings={() => setSettingsOpen(true)}/></div>
    {settingsOpen && <NewWordSettings value={newWordCount} onCancel={() => setSettingsOpen(false)} onSave={(value) => { setNewWordCount(value); setSettingsOpen(false); }}/>}
  </section>;
}

function WordColumn({ title, count, icon, words, isNew, onOpenSettings }: { title: string; count: string; icon: React.ReactNode; words: Word[]; isNew?: boolean; onOpenSettings?: () => void }) {
  return <div className="word-column"><div className={`word-column-head ${isNew ? 'is-new' : ''}`}><div>{icon}<strong>{title}</strong><span>{count}</span></div>{isNew && <div className="column-buttons"><button><Plus size={22}/>3</button><button onClick={onOpenSettings} aria-label="新单词设置"><GearIcon/></button></div>}</div><div className="word-list">{words.map((word) => <WordRow key={word.word} word={word}/>)}</div></div>;
}

function NewWordSettings({ value, onCancel, onSave }: { value: number; onCancel: () => void; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  return <div className="new-word-settings" role="dialog" aria-label="默认新单词数量"><strong>默认新单词数量（5-40个）</strong><input type="number" min="5" max="40" value={draft} onChange={(event) => setDraft(Number(event.target.value))} autoFocus/><div><button onClick={onCancel}>取消</button><button className="save" onClick={() => onSave(Math.min(40, Math.max(5, draft || 5)))}>保存</button></div></div>;
}

function NewWordsIcon() { return <svg className="new-words-icon" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 7h16M3 16h23M3 25h16M26 5v10M21 10h10"/></svg>; }

function GearIcon() { return <svg className="gear-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 315.9c-108.3 0-196.1 87.8-196.1 196.1S403.7 708.1 512 708.1 708.1 620.3 708.1 512 620.3 315.9 512 315.9z m93.41 289.51A132.11 132.11 0 1 1 644.1 512a131.25 131.25 0 0 1-38.69 93.41zM851.37 512c0-7.13-0.23-14.33-0.69-21.54l68.83-62.15-4.73-18.69a413.07 413.07 0 0 0-45.62-110L859.29 283l-92.59 4.73a340.49 340.49 0 0 0-30.45-30.45l4.75-92.57-16.56-9.87a413.07 413.07 0 0 0-110-45.62l-18.69-4.74-62.15 68.84a336.56 336.56 0 0 0-43.08 0l-62.15-68.84-18.69 4.74a413.07 413.07 0 0 0-110 45.62L283 164.71l4.73 92.59a341.81 341.81 0 0 0-30.45 30.45L164.71 283l-9.87 16.56a413.07 413.07 0 0 0-45.62 110l-4.74 18.69 68.84 62.15c-0.46 7.21-0.69 14.41-0.69 21.54s0.23 14.33 0.69 21.54l-68.84 62.15 4.74 18.69a413.07 413.07 0 0 0 45.62 110l9.87 16.68 92.59-4.73a340.49 340.49 0 0 0 30.45 30.45L283 859.29l16.56 9.87a413.07 413.07 0 0 0 110 45.62l18.69 4.73 62.15-68.83a336.56 336.56 0 0 0 43.08 0l62.15 68.83 18.69-4.73a413.07 413.07 0 0 0 110-45.62l16.68-9.87-4.73-92.59a341.81 341.81 0 0 0 30.45-30.45l92.57 4.75 9.87-16.56a413.07 413.07 0 0 0 45.62-110l4.73-18.69-68.83-62.15c0.46-7.27 0.69-14.47 0.69-21.6z m-65.75-31.06a276.51 276.51 0 0 1 0 62.12l-1.83 16.32L847.57 617a349.88 349.88 0 0 1-24.1 58.1l-85.81-4.38-10.25 12.85a277.6 277.6 0 0 1-43.88 43.88l-12.85 10.25 4.38 85.81a349.88 349.88 0 0 1-58.1 24.1l-57.58-63.78-16.32 1.83a276.51 276.51 0 0 1-62.12 0l-16.32-1.83L407 847.57a349.88 349.88 0 0 1-58.1-24.1l4.38-85.81-12.85-10.25a277.66 277.66 0 0 1-43.89-43.88l-10.24-12.85-85.81 4.38A349 349 0 0 1 176.44 617l63.77-57.58-1.83-16.32a276.51 276.51 0 0 1 0-62.12l1.83-16.32L176.43 407a349.88 349.88 0 0 1 24.1-58.1l85.81 4.38 10.24-12.85a278.57 278.57 0 0 1 43.89-43.89l12.85-10.24-4.38-85.81a349.88 349.88 0 0 1 58.1-24.1l57.58 63.78 16.32-1.83a276.51 276.51 0 0 1 62.12 0l16.32 1.83L617 176.44a349 349 0 0 1 58.1 24.09l-4.38 85.81 12.85 10.24a277.66 277.66 0 0 1 43.88 43.89l10.25 12.85 85.81-4.38a349.88 349.88 0 0 1 24.1 58.1l-63.78 57.58z" fill="currentColor"/></svg>; }

function FilterSettingsIcon() {
  return <svg className="filter-settings-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M686.973887 582.412635l78.915922-79.63495a61.836403 61.836403 0 0 0-36.774632-104.905135l-111.866159-13.588586a1.844463 1.844463 0 0 1-1.458897-0.937863l-52.103474-98.923656c-11.045937-20.976859-32.106161-34.075672-56.511429-33.14823a61.857245 61.857245 0 0 0-54.917061 35.638776l-47.591314 101.08074a1.834042 1.834042 0 0 1-1.396373 1.04207l-111.147131 18.475892a61.815562 61.815562 0 0 0-32.054058 106.436977l82.896628 77.321556-16.537643 110.38642a61.4821 61.4821 0 0 0 25.822482 59.83563 62.076079 62.076079 0 0 0 65.785847 3.501354l98.527669-54.104248a2.209187 2.209187 0 0 1 1.979932 0l100.851485 49.706714a62.076079 62.076079 0 0 0 65.587854-6.502513 61.4821 61.4821 0 0 0 23.10268-60.929803z m-59.616795 12.879979l21.529156 109.490241c0.093786 0.489773 0.14589 0.812814-0.583559 1.385952a1.844463 1.844463 0 0 1-2.24045 0.208414l-100.851484-49.696294a62.524169 62.524169 0 0 0-57.688967 1.271325l-98.485987 54.125089a1.80278 1.80278 0 0 1-2.219608-0.114628c-0.791973-0.552297-0.75029-0.9066-0.677345-1.396373l16.568905-110.365579a61.721776 61.721776 0 0 0-19.226182-54.521075l-82.907049-77.446604a1.552684 1.552684 0 0 1 1.479739-1.18796l111.115869-18.496733a62.24281 62.24281 0 0 0 46.069892-34.7947l47.601734-101.08074a1.583946 1.583946 0 0 1 1.708994-1.04207h0.104207a1.563104 1.563104 0 0 1 1.677732 0.958704l52.103474 98.913236a62.138603 62.138603 0 0 0 47.560051 32.720982l111.845318 13.546903c0.59398 0.083366 1.19838 0.15631 1.177539 2.563491l-78.926343 79.655791a61.753038 61.753038 0 0 0-16.735636 55.302628zM512 156.831457a45.236236 45.236236 0 0 0 45.246657-45.246657V45.246657a45.246657 45.246657 0 0 0-90.493314 0v66.338143a45.246657 45.246657 0 0 0 45.246657 45.246657zM512 867.168543a45.246657 45.246657 0 0 0-45.246657 45.246657v66.338143a45.246657 45.246657 0 0 0 90.493314 0v-66.338143a45.236236 45.236236 0 0 0-45.246657-45.246657zM978.753343 466.742922h-66.338143a45.246657 45.246657 0 1 0 0 90.493314h66.338143a45.246657 45.246657 0 0 0 0-90.493314zM156.831458 512a45.246657 45.246657 0 0 0-45.246657-45.246657H45.246657a45.246657 45.246657 0 0 0 0 90.493314h66.338144a45.246657 45.246657 0 0 0 45.246657-45.246657zM795.130279 274.116378a45.069505 45.069505 0 0 0 31.991533-13.255124l46.893127-46.893127a45.246657 45.246657 0 1 0-63.983066-63.983066l-46.893127 46.893127a45.257078 45.257078 0 0 0 31.991533 77.23819zM196.878188 763.138746l-46.893127 46.893127a45.246657 45.246657 0 1 0 63.983066 63.983066l46.893127-46.893127a45.246657 45.246657 0 0 0-63.983066-63.983066zM827.121812 763.138746a45.246657 45.246657 0 0 0-63.983066 63.983066l46.893127 46.893127a45.246657 45.246657 0 0 0 63.993487-63.983066zM196.878188 260.861254a45.246657 45.246657 0 1 0 63.983066-63.993487l-46.893127-46.893127a45.253952 45.253952 0 0 0-64.003907 63.993487z"/></svg>;
}

function WordRow({ word }: { word: Word }) {
  return <article className="word-row"><div className="word-copy"><strong>{word.word}</strong><p><span>{word.part}</span>{word.meaning}</p></div><div className="word-actions">{word.state === 'review' && <button className="reviewing"><TimerReset size={14}/>复习中</button>}<button title="加入学习"><ListRestart size={16}/></button><button title="标记掌握"><CheckCircle2 size={16}/></button><button title="稍后再学"><TimerReset size={16}/></button></div></article>;
}

function ExamBookIcon() { return <svg className="exam-book-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M786.672 245.739c-12.5-0.7-23.1 8.8-23.8 21.3v508.8c-1.7 22.2-19.3 39.9-41.6 41.6h-384c-26.1 0-54.7-21.7-54.7-41.6v-48c0-20.6 25.6-32.9 50.3-32.9h366.6c12.5 0.7 23.1-8.8 23.9-21.2 0.1-0.9 0.1-1.7 0-2.6v-427.7c0.6-44.2-34.7-80.5-78.9-81.1-3.5 0-7.1 0.1-10.6 0.6h-296.9c-23.9-0.5-47.5 6.5-67.2 20-19.7 13.8-31.3 36.5-30.8 60.6v550.1c8.3 41.4 42.9 72.4 85 76h397.1c47.9 0.6 87.5-37.1 89.5-84.9v-515c-0.7-12.8-10.9-23.1-23.7-23.9h-0.2zM703.772 734.539h-357.9c-13.2 0.5-23.4 11.6-22.9 24.8 0.5 12.4 10.5 22.4 22.9 22.9h357.9c13.2 0.5 24.3-9.7 24.8-22.9s-9.7-24.3-22.9-24.8h-1.9z" fill="currentColor"/><path d="M449.472 290.839h51.9l115 298.6h-48.9l-28-76.9h-128.4l-28 76.9h-48.5l114.9-298.6z m-24.6 184h100.8l-49.3-135.1h-1.7l-49.8 135.1z" fill="currentColor"/></svg>; }

function PlanPanel({ mode }: { mode: StudyMode }) { const modeName = { group: '分组', individual: '独立单词', exam: '真题' }[mode]; return <section className="plan-empty"><CalendarDays size={24}/><strong>{modeName}学习计划已创建</strong><p>已按「{modeName}」方式生成今天的学习序列。</p><button>开始今天的学习</button></section>; }
