'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArchiveRestore, Search, ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';
import { request, type Session, userFacingError } from '../lib/api';
import styles from './study-content-bank-panel.module.css';

type BankQuestion = {
  bookWordId?: string;
  type?: string;
  prompt?: string;
  options?: string[];
  correctAnswers?: string[];
  explanation?: string;
  feedback: { up: number; down: number; reasonCounts: Record<string, number> };
};
type BankMaterial = {
  title?: string;
  wordOccurrences?: Record<string, number>;
  sentences?: Array<{ english?: string; chinese?: string; simplified?: string }>;
};
type BankItem = {
  id: string;
  mode: 'GROUP' | 'INDIVIDUAL' | 'EXAM';
  material: BankMaterial;
  reuseHits: number;
  planReferences: number;
  feedbackSummary?: { up: number; down: number };
  isActive: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  provenance: string;
  questions: BankQuestion[];
};
type BankResponse = {
  page: number;
  pageSize: number;
  total: number;
  quarantinedCount: number;
  items: BankItem[];
};
type Filters = {
  search: string;
  status: 'active' | 'disabled' | 'all';
  mode: '' | 'GROUP' | 'INDIVIDUAL' | 'EXAM';
  from: string;
  to: string;
  feedback: 'all' | 'negative';
};

const EMPTY_FILTERS: Filters = {
  search: '',
  status: 'active',
  mode: '',
  from: '',
  to: '',
  feedback: 'all',
};
const MODE_LABELS = { GROUP: '分组阅读', INDIVIDUAL: '单词练习', EXAM: '测评题型' };
const REASON_LABELS: Record<string, string> = {
  ANSWER_INCORRECT: '答案错误',
  QUESTION_UNCLEAR: '题意不清',
  OPTIONS_INCORRECT: '选项有误',
  EXPLANATION_UNCLEAR: '解析不清',
  OTHER: '其他',
};
const QUESTION_LABELS: Record<string, string> = {
  WORD_MNEMONIC: '主动回想',
  MEANING_RECOGNITION: '词义辨认',
  WORD_MATCHING: '词义配对',
  SYNONYM_REPLACEMENT: '语境替换',
  READING_COMPREHENSION: '阅读理解',
};

function dateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function StudyContentBankPanel({ session }: { session: Session }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BankResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [disableReasons, setDisableReasons] = useState<Record<string, string>>({});
  const [statusMessage, setStatusMessage] = useState('');
  const [requestNumber, setRequestNumber] = useState(0);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    const query = new URLSearchParams({
      page: String(page),
      pageSize: '20',
      status: filters.status,
    });
    if (filters.search.trim()) query.set('search', filters.search.trim());
    if (filters.mode) query.set('mode', filters.mode);
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    if (filters.feedback === 'negative') query.set('feedback', filters.feedback);
    setLoading(true);
    setError('');
    try {
      const result = await request<BankResponse>(
        `/admin/study-content-bank?${query.toString()}`,
        {},
        session.accessToken,
      );
      if (requestSequence.current === requestId) setData(result);
    } catch (cause) {
      if (requestSequence.current === requestId) {
        setError(userFacingError(cause, '公共题库暂时无法加载。'));
      }
    } finally {
      if (requestSequence.current === requestId) setLoading(false);
    }
  }, [filters, page, requestNumber, session.accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setFilters({ ...draft, search: draft.search.trim() });
  };

  const toggleActive = async (item: BankItem) => {
    setBusyId(item.id);
    setStatusMessage('');
    try {
      await request(
        `/admin/study-content-bank/${encodeURIComponent(item.id)}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            isActive: !item.isActive,
            reason: disableReasons[item.id]?.trim() || undefined,
          }),
        },
        session.accessToken,
      );
      setStatusMessage(
        item.isActive ? '材料已停用，已有计划快照不受影响。' : '材料已恢复，可供后续计划匹配。',
      );
      setRequestNumber((value) => value + 1);
    } catch (cause) {
      setStatusMessage(userFacingError(cause, '状态更新失败，请重试。'));
    } finally {
      setBusyId(null);
    }
  };

  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 20)));
  return (
    <section className={styles.panel} aria-labelledby="study-content-bank-title">
      <header className={styles.heading}>
        <div className={styles.titleRow}>
          <ShieldCheck size={22} aria-hidden="true" />
          <h2 id="study-content-bank-title">公共题库</h2>
        </div>
        <p>仅展示来源可确认的系统词书材料。停用只影响后续复用，不改已有学习计划和作答记录。</p>
      </header>

      {data?.quarantinedCount ? (
        <p className={styles.quarantine} role="status">
          另有 {data.quarantinedCount}{' '}
          条旧材料因来源无法确认已隔离停用；这些内容不会被复用或在此展示。
        </p>
      ) : null}

      <form className={styles.filters} onSubmit={applyFilters}>
        <label className={styles.search}>
          <span>搜索词、题干或材料</span>
          <div>
            <Search size={17} aria-hidden="true" />
            <input
              value={draft.search}
              onChange={(event) => setDraft({ ...draft, search: event.target.value })}
            />
          </div>
        </label>
        <label>
          <span>状态</span>
          <select
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as Filters['status'] })
            }
          >
            <option value="active">可复用</option>
            <option value="disabled">已停用</option>
            <option value="all">全部</option>
          </select>
        </label>
        <label>
          <span>练习模式</span>
          <select
            value={draft.mode}
            onChange={(event) =>
              setDraft({ ...draft, mode: event.target.value as Filters['mode'] })
            }
          >
            <option value="">全部模式</option>
            <option value="GROUP">分组阅读</option>
            <option value="INDIVIDUAL">单词练习</option>
            <option value="EXAM">测评题型</option>
          </select>
        </label>
        <label>
          <span>题目评价</span>
          <select
            value={draft.feedback}
            onChange={(event) =>
              setDraft({ ...draft, feedback: event.target.value as Filters['feedback'] })
            }
          >
            <option value="all">全部评价</option>
            <option value="negative">有负面评价（含历史版本）</option>
          </select>
        </label>
        <label>
          <span>生成日期起</span>
          <input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label>
          <span>生成日期止</span>
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <button type="submit" className={styles.apply} disabled={loading}>
          筛选
        </button>
      </form>

      {statusMessage && (
        <p className={styles.status} role="status">
          {statusMessage}
        </p>
      )}
      {loading ? (
        <div className={styles.state} role="status">
          正在读取公共题库…
        </div>
      ) : error ? (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setRequestNumber((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : !data?.items.length ? (
        <div className={styles.state}>当前筛选范围内没有公共材料。</div>
      ) : (
        <div className={styles.list}>
          {data.items.map((item) => (
            <article className={styles.card} key={item.id}>
              <header className={styles.cardHeader}>
                <div>
                  <span className={item.isActive ? styles.activeBadge : styles.disabledBadge}>
                    {item.isActive ? '可复用' : '已停用'}
                  </span>
                  <span className={styles.mode}>{MODE_LABELS[item.mode]}</span>
                  <h3>{item.material.title || '未命名材料'}</h3>
                </div>
                <div className={styles.metrics}>
                  <span>
                    复用命中 <strong>{item.reuseHits}</strong>
                  </span>
                  <span>
                    计划引用 <strong>{item.planReferences}</strong>
                  </span>
                  <span>
                    材料累计赞踩{' '}
                    <strong
                      aria-label={`赞 ${item.feedbackSummary?.up ?? 0}，踩 ${item.feedbackSummary?.down ?? 0}`}
                    >
                      {item.feedbackSummary?.up ?? 0} 赞 · {item.feedbackSummary?.down ?? 0} 踩
                    </strong>
                  </span>
                </div>
              </header>
              <p className={styles.meta}>
                {item.provenance} · 创建于 {dateTime(item.createdAt)}
              </p>
              {item.material.wordOccurrences && (
                <p className={styles.wordTags}>
                  目标词：{Object.keys(item.material.wordOccurrences).join('、') || '未记录'}
                </p>
              )}
              {item.disabledReason && (
                <p className={styles.disabledReason}>停用说明：{item.disabledReason}</p>
              )}
              <details className={styles.material}>
                <summary>
                  查看{item.material.sentences?.length ? '完整材料与' : ''}题目（
                  {item.questions.length} 题）
                </summary>
                {item.material.sentences?.length ? (
                  <div className={styles.sentences}>
                    {item.material.sentences.map((sentence, index) => (
                      <div key={`${sentence.english ?? 'sentence'}-${index}`}>
                        {sentence.english && <p>{sentence.english}</p>}
                        {sentence.chinese && <small>{sentence.chinese}</small>}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className={styles.questions}>
                  {item.questions.map((question, index) => (
                    <section key={`${question.bookWordId ?? 'q'}-${index}`}>
                      <h4>
                        {QUESTION_LABELS[question.type ?? ''] ?? '练习题'}
                        {question.prompt ? ` · ${question.prompt}` : ''}
                      </h4>
                      {question.options?.length ? (
                        <p>选项：{question.options.join(' / ')}</p>
                      ) : null}
                      {question.correctAnswers?.length ? (
                        <p>参考答案：{question.correctAnswers.join(' / ')}</p>
                      ) : null}
                      {question.explanation && <p>解析：{question.explanation}</p>}
                      <p className={styles.voteSummary}>
                        <span>
                          <ThumbsUp size={15} aria-hidden="true" /> {question.feedback.up}
                        </span>
                        <span>
                          <ThumbsDown size={15} aria-hidden="true" /> {question.feedback.down}
                        </span>
                        {Object.entries(question.feedback.reasonCounts).map(([reason, count]) => (
                          <span key={reason}>
                            {REASON_LABELS[reason] ?? '其他'} {count}
                          </span>
                        ))}
                      </p>
                    </section>
                  ))}
                </div>
              </details>
              <footer className={styles.cardFooter}>
                {!item.isActive && <span>停用不会删除题目、反馈或旧计划中的快照。</span>}
                {item.isActive && (
                  <label className={styles.reasonInput}>
                    <span>停用说明（可选）</span>
                    <input
                      maxLength={200}
                      value={disableReasons[item.id] ?? ''}
                      onChange={(event) =>
                        setDisableReasons({ ...disableReasons, [item.id]: event.target.value })
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  className={item.isActive ? styles.disable : styles.restore}
                  disabled={busyId === item.id}
                  onClick={() => void toggleActive(item)}
                >
                  <ArchiveRestore size={17} aria-hidden="true" />
                  {busyId === item.id ? '保存中…' : item.isActive ? '停用材料' : '恢复材料'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      {data && data.total > data.pageSize && (
        <nav className={styles.pagination} aria-label="公共题库分页">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => value - 1)}
          >
            上一页
          </button>
          <span>
            第 {page} / {pageCount} 页，共 {data.total} 条
          </span>
          <button
            type="button"
            disabled={page >= pageCount || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            下一页
          </button>
        </nav>
      )}
    </section>
  );
}
