import { ArrowLeft, ArrowRight, ArrowUpRight, Bot, BookOpen, Brain, CalendarClock, CheckCircle2, CircleAlert, Headphones, Layers3, Link2, MessageSquareText, Network, PenLine, RotateCcw, ScanSearch, Sparkles, Target, WandSparkles } from 'lucide-react';
import Link from 'next/link';

const loop = [
  { number: '01', title: '认识', copy: '在词表里遇见新词，先建立清晰的词义、词性与语境印象。', icon: BookOpen, tone: 'blue' },
  { number: '02', title: '理解', copy: '通过阅读材料和词义辨析，让单词不只停留在单独的一行。', icon: Brain, tone: 'yellow' },
  { number: '03', title: '提取', copy: '用匹配、拼写和听辨等练习，把“看过”变成能想起来。', icon: RotateCcw, tone: 'orange' },
  { number: '04', title: '运用', copy: '在翻译、造句、改写和口语练习中，检验它是否真的属于你。', icon: PenLine, tone: 'paper' },
];

const modes = [
  { title: '分组学习', english: 'GUIDED LOOP', copy: '当天新词按小组推进。每一组结合词汇、阅读和练习，完成后再进入下一组。', tag: '适合稳定刷完词书', icon: Layers3 },
  { title: '自由刷词', english: 'FREE STUDY', copy: '按词表、随机词、错词或高频词自由选择，留给碎片时间和定向查漏补缺。', tag: '适合灵活安排时间', icon: Sparkles },
  { title: '真题模式', english: 'EXAM FOCUS', copy: '从历年真题语境切入，关注熟词僻义、固定搭配与阅读做题能力。', tag: '适合备考专项强化', icon: MessageSquareText },
];

const aiActions = [
  { number: '01', title: '看见信号', copy: '识别薄弱词、易错题型、可用时间与学习节奏。', icon: ScanSearch },
  { number: '02', title: '讲清当下', copy: '针对语法、句子结构和题目思路给出可追问的解析。', icon: MessageSquareText },
  { number: '03', title: '生成下一步', copy: '围绕当前漏洞生成变式练习、阅读语境和输出任务。', icon: WandSparkles },
  { number: '04', title: '重排计划', copy: '根据完成情况动态调整复习优先级、词量和学习路径。', icon: CalendarClock },
  { number: '05', title: '复盘并提醒', copy: '把学习数据转成具体建议：今天该做什么，为什么现在做。', icon: Bot },
];

export default function AboutPage() {
  return <main className="about-page">
    <nav className="about-nav">
      <Link href="/" className="about-brand" aria-label="返回词环首页">词环 <i>LEXLOOP</i></Link>
      <div className="about-nav-actions"><Link href="/" className="about-back"><ArrowLeft size={16}/> 返回首页</Link><Link href="/login" className="about-login">登录 <ArrowUpRight size={15}/></Link></div>
    </nav>

    <section className="about-hero" aria-labelledby="about-title">
      <div className="about-hero-copy">
        <p className="about-kicker">HOW LEXLOOP WORKS</p>
        <h1 id="about-title">不是背完一遍，<br/>而是让单词<em>再回来。</em></h1>
        <p>词环为成人自学者设计：把新词、复习、阅读和练习串成一个能反复回来、逐渐变得熟悉的学习闭环。</p>
        <Link href="/login" className="about-primary">开始建立词环 <ArrowUpRight size={19}/></Link>
      </div>
      <div className="about-hero-note" aria-label="词环学习路径示意">
        <p>一个词，不止一次相见</p>
        <div className="about-orbit">
          <span className="orbit-word word-one">new</span><span className="orbit-word word-two">review</span><span className="orbit-word word-three">use</span>
          <div className="orbit-center"><strong>词环</strong><small>RETURN<br/>REMEMBER</small></div>
        </div>
        <div className="about-note-footer"><span>认识</span><i>→</i><span>理解</span><i>→</i><span>提取</span><i>→</i><span>运用</span></div>
      </div>
    </section>

    <section className="about-section about-loop-section" aria-labelledby="loop-title">
      <header className="about-section-heading"><p>THE LEARNING LOOP</p><h2 id="loop-title">记忆需要一次次被叫回来</h2><span>不是线性课程，而是一条会反复经过你的学习路径。</span></header>
      <div className="about-loop-map" aria-label="认识、理解、提取、运用的循环路径">{loop.map(({ copy, icon: Icon, number, title, tone }) => <article className={`about-loop-stop is-${tone}`} key={title}><span className="about-loop-number">{number}</span><div className="about-loop-icon"><Icon aria-hidden="true" size={23}/></div><div><h3>{title}</h3><p>{copy}</p></div></article>)}<span className="about-loop-return"><i>↺</i><b>回到复习</b><small>让它再出现一次</small></span></div>
    </section>

    <section className="about-section about-modes-section" aria-labelledby="modes-title">
      <header className="about-section-heading"><p>CHOOSE YOUR RHYTHM</p><h2 id="modes-title">按你的节奏，进入学习</h2><span>同一套记忆闭环，可以用不同方式开始。</span></header>
      <div className="about-route-map" aria-label="三种学习路径">
        <div className="about-route-origin"><small>START HERE</small><b>今天</b><span>从一组词开始</span><ArrowRight aria-hidden="true" size={26}/></div>
        <div className="about-routes">{modes.map(({ copy, english, icon: Icon, tag, title }, index) => <article className={`about-route route-${index + 1}`} key={title}><div className="about-route-marker"><Icon aria-hidden="true" size={23}/></div><p>{english}</p><h3>{title}</h3><span>{copy}</span><b>{tag}</b><em>0{index + 1}</em></article>)}</div>
      </div>
    </section>

    <section className="about-practice" aria-labelledby="practice-title">
      <div className="about-practice-copy"><p>FROM RECOGNITION TO USE</p><h2 id="practice-title">看懂，只是开始。<br/>会用，才算留下来。</h2><span>客观练习即时反馈；翻译、造句、改写与口语等输出练习，将逐步接入 AI 按要点评价。</span></div>
      <div className="about-practice-journey" aria-label="从理解到主动输出的练习路径"><div className="about-practice-path" aria-hidden="true"/><div className="about-practice-stop is-context"><span>01</span><BookOpen size={25}/><div><b>理解语境</b><small>阅读材料 · 词义辨析 · 同义替换</small></div></div><div className="about-practice-stop is-check"><span>02</span><CheckCircle2 size={25}/><div><b>即时校验</b><small>单词匹配 · 拼写 · 阅读理解</small></div></div><div className="about-practice-stop is-output"><span>03</span><Headphones size={25}/><div><b>主动输出</b><small>翻译 · 造句 · 改写 · 听说练习</small></div></div><p className="about-practice-result">从“我见过”<br/>到“我会用”</p></div>
    </section>

    <section className="about-section about-ai-section" aria-labelledby="ai-title">
      <header className="about-section-heading"><p>THE INTELLIGENT LAYER · PLANNING</p><h2 id="ai-title">让 AI 和 Agent，<br/>成为会观察的学习伙伴。</h2><span>不是替你完成学习，而是在每一个该出现的时刻，给你恰好需要的一步。</span></header>
      <div className="about-agent-board">
        <div className="about-agent-core"><span><Bot aria-hidden="true" size={28}/></span><div><small>OBSERVE · PLAN · ADAPT</small><strong>学习 Agent 不凭感觉，它沿着学习证据工作。</strong></div></div>
        <div className="about-agent-rays" aria-hidden="true">{aiActions.map((action) => <i key={action.number}/>)}</div>
        {aiActions.map(({ copy, icon: Icon, number, title }) => <article className={`about-agent-action agent-action-${number}`} key={number}><span>{number}</span><Icon aria-hidden="true" size={21}/><div><h3>{title}</h3><p>{copy}</p></div></article>)}
      </div>
      <p className="about-roadmap-note"><i>BUILDING NEXT</i> 以上为产品规划中的智能学习层：先把真实的学习事件和错题数据沉淀好，再让 Agent 基于这些证据做解释、出题、规划和建议。</p>
    </section>

    <section className="about-section about-graph-section" aria-labelledby="graph-title">
      <header className="about-section-heading"><p>KNOWLEDGE MAP · PLANNING</p><h2 id="graph-title">一次答错，不只改正这一题。<br/>它会告诉你真正该补哪里。</h2><span>知识图谱把一个错误放回它所属的关系网：定位根因、找到关联知识，再把它变成下一步练习。</span></header>
      <div className="about-knowledge-map" aria-label="知识图谱如何把 consider 的一个错误转化为学习行动">
        <article className="about-graph-evidence"><span><CircleAlert aria-hidden="true" size={18}/> 学习证据</span><small>今天 · 造句练习</small><p>I <b>consider to move</b> next year.</p><strong>✕ consider to do</strong><em>近 7 天第 3 次出现</em></article>
        <ArrowRight className="about-graph-arrow" aria-hidden="true" size={30}/>
        <div className="about-graph-network">
          <header><Network aria-hidden="true" size={20}/><span>关联知识被点亮</span></header>
          <div className="about-graph-center"><strong>consider</strong><span>v. 仔细考虑</span><small>掌握度 42%</small></div>
          <div className="about-graph-node node-grammar"><em>直接根因 · 语法</em><b>consider doing</b><span>动词后接动名词</span></div>
          <div className="about-graph-node node-example"><em>补充语境 · 例句</em><b>We are considering moving.</b><span>把正确结构放进句子</span></div>
          <div className="about-graph-node node-collocation"><em>扩展关系 · 搭配</em><b>take ... into consideration</b><span>同词根的常用表达</span></div>
        </div>
        <ArrowRight className="about-graph-arrow" aria-hidden="true" size={30}/>
        <article className="about-graph-result"><span><Target aria-hidden="true" size={18}/> 生成行动</span><h3>不是重做原题，<br/>而是补上缺失的关系。</h3><ul><li><CheckCircle2 size={16}/> 1 道结构辨析</li><li><Link2 size={16}/> 2 个新语境</li><li><CalendarClock size={16}/> 24 小时后再提取</li></ul><strong>预计把同类错误<br/>从“反复发生”变成“可定位、可复习”</strong></article>
        <div className="about-graph-caption"><span><i className="graph-dot is-orange"/>你的错误证据</span><span><i className="graph-dot is-blue"/>稳定知识关系</span><b>证据 → 关系 → 行动</b></div>
      </div>
      <div className="about-graph-impact" aria-label="知识图谱带来的学习效果"><div><small>01 · 找到根因</small><b>知道为什么错</b><span>从“记不住”缩小到具体语法关系。</span></div><ArrowRight aria-hidden="true"/><div><small>02 · 关联补齐</small><b>一次补一组知识</b><span>词义、结构、搭配和语境不再分散。</span></div><ArrowRight aria-hidden="true"/><div><small>03 · 形成行动</small><b>知道下一步做什么</b><span>复习顺序由真实薄弱点决定。</span></div></div>
    </section>

    <section className="about-dashboard" aria-labelledby="dashboard-title">
      <div className="about-dashboard-preview" aria-hidden="true"><div className="preview-top"><i/><i/><i/><span>MY LEARNING NOTES</span></div><div className="preview-metrics"><b>4<small>天连续学习</small></b><b>28<small>已学习词数</small></b><b>138<small>本周分钟</small></b></div><div className="preview-bars">{[43, 62, 26, 78, 45, 89, 58].map((height, index) => <i key={index} style={{ height: `${height}%` }}/>)}</div><p>学习不是一次完成，而是留下可回看的足迹。</p></div>
      <div className="about-dashboard-copy"><p>YOUR LEARNING NOTES</p><h2 id="dashboard-title">每一次回来，<br/>都留下一点证据。</h2><span>登录后，词环会在学习看板里汇总待复习、新词与计划；学习统计页则回看学习天数、投入时间、词汇足迹和需要再见一面的单词。</span><strong>当前产品包含可交互的学习流程原型，部分词表、统计和练习数据为演示数据。</strong></div>
    </section>

    <section className="about-cta"><p>ONE WORD AT A TIME</p><h2>从今天的一个单词开始。</h2><Link href="/login">去登录，建立我的词环 <ArrowUpRight size={19}/></Link></section>
    <footer className="about-footer"><span>Lexloop · 词环</span><span>Learn · Return · Remember</span></footer>
  </main>;
}
