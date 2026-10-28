'use client';

import { ArrowLeft, Check, ChevronLeft, ChevronRight, CircleAlert, RotateCcw, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { request, type Session } from '../lib/api';
import { partitionMistakePracticeSelection } from '../lib/mistake-practice-selection';
import type { LearningPlan } from './dashboard';
import { TutorPanel } from './tutor-panel';

type MistakeStatus = 'active' | 'ignored' | 'resolved';
type Weakness = { id: string; questionType: string; status: MistakeStatus; wrongCount: number; consecutiveCorrect: number; lastWrongAt: string };
type MeaningLine = { part: string; text: string };
type MistakeWord = { bookWordId: string; word: string; part: string; meaning: string; meanings?: MeaningLine[]; bookTitle: string; severity: number; lastWrongAt: string; weaknesses: Weakness[] };
type ListResponse = { items: MistakeWord[]; page: number; total: number; hasMore: boolean };
type Question = { type?: string; prompt?: string; options?: string[]; correctAnswers?: string[]; explanation?: string; pairs?: Array<{ left?: string; right?: string }> };
type MistakeDetail = Weakness & { bookWordId: string; word: string; part: string; meaning: string; meanings?: MeaningLine[]; bookTitle: string; attempts: Array<{ id: string; isCorrect: boolean; selectedAnswer: unknown; createdAt: string; question: Question | null }> };
function meaningLabel(item: { part: string; meaning: string; meanings?: MeaningLine[] }) {
  if ((item.meanings?.length ?? 0) > 1) return item.meanings!.map((line) => (line.part ? `${line.part} ${line.text}` : line.text)).join('；');
  return `${item.part} ${item.meaning}`.trim();
}

const labels: Record<string, string> = { WORD_MNEMONIC: '单词助记', MEANING_RECOGNITION: '词义识别', WORD_MATCHING: '单词匹配', SYNONYM_REPLACEMENT: '同义替换', READING_COMPREHENSION: '阅读理解', OUTPUT: '每日输出', CONFUSION: '易混词辨析' };

export function MistakesPage({ session, onBack, onOpenTutorSettings, onPlanCreated }: { session: Session; onBack: () => void; onOpenTutorSettings?: () => void; onPlanCreated: (plan: LearningPlan) => void }) {
  const [status, setStatus] = useState<MistakeStatus>('active');
  const [questionType, setQuestionType] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<MistakeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [showPracticeChoices, setShowPracticeChoices] = useState(false);

  const load = useCallback(async (resetSelection = false) => {
    setLoading(true); setMessage('');
    try {
      const query = new URLSearchParams({ status, page: String(page), pageSize: '20' });
      if (questionType) query.set('questionType', questionType);
      const response = await request<ListResponse>(`/mistakes?${query}`, {}, session.accessToken);
      setResult(response);
      if (status === 'active' && (resetSelection || !selected.length)) setSelected(response.items.slice(0, 10).map(item => item.bookWordId));
      if (status !== 'active') setSelected([]);
    } catch (error) { setMessage(error instanceof Error ? error.message : '错题本加载失败'); }
    finally { setLoading(false); }
  }, [page, questionType, session.accessToken, status]);

  useEffect(() => { void load(true); }, [load]);

  useEffect(() => {
    if (!detail) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setDetail(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [detail]);

  const openDetail = async (id: string) => {
    try { setDetail(await request<MistakeDetail>(`/mistakes/${id}`, {}, session.accessToken)); }
    catch (error) { setMessage(error instanceof Error ? error.message : '错题详情加载失败'); }
  };
  const changeStatus = async (weakness: Weakness, next: 'ACTIVE' | 'IGNORED') => {
    setMessage('');
    try {
      await request(`/mistakes/${weakness.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: next }) }, session.accessToken);
      setDetail(null);
      await load(true);
    } catch (error) {
      setDetail(null);
      setMessage(error instanceof Error ? error.message : '更新薄弱项状态失败');
    }
  };
  const selectedPractice = partitionMistakePracticeSelection(result?.items ?? [], selected);
  const hasSpecialPractice =
    selectedPractice.outputWordIds.length > 0 || selectedPractice.confusionWordIds.length > 0;
  const createPlanFor = async (bookWordIds: string[]) => {
    if (!bookWordIds.length) return;
    setLoading(true);
    setMessage('');
    try {
      const plan = await request<LearningPlan>(
        '/mistakes/practice-plans',
        { method: 'POST', body: JSON.stringify({ bookWordIds }) },
        session.accessToken,
      );
      onPlanCreated(plan);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建薄弱词专项失败');
    } finally {
      setLoading(false);
    }
  };
  const createPlan = async () => {
    if (!selected.length) return;
    if (hasSpecialPractice) {
      setShowPracticeChoices(true);
      return;
    }
    await createPlanFor(selectedPractice.standardWordIds);
  };

  return <section className="mistakes-page" aria-labelledby="mistakes-title">
    <header className="mistakes-heading"><div><p>REVIEW LOOP</p><h1 id="mistakes-title">待巩固</h1><span>把每次错误变成下一次真正掌握的线索。</span></div><button onClick={onBack}><ArrowLeft size={17}/>返回学习进度</button></header>
    <div className="mistakes-toolbar">
      <div role="tablist" aria-label="错题状态">{(['active', 'ignored', 'resolved'] as const).map(value => <button role="tab" aria-selected={status === value} className={status === value ? 'active' : ''} key={value} onClick={() => { setStatus(value); setPage(1); }}>{value === 'active' ? '待巩固' : value === 'ignored' ? '已忽略' : '已纠正'}</button>)}</div>
      <select value={questionType} onChange={event => { setQuestionType(event.target.value); setPage(1); }} aria-label="按题型筛选"><option value="">全部题型</option>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      {status === 'active' && <button className="mistakes-create" disabled={!selected.length || loading} onClick={() => void createPlan()}><Sparkles size={17}/>生成专项（{selected.length}）</button>}
    </div>
    {message && <p className="book-message" role="status">{message}</p>}
    {showPracticeChoices && hasSpecialPractice && (
      <section className="mistakes-practice-choices" aria-label="按题型选择专项">
        <h2>这批薄弱项需要分开练</h2>
        <p>
          当前选择包含：每日输出 {selectedPractice.outputWordIds.length} 词；易混辨析{' '}
          {selectedPractice.confusionWordIds.length} 词；普通题型{' '}
          {selectedPractice.standardWordIds.length} 词。普通专项只会收到普通题型词。
        </p>
        <p>
          每日输出和易混词训练使用各自的目标与推荐规则，不会把本页所选词自动设为练习目标。
        </p>
        <div>
          {selectedPractice.standardWordIds.length > 0 && (
            <button
              className="is-primary"
              disabled={loading}
              onClick={() => void createPlanFor(selectedPractice.standardWordIds)}
            >
              只生成普通专项（{selectedPractice.standardWordIds.length} 词）
            </button>
          )}
          {selectedPractice.outputWordIds.length > 0 && (
            <button
              disabled={loading}
              onClick={() => window.location.assign('/dashboard/practice?tab=output')}
            >
              打开每日输出
            </button>
          )}
          {selectedPractice.confusionWordIds.length > 0 && (
            <button
              disabled={loading}
              onClick={() => window.location.assign('/dashboard/practice?tab=confusion')}
            >
              打开易混词训练
            </button>
          )}
          <button disabled={loading} onClick={() => setShowPracticeChoices(false)}>
            返回调整选择
          </button>
        </div>
      </section>
    )}
    {loading && !result ? <div className="mistakes-empty">正在读取薄弱词…</div> : !result?.items.length ? <div className="mistakes-empty"><Check size={34}/><strong>{status === 'active' ? '当前没有待巩固的单词' : '这里还没有记录'}</strong><p>完成练习后，错题会自动汇总到这里。</p></div> : <div className="mistakes-list">{result.items.map(item => {
      const checked = selected.includes(item.bookWordId);
      return <article key={item.bookWordId} className={checked ? 'is-selected' : ''}>
        {status === 'active' && <button className="mistake-check" aria-label={`${checked ? '取消选择' : '选择'} ${item.word}`} onClick={() => setSelected(current => checked ? current.filter(id => id !== item.bookWordId) : current.length < 20 ? [...current, item.bookWordId] : current)}><i>{checked && <Check size={14}/>}</i></button>}
        <div className="mistake-word"><strong>{item.word}</strong><span>{meaningLabel(item)}</span><small>{item.bookTitle}</small></div>
        <div className="mistake-score"><b>{item.severity}</b><span>薄弱指数</span></div>
        <div className="mistake-signals">{item.weaknesses.map(weakness => <button key={weakness.id} onClick={() => void openDetail(weakness.id)}><CircleAlert size={15}/><strong>{labels[weakness.questionType] ?? weakness.questionType}</strong><span>错 {weakness.wrongCount} 次 · 连对 {weakness.consecutiveCorrect}/2</span></button>)}</div>
      </article>;
    })}</div>}
    {result && result.total > 20 && <div className="mistakes-pagination"><button disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16}/>上一页</button><span>第 {page} 页</span><button disabled={!result.hasMore} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16}/></button></div>}
    {detail && <div className="mistake-detail-layer" role="dialog" aria-modal="true" aria-label={`${detail.word} 错题详情`}><button className="mistake-detail-scrim" onClick={() => setDetail(null)} aria-label="关闭错题详情"/><section className="mistake-detail"><header><div><p>{labels[detail.questionType] ?? detail.questionType}</p><h2>{detail.word}</h2><span>答对两次即可纠正 · 当前 {detail.consecutiveCorrect}/2</span></div><button onClick={() => setDetail(null)} aria-label="关闭"><X size={20}/></button></header><div className="mistake-detail-grid"><main><p className="mistake-meaning">{(detail.meanings?.length ?? 0) > 1 ? meaningLabel(detail) : <><b>{detail.part}</b>{detail.meaning}</>}</p>{detail.attempts.map(attempt => <article className={`mistake-attempt ${attempt.isCorrect ? 'is-correct' : 'is-wrong'}`} key={attempt.id}><header><strong>{attempt.isCorrect ? '回答正确' : '回答错误'}</strong><time>{new Date(attempt.createdAt).toLocaleString('zh-CN')}</time></header><p>{attempt.question?.prompt ?? '题目内容不可用'}</p>{attempt.question?.options?.length ? <ul>{attempt.question.options.map(option => <li key={option} className={attempt.question?.correctAnswers?.includes(option) ? 'is-answer' : ''}>{option}</li>)}</ul> : null}<div className={`mistake-answer-review ${attempt.isCorrect ? 'is-correct' : 'is-wrong'}`}><div className="mistake-answer-review-head"><span>答案对照</span><b>{attempt.isCorrect ? <><Check size={13}/>本题已答对</> : <><CircleAlert size={13}/>再看一遍</>}</b></div><div className="mistake-answer-grid"><div className="mistake-answer-item is-user"><span>你的答案</span><strong>{answerText(attempt.selectedAnswer)}</strong></div><div className="mistake-answer-item is-correct"><span>正确答案</span><strong>{attempt.question?.correctAnswers?.join('、') || matchingAnswer(attempt.question)}</strong></div></div></div><p className="mistake-explanation">{attempt.question?.explanation || '暂无解析'}</p></article>)}{detail.status !== 'resolved' && <button className="mistake-status-button" onClick={() => void changeStatus(detail, detail.status === 'ignored' ? 'ACTIVE' : 'IGNORED')}>{detail.status === 'ignored' ? <><RotateCcw size={16}/>恢复待巩固</> : <>暂时忽略</>}</button>}</main><aside><TutorPanel session={session} context={{ type: 'MISTAKE', weaknessId: detail.id }} compact onOpenSettings={onOpenTutorSettings}/></aside></div></section></div>}
  </section>;
}

function answerText(value: unknown) { return Array.isArray(value) ? value.join('、') : String(value ?? '未记录'); }
function matchingAnswer(question: Question | null) { return question?.pairs?.map(pair => `${pair.left} → ${pair.right}`).join('；') || '未记录'; }
