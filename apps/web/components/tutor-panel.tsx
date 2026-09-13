'use client';

import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, Send, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { request, streamSse, type Session, userFacingError } from '../lib/api';

export type TutorContext =
  | { type: 'STUDY_GROUP'; planId: string; groupIndex: number }
  | { type: 'MISTAKE'; weaknessId: string };
type TutorMessage = { id: string; role: 'user' | 'assistant'; status: 'pending' | 'completed' | 'failed'; content: string; createdAt: string };
type HistoryResponse = { messages: TutorMessage[]; remaining: number; limit: number; hasMore: boolean };

export function TutorPanel({ session, context, compact = false, onOpenSettings }: { session: Session; context: TutorContext; compact?: boolean; onOpenSettings?: () => void }) {
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [text, setText] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'error' | 'success'>('error');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const query = useMemo(() => contextQuery(context), [context]);
  const showError = (text: string) => { setMessageType('error'); setMessage(text); };

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setMessage('');
    setLastPrompt('');
    setRemaining(null);
    setHistoryLoading(true);
    request<HistoryResponse>(`/ai/tutor/history?${query}`, {}, session.accessToken)
      .then(result => { if (!cancelled) { setMessages(result.messages); setRemaining(result.remaining); setLimit(result.limit); setPage(1); setHasMore(result.hasMore); } })
      .catch(error => { if (!cancelled) showError(userFacingError(error, '助手历史暂时无法加载，请稍后重试。')); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [historyVersion, query, session.accessToken]);

  useEffect(() => {
    if (!followLatestRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages]);

  const send = async (event?: FormEvent, preset?: string) => {
    event?.preventDefault();
    const content = (preset ?? text).trim();
    if (!content || busy || remaining === 0) return;
    setBusy(true);
    setMessage('');
    setText('');
    setLastPrompt(content);
    followLatestRef.current = true;
    const userId = `local-user-${Date.now()}`;
    const assistantId = `local-assistant-${Date.now()}`;
    setMessages(current => [...current, { id: userId, role: 'user', status: 'completed', content, createdAt: new Date().toISOString() }, { id: assistantId, role: 'assistant', status: 'pending', content: '', createdAt: new Date().toISOString() }]);
    try {
      await streamSse('/ai/tutor/messages', { method: 'POST', body: JSON.stringify({ ...context, message: content }) }, session.accessToken, (name, value) => {
        const payload = value as { content?: string; remaining?: number; message?: string };
        if (name === 'delta' && payload.content) {
          setMessages(current => current.map(item => item.id === assistantId ? { ...item, content: item.content + payload.content } : item));
          window.requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
        }
        if (name === 'done') { setMessages(current => current.map(item => item.id === assistantId ? { ...item, status: 'completed' } : item)); if (typeof payload.remaining === 'number') setRemaining(payload.remaining); }
        if (name === 'error') {
          const text = payload.message ?? '助手暂时无法回答，请稍后重试。';
          setMessages(current => current.map(item => item.id === assistantId ? { ...item, status: 'failed', content: item.content || text } : item));
          showError(text);
        }
      });
    } catch (error) {
      const text = userFacingError(error, '助手暂时无法回答，请稍后重试。');
      setMessages(current => current.map(item => item.id === assistantId ? { ...item, status: 'failed', content: item.content || text } : item));
      showError(text);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    setClearLoading(true);
    try {
      await request(`/ai/tutor/history?${query}`, { method: 'DELETE' }, session.accessToken);
      setMessages([]);
      setHasMore(false);
      setLastPrompt('');
      setMessageType('success');
      setMessage('会话已清空，可以重新开始。');
    } catch (error) {
      showError(userFacingError(error, '会话暂时无法清空，请稍后重试。'));
    } finally {
      setClearLoading(false);
    }
  };

  const loadOlder = async () => {
    if (olderLoading) return;
    const nextPage = page + 1;
    setOlderLoading(true);
    followLatestRef.current = false;
    try {
      const result = await request<HistoryResponse>(`/ai/tutor/history?${query}&page=${nextPage}&pageSize=50`, {}, session.accessToken);
      setMessages(current => [...result.messages, ...current]);
      setPage(nextPage);
      setHasMore(result.hasMore);
    } catch (error) {
      showError(userFacingError(error, '更早的对话暂时无法加载，请稍后重试。'));
    } finally {
      setOlderLoading(false);
    }
  };

  const quickActions = context.type === 'MISTAKE' ? ['为什么会错？', '给我一个新例句', '怎么记住这个用法？'] : ['给我一点提示', '解释这个词', '给个新例句'];
  return <section className={`tutor-panel ${compact ? 'is-compact' : ''}`} aria-label="词环学习助手">
    <header className="tutor-header"><div className="tutor-title"><span className="tutor-mark"><Sparkles size={19}/></span><div><strong>词环学习助手</strong><small>{context.type === 'MISTAKE' ? '错题追问' : '本组辅导'}</small></div></div>{messages.length > 0 && <button onClick={() => void clear()} disabled={busy || clearLoading} aria-label="清空助手会话"><Trash2 size={16}/></button>}</header>
    <div className="tutor-context"><span className="tutor-context-dot" />{context.type === 'STUDY_GROUP' ? '先给线索，再一起拆解；交卷后可完整分析答案。' : '围绕这道错题，找到卡住的词义、搭配或解题线索。'}</div>
    <div className="tutor-quick-actions" aria-label="快捷提问">{quickActions.map(action => <button key={action} disabled={busy || remaining === 0 || historyLoading} onClick={() => void send(undefined, action)}>{action}</button>)}</div>
    <div className="tutor-messages" aria-live="polite">
      {hasMore && <button className="tutor-load-older" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? '正在读取更早对话…' : '加载更早对话'}</button>}
      {historyLoading ? <div className="tutor-loading" aria-label="正在加载对话"><i/><i/><i/></div> : !messages.length && <div className="tutor-empty"><Sparkles size={25}/><strong>从一个小问题开始</strong><span>可以问词义、例句、记忆方法，或让助手解释这道题。</span></div>}
      {messages.map((item, index) => {
        const previous = messages[index - 1];
        const retryPrompt = item.status === 'failed' && previous?.role === 'user' ? previous.content : lastPrompt;
        return <article key={item.id} className={`tutor-message is-${item.role} is-${item.status}`}><div className="tutor-message-meta"><b>{item.role === 'user' ? '你' : '助手'}</b><time><Clock3 size={12}/>{formatTime(item.createdAt)}</time></div><div className="tutor-message-body">{item.content ? messageBlocks(item.content) : <span className="tutor-thinking"><i/>正在整理思路…</span>}</div>{item.status === 'failed' && <div className="tutor-failed"><small>这次回答没有完成，你可以保留问题再试一次。</small>{retryPrompt && <button onClick={() => void send(undefined, retryPrompt)} disabled={busy}><RefreshCw size={13}/>重试</button>}</div>}</article>;
      })}
      <div ref={messagesEndRef} />
    </div>
    {message && <div className={`tutor-error is-${messageType}`} role={messageType === 'error' ? 'alert' : 'status'}>{messageType === 'error' ? <AlertTriangle size={19}/> : <CheckCircle2 size={19}/>}<div><strong>{messageType === 'error' ? '助手暂时没能回答' : '操作完成'}</strong><p>{message}</p>{messageType === 'error' && <div className="tutor-error-actions">{lastPrompt && <button onClick={() => void send(undefined, lastPrompt)} disabled={busy}><RefreshCw size={14}/>重试</button>}{onOpenSettings && <button onClick={onOpenSettings}><Settings2 size={14}/>打开模型设置</button>}{!lastPrompt && <button onClick={() => setHistoryVersion(value => value + 1)}><RefreshCw size={14}/>重新加载</button>}</div>}</div></div>}
    <form className="tutor-composer" onSubmit={event => void send(event)}><textarea value={text} onChange={event => setText(event.target.value)} maxLength={1000} placeholder="问问这个单词、题目，或让助手换一种讲法…" disabled={busy || remaining === 0 || historyLoading}/><div className="tutor-compose-side"><span>{text.length}/1000</span><button disabled={!text.trim() || busy || remaining === 0 || historyLoading} aria-label="发送问题"><Send size={18}/></button></div></form>
    <footer className="tutor-footer"><small>今日剩余 <b>{remaining ?? '—'}</b> / {limit} 次</small><span>每个学习分组独立保存对话</span></footer>
  </section>;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function messageBlocks(content: string) {
  return content.split(/\n{2,}/).map((block, index) => <p key={index}>{block}</p>);
}

function contextQuery(context: TutorContext) {
  const query = new URLSearchParams({ type: context.type });
  if (context.type === 'STUDY_GROUP') { query.set('planId', context.planId); query.set('groupIndex', String(context.groupIndex)); }
  else query.set('weaknessId', context.weaknessId);
  return query.toString();
}
