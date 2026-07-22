'use client';

import {
  BookOpen, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, Flame, Grid2X2, LayoutList, ListRestart, LogOut, Menu,
  Plus, Settings2, SlidersHorizontal, Sparkles, TimerReset, Trophy,
} from 'lucide-react';
import { useState } from 'react';
import type { Session } from '../lib/api';

type Word = { word: string; part: string; meaning: string; state?: 'review' };

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const name = session.user.displayName || session.user.email.split('@')[0];

  return <main className="study-app">
    <aside className={`study-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <div className="sidebar-book"><div className="book-cover">词</div><div><strong>{name}</strong><span>大学 CET-4 四级词汇</span></div><ChevronDown size={15}/></div>
      <Calendar />
      <nav className="sidebar-nav" aria-label="主导航">
        <span className="nav-label">APP</span>
        <a className="nav-item active" href="#dashboard"><BookOpen size={16}/><span>WordMix</span></a>
        <div className="nav-group"><a className="nav-item" href="#words"><BookOpen size={16}/><span>我的单词</span><ChevronDown size={14}/></a><div className="nav-children"><a href="#learning">学习中</a><a href="#mastered">已掌握</a></div></div>
        <a className="nav-item" href="#settings"><Settings2 size={16}/><span>账户设置</span></a>
      </nav>
      <div className="sidebar-bottom"><button className="switch-book"><Plus size={15}/>切换词汇表</button><button className="feedback"><CircleHelp size={15}/>反馈建议</button></div>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)}/>}

    <section className="study-shell">
      <header className="study-topbar"><button className="menu-trigger" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={19}/></button><span className="topbar-brand"><BookOpen size={15}/> WordMix APP</span><div className="topbar-actions"><button className="upgrade"><Trophy size={14}/>升级会员</button><span className="user-chip">Mini <Sparkles size={13}/> 25</span><button className="exit-button" onClick={onLogout} title="退出登录"><LogOut size={16}/></button></div></header>
      <div className="study-content">
        <h1>学习进度</h1>
        <section className="progress-grid">
          <article className="streak-card"><div><div className="card-heading"><strong>学习连胜</strong><Trophy size={18}/><CheckCircle2 size={18}/></div><p>每天坚持学习，就能持续积累「连胜」<br/>你的「词汇量」和「外语水平」将迎来显著突破！</p></div><div className="streak-count"><b>0</b><Flame size={26}/><button aria-label="签到"><CheckCircle2 size={22}/></button><small>Today</small></div></article>
          <Metric title="词表总词数" value="4545" detail="大学 CET-4 四级词汇" />
          <Metric title="已学习词数" value="2" detail="学习进度 0.0%" />
        </section>

        <div className="learning-tabs"><button className={activeTab === 'words' ? 'active' : ''} onClick={() => setActiveTab('words')}>单词列表</button><button className={activeTab === 'plan' ? 'active' : ''} onClick={() => setActiveTab('plan')}>今天的学习序列</button></div>
        {activeTab === 'words' ? <WordsPanel /> : <PlanPanel />}
      </div>
    </section>
  </main>;
}

function Calendar() {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return <section className="mini-calendar"><div className="calendar-title"><ChevronLeft size={15}/><span>July 2026</span><ChevronRight size={15}/></div><div className="calendar-grid weekdays">{['Su','Mo','Tu','We','Th','Fr','Sa'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: 3 }, (_, i) => <span key={`e${i}`} />)}{days.map(day => <button key={day} className={day === 22 ? 'today' : ''}>{day}</button>)}<span className="muted-day">1</span></div></section>;
}

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <article className="metric-card"><span>{title}</span><b>{value}</b><small>{detail}</small></article>;
}

function WordsPanel() {
  return <section className="words-panel">
    <header className="panel-top"><div className="panel-title"><BookOpen size={18}/><strong>今日学习词汇</strong></div><div className="panel-progress"><span>待复习: 2</span><span>新单词: 15</span><i><b/></i></div><div className="toolbar"><button className="selected"><Grid2X2 size={15}/>分组</button><button><LayoutList size={15}/>独立单词</button><button className="real"><span>◎</span> 真题 <em>NEW</em></button><button className="create"><Sparkles size={15}/>创建学习计划</button><button><SlidersHorizontal size={15}/></button></div></header>
    <div className="word-columns"><WordColumn title="待复习单词" count="2" icon={<TimerReset size={17}/>} words={reviewWords}/><WordColumn title="新单词" count="15" icon={<NewWordsIcon/>} words={newWords} isNew/></div>
  </section>;
}

function WordColumn({ title, count, icon, words, isNew }: { title: string; count: string; icon: React.ReactNode; words: Word[]; isNew?: boolean }) {
  return <div className="word-column"><div className={`word-column-head ${isNew ? 'is-new' : ''}`}><div>{icon}<strong>{title}</strong><span>{count}</span></div>{isNew && <div className="column-buttons"><button><Plus size={22}/>3</button><button aria-label="新单词设置"><Settings2 size={22}/></button></div>}</div><div className="word-list">{words.map((word) => <WordRow key={word.word} word={word}/>)}</div></div>;
}

function NewWordsIcon() { return <svg className="new-words-icon" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 7h16M3 16h23M3 25h16M26 5v10M21 10h10"/></svg>; }

function WordRow({ word }: { word: Word }) {
  return <article className="word-row"><div className="word-copy"><strong>{word.word}</strong><p><span>{word.part}</span>{word.meaning}</p></div><div className="word-actions">{word.state === 'review' && <button className="reviewing"><TimerReset size={14}/>复习中</button>}<button title="加入学习"><ListRestart size={16}/></button><button title="标记掌握"><CheckCircle2 size={16}/></button><button title="稍后再学"><TimerReset size={16}/></button></div></article>;
}

function PlanPanel() { return <section className="plan-empty"><CalendarDays size={24}/><strong>今天的学习序列</strong><p>完成学习计划后，这里会记录你的每一次进步。</p><button>开始今天的学习</button></section>; }
