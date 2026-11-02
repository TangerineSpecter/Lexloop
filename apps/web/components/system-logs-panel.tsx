'use client';

import { AlertTriangle, Download, FileSearch, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';

type SystemLogDetail = {
  at: string;
  source: 'api' | 'worker';
  kind: string;
  code: string;
  status?: number;
  upstreamStatus?: number;
  param?: string;
  method?: string;
  route?: string;
  phase?: string;
  fieldPath?: string;
  attemptsMade?: number;
  maxAttempts?: number;
  reason: string;
};

type SystemLogGroup = {
  fingerprint: string;
  source: 'api' | 'worker';
  kind: string;
  code: string;
  count: number;
  firstAt: string;
  lastAt: string;
  latestDetail: SystemLogDetail;
};

type SystemLogResponse = {
  timeZone: string;
  range: { from: string; to: string };
  retentionDays: number;
  storage: {
    usedBytes: number;
    maxBytes: number;
    droppedEvents: number;
    apiWriteFailuresSinceStart: number;
    unreadableRecords: number;
  };
  totalGroups: number;
  truncatedGroups: number;
  groups: SystemLogGroup[];
};

type Filters = {
  from?: string;
  to?: string;
  source?: 'api' | 'worker';
  search?: string;
};

const SYSTEM_LOG_PHASE_LABELS: Record<string, string> = {
  retry: '失败尝试，可重试',
  final: '最后一次失败',
  provider_request: '供应商请求',
  response_parse: '供应商响应解析',
  content_parse: '学习内容解析',
  content_validation: '学习内容校验',
  plan_persistence: '学习计划保存',
  internal: '应用内部处理',
};

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '/api/v1').replace(/\/$/, '');

export function SystemLogsPanel({ session }: { session: Session }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState<'all' | 'api' | 'worker'>('all');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<SystemLogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const requestSequence = useRef(0);
  const appliedFilters = useRef<Filters>({});
  const clearButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  const load = useCallback(
    async (filters: Filters = {}, options: { preserveNotice?: boolean } = {}) => {
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError('');
      if (!options.preserveNotice) setNotice('');
      const params = new URLSearchParams();
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.source) params.set('source', filters.source);
      if (filters.search?.trim()) params.set('search', filters.search.trim());
      try {
        const result = await request<SystemLogResponse>(
          `/admin/system-logs${params.size ? `?${params}` : ''}`,
          {},
          session.accessToken,
        );
        if (requestSequence.current !== sequence) return;
        setData(result);
        appliedFilters.current = {
          from: result.range.from,
          to: result.range.to,
          source: filters.source,
          search: filters.search?.trim(),
        };
        setFrom((current) => current || result.range.from);
        setTo((current) => current || result.range.to);
      } catch (cause) {
        if (requestSequence.current === sequence) {
          setError(cause instanceof Error ? cause.message : '日志读取失败，请稍后重试。');
        }
      } finally {
        if (requestSequence.current === sequence) setLoading(false);
      }
    },
    [session.accessToken],
  );

  useEffect(() => {
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!confirmClear) return;
    const cancelButton = dialog.current?.querySelector<HTMLButtonElement>('button:not(.danger)');
    const lastButton = dialog.current?.querySelector<HTMLButtonElement>('button.danger');
    cancelButton?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !clearing) {
        event.preventDefault();
        setConfirmClear(false);
      }
      if (event.key !== 'Tab' || !cancelButton || !lastButton) return;
      if (event.shiftKey && document.activeElement === cancelButton) {
        event.preventDefault();
        lastButton.focus();
      } else if (!event.shiftKey && document.activeElement === lastButton) {
        event.preventDefault();
        cancelButton.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearButton.current?.focus();
    };
  }, [confirmClear, clearing]);

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    void load({ from, to, source: source === 'all' ? undefined : source, search });
  };

  const exportCsv = async (fingerprint?: string) => {
    setExporting(fingerprint ?? 'range');
    setError('');
    try {
      const params = new URLSearchParams();
      if (data?.range.from) params.set('from', data.range.from);
      if (data?.range.to) params.set('to', data.range.to);
      if (appliedFilters.current.source) params.set('source', appliedFilters.current.source);
      if (appliedFilters.current.search) params.set('search', appliedFilters.current.search);
      if (fingerprint) params.set('fingerprint', fingerprint);
      const response = await fetch(`${API_URL}/admin/system-logs/export?${params}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      if (!response.ok) {
        let message = '日志导出失败，请稍后重试。';
        try {
          const body = (await response.json()) as { message?: unknown };
          if (typeof body.message === 'string') message = body.message;
        } catch {
          // Keep the safe local fallback when the service returns no JSON body.
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const filename = response.headers
        .get('Content-Disposition')
        ?.match(/filename="([A-Za-z0-9._-]+)"/)?.[1];
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename ?? 'lexloop-system-logs.csv';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '日志导出失败，请稍后重试。');
    } finally {
      setExporting('');
    }
  };

  const clearLogs = async () => {
    setClearing(true);
    setError('');
    try {
      await request('/admin/system-logs/clear', { method: 'DELETE' }, session.accessToken);
      setConfirmClear(false);
      setNotice('当前保留的错误日志已清空；清空后新发生的日志仍会记录。');
      await load(appliedFilters.current, { preserveNotice: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清空日志失败，请稍后重试。');
    } finally {
      setClearing(false);
    }
  };

  const timestamp = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? value
      : new Intl.DateTimeFormat('zh-CN', {
          timeZone: data?.timeZone ?? 'Asia/Shanghai',
          dateStyle: 'short',
          timeStyle: 'medium',
        }).format(date);
  };
  const appliedFilterPending = Boolean(
    data &&
    (from !== data.range.from ||
      to !== data.range.to ||
      (source === 'all' ? undefined : source) !== appliedFilters.current.source ||
      search.trim() !== (appliedFilters.current.search ?? '')),
  );

  return (
    <section className="system-log-panel" aria-busy={loading}>
      <header className="system-log-header">
        <div>
          <h3>
            <FileSearch size={20} aria-hidden="true" />
            系统错误日志
          </h3>
          <p>按错误类型聚合次数，并查看所选日期范围内最近一次的脱敏明细。</p>
        </div>
        <button
          ref={clearButton}
          type="button"
          className="system-log-clear"
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={16} aria-hidden="true" />
          清空日志
        </button>
      </header>

      <p className="system-log-privacy">
        仅记录应用 API 错误、模型测试失败和后台队列失败；不记录密钥、请求正文、学习者回答或
        Cookie。日志按 {data?.timeZone ?? 'Asia/Shanghai'} 日期保留 {data?.retentionDays ?? 14}{' '}
        天，文件总量上限 100 MB，不写入数据库。
      </p>

      <form className="system-log-filters" onSubmit={applyFilters}>
        <label>
          开始日期
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          结束日期
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label>
          来源
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
          >
            <option value="all">全部来源</option>
            <option value="api">API</option>
            <option value="worker">后台任务</option>
          </select>
        </label>
        <label className="system-log-search">
          关键字
          <input
            value={search}
            maxLength={80}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="错误码、接口或原因"
          />
        </label>
        <button type="submit" className="system-log-apply" disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" />
          {loading ? '读取中…' : '筛选日志'}
        </button>
      </form>

      {data && (
        <div className="system-log-summary" role="status">
          <strong>{data.totalGroups} 类错误</strong>
          <span>
            日志文件占用 {formatBytes(data.storage.usedBytes)} /{' '}
            {formatBytes(data.storage.maxBytes)}
          </span>
        </div>
      )}
      {error && (
        <p className="system-log-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          {error}
          {data && (
            <button
              type="button"
              onClick={() =>
                void load({ from, to, source: source === 'all' ? undefined : source, search })
              }
            >
              重试
            </button>
          )}
        </p>
      )}
      {notice && (
        <p className="system-log-notice" role="status">
          {notice}
        </p>
      )}
      {appliedFilterPending && (
        <p className="system-log-storage" role="status">
          筛选条件已更改，点击“筛选日志”后更新列表与导出范围。
        </p>
      )}
      <div className="system-log-range-actions">
        <strong>{appliedFilterPending ? '待应用筛选结果' : '当前筛选结果'}</strong>
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={!data || appliedFilterPending || exporting !== '' || data.groups.length === 0}
        >
          <Download size={16} aria-hidden="true" />
          {exporting === 'range' ? '正在导出…' : '导出已筛选范围 CSV'}
        </button>
      </div>

      {data?.truncatedGroups ? (
        <p className="system-log-storage">
          列表最多显示 {data.groups.length} 类，请用关键字缩小范围后导出。
        </p>
      ) : null}
      {data?.groups.length ? (
        <div className="system-log-list">
          {data.groups.map((group) => (
            <article key={group.fingerprint} className="system-log-card">
              <header>
                <div>
                  <strong>{group.code}</strong>
                  <span>
                    {group.kind} · {group.source === 'api' ? 'API' : '后台任务'}
                  </span>
                </div>
                <b aria-label={`发生 ${group.count} 次`}>{group.count} 次</b>
              </header>
              <dl>
                <div>
                  <dt>最近发生</dt>
                  <dd>{timestamp(group.lastAt)}</dd>
                </div>
                {group.latestDetail.status !== undefined && (
                  <div>
                    <dt>HTTP</dt>
                    <dd>{group.latestDetail.status}</dd>
                  </div>
                )}
                {group.latestDetail.upstreamStatus !== undefined && (
                  <div>
                    <dt>上游 HTTP</dt>
                    <dd>{group.latestDetail.upstreamStatus}</dd>
                  </div>
                )}
                {group.latestDetail.param && (
                  <div>
                    <dt>param</dt>
                    <dd>{group.latestDetail.param}</dd>
                  </div>
                )}
                {group.latestDetail.route && (
                  <div>
                    <dt>接口</dt>
                    <dd>
                      {group.latestDetail.method} {group.latestDetail.route}
                    </dd>
                  </div>
                )}
                {group.latestDetail.phase && (
                  <div>
                    <dt>错误阶段</dt>
                    <dd>
                      {SYSTEM_LOG_PHASE_LABELS[group.latestDetail.phase] ??
                        group.latestDetail.phase}
                    </dd>
                  </div>
                )}
                {group.latestDetail.fieldPath && (
                  <div>
                    <dt>字段</dt>
                    <dd>{group.latestDetail.fieldPath}</dd>
                  </div>
                )}
                {group.latestDetail.attemptsMade !== undefined && (
                  <div>
                    <dt>尝试次数</dt>
                    <dd>
                      {group.latestDetail.attemptsMade} / {group.latestDetail.maxAttempts ?? '未知'}
                    </dd>
                  </div>
                )}
              </dl>
              <p>{group.latestDetail.reason}</p>
              <footer>
                <span>该日期范围首次：{timestamp(group.firstAt)}</span>
                <button
                  type="button"
                  onClick={() => void exportCsv(group.fingerprint)}
                  disabled={exporting !== ''}
                >
                  <Download size={15} aria-hidden="true" />
                  {exporting === group.fingerprint ? '正在导出…' : '导出此条'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : data && !loading ? (
        <div className="system-log-empty">
          <FileSearch size={24} aria-hidden="true" />
          <strong>所选范围内没有错误日志</strong>
          <span>这是查询结果为空，不代表日志功能或服务状态异常。</span>
        </div>
      ) : loading && !data ? (
        <div className="system-log-empty" role="status">
          正在读取系统日志…
        </div>
      ) : null}

      {confirmClear && (
        <div className="system-log-confirm-layer" role="presentation">
          <section
            ref={dialog}
            className="system-log-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="system-log-clear-title"
            aria-describedby="system-log-clear-description"
            tabIndex={-1}
          >
            <h3 id="system-log-clear-title">清空当前保存的日志？</h3>
            <p id="system-log-clear-description">
              这会删除已保留的应用错误记录，不影响学习数据。清空之后新发生的日志仍会继续记录。
            </p>
            <footer>
              <button type="button" disabled={clearing} onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={clearing}
                onClick={() => void clearLogs()}
              >
                {clearing ? '正在清空…' : '确认清空日志'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
