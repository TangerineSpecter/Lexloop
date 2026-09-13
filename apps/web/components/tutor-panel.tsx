'use client';

import { Send, Sparkles, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { request, streamSse, type Session } from '../lib/api';

export type TutorContext =
  | { type: 'STUDY_GROUP'; planId: string; groupIndex: number }
  | { type: 'MISTAKE'; weaknessId: string };
type TutorMessage = { id: string; role: 'user' | 'assistant'; status: 'pending' | 'completed' | 'failed'; content: string; createdAt: string };
type HistoryResponse = { messages: TutorMessage[]; remaining: number; limit: number; hasMore: boolean };

export function TutorPanel({ session, context, compact = false }: { session: Session; context: TutorContext; compact?: boolean }) {
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [text, setText] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const query = useMemo(() => contextQuery(context), [context]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setMessage('');
    request<HistoryResponse>(`/ai/tutor/history?${query}`, {}, session.accessToken)
      .then(result => { if (!cancelled) { setMessages(result.messages); setRemaining(result.remaining); setLimit(result.limit); setPage(1); setHasMore(result.hasMore); } })
      .catch(error => { if (!cancelled) setMessage(error instanceof Error ? error.message : '助手历史加载失败'); });
    return () => { cancelled = true; };
  }, [query, session.accessToken]);

  const send = async (event?: FormEvent, preset?: string) => {
    event?.preventDefault();
    const content = (preset ?? text).trim();
    if (!content || busy || remaining === 0) return;
    setBusy(true);
    setMessage('');
    setText('');
    const userId = `local-user-${Date.now()}`;
    const assistantId = `local-assistant-${Date.now()}`;
    setMessages(current => [...current, { id: userId, role: 'user', status: 'completed', content, createdAt: new Date().toISOString() }, { id: assistantId, role: 'assistant', status: 'pending', content: '', createdAt: new Date().toISOString() }]);
    try {
      await streamSse('/ai/tutor/messages', { method: 'POST', body: JSON.stringify({ ...context, message: content }) }, session.accessToken, (name, value) => {
        const payload = value as { content?: string; remaining?: number; message?: string };
        if (name === 'delta' && payload.content) setMessages(current => current.map(item => item.id === assistantId ? { ...item, content: item.content + payload.content } : item));
        if (name === 'done') { setMessages(current => current.map(item => item.id === assistantId ? { ...item, status: 'completed' } : item)); if (typeof payload.remaining === 'number') setRemaining(payload.remaining); }
        if (name === 'error') { setMessages(current => current.map(item => item.id === assistantId ? { ...item, status: 'failed', content: item.content || payload.message || '回答失败，请重试' } : item)); setMessage(payload.message ?? '回答失败，请重试'); }
      });
    } catch (error) {
      setMessages(current => current.filter(item => item.id !== userId && item.id !== assistantId));
      setMessage(error instanceof Error ? error.message : 'AI 助手暂时不可用');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    await request(`/ai/tutor/history?${query}`, { method: 'DELETE' }, session.accessToken);
    setMessages([]);
    setHasMore(false);
    setMessage('');
  };

  const loadOlder = async () => {
    const nextPage = page + 1;
    const result = await request<HistoryResponse>(`/ai/tutor/history?${query}&page=${nextPage}&pageSize=50`, {}, session.accessToken);
    setMessages(current => [...result.messages, ...current]);
    setPage(nextPage);
    setHasMore(result.hasMore);
  };

  const quickActions = context.type === 'MISTAKE' ? ['为什么会错？', '给我一个新例句', '怎么记住这个用法？'] : ['给我一点提示', '解释这个词', '给个新例句'];
  return <section className={`tutor-panel ${compact ? 'is-compact' : ''}`} aria-label="词环学习助手">
    <header><span><Sparkles size={19}/><strong>词环学习助手</strong></span>{messages.length > 0 && <button onClick={() => void clear()} aria-label="清空助手会话"><Trash2 size={15}/></button>}</header>
    <p className="tutor-intro">{context.type === 'STUDY_GROUP' ? '我会先给提示；交卷后可以一起分析答案。' : '结合这道错题，找出真正卡住的地方。'}</p>
    <div className="tutor-quick-actions">{quickActions.map(action => <button key={action} disabled={busy || remaining === 0} onClick={() => void send(undefined, action)}>{action}</button>)}</div>
    <div className="tutor-messages" aria-live="polite">
      {hasMore && <button className="tutor-load-older" onClick={() => void loadOlder()}>加载更早对话</button>}
      {!messages.length && <p className="tutor-empty">选择一个问题开始吧。</p>}
      {messages.map(item => <article key={item.id} className={`is-${item.role} is-${item.status}`}><b>{item.role === 'user' ? '你' : '助手'}</b><p>{item.content || '正在思考…'}</p>{item.status === 'failed' && <small>本次回答未完成，可以重新提问。</small>}</article>)}
    </div>
    {message && <p className="tutor-error" role="status">{message}</p>}
    <form onSubmit={event => void send(event)}><textarea value={text} onChange={event => setText(event.target.value)} maxLength={1000} placeholder="问问这个单词或题目…" disabled={busy || remaining === 0}/><button disabled={!text.trim() || busy || remaining === 0} aria-label="发送问题"><Send size={17}/></button></form>
    <small className="tutor-quota">今日剩余 {remaining ?? '—'} / {limit} 次</small>
  </section>;
}

function contextQuery(context: TutorContext) {
  const query = new URLSearchParams({ type: context.type });
  if (context.type === 'STUDY_GROUP') { query.set('planId', context.planId); query.set('groupIndex', String(context.groupIndex)); }
  else query.set('weaknessId', context.weaknessId);
  return query.toString();
}
