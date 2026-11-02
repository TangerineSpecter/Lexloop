'use client';

import type {
  SystemAutoUpdateStatus,
  SystemUpdateJob,
  SystemUpdateStage,
  SystemUpdateStatus,
} from '@lexloop/types';
import {
  AlertTriangle,
  Check,
  CircleDot,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Rocket,
  ServerCog,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type Session } from '../lib/api';
import { Tooltip } from './tooltip';

const RUNNING_STAGES: SystemUpdateStage[] = [
  'CHECKING',
  'BUILDING',
  'BACKING_UP',
  'MIGRATING',
  'DEPLOYING',
  'VERIFYING',
];

const STAGE_LABELS: Record<SystemUpdateStage, string> = {
  IDLE: '等待更新',
  CHECKING: '校验版本',
  BUILDING: '构建镜像',
  BACKING_UP: '备份数据',
  MIGRATING: '迁移数据库',
  DEPLOYING: '切换服务',
  VERIFYING: '健康检查',
  SUCCEEDED: '更新完成',
  FAILED: '更新失败',
};

function shortSha(value: string) {
  return value === 'unknown' ? 'unknown' : value.slice(0, 12);
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查';
}

export function SystemUpdatePanel({ session }: { session: Session }) {
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [busy, setBusy] = useState<'load' | 'check' | 'apply' | null>('load');
  const [message, setMessage] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const mounted = useRef(true);
  const checkInFlight = useRef(false);
  const checkSequence = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await request<SystemUpdateStatus>(
        '/admin/system/update',
        {},
        session.accessToken,
      );
      setStatus(result);
      setDisconnected(false);
      setMessage('');
    } catch (error) {
      if (status?.job && RUNNING_STAGES.includes(status.job.stage)) {
        setDisconnected(true);
      } else {
        setMessage(error instanceof Error ? error.message : '版本状态加载失败');
      }
    } finally {
      setBusy((value) => (value === 'load' ? null : value));
    }
  }, [session.accessToken, status?.job]);

  useEffect(() => {
    void load();
  }, [session.accessToken]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      checkSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    checkSequence.current += 1;
    checkInFlight.current = false;
    return () => {
      checkSequence.current += 1;
      checkInFlight.current = false;
    };
  }, [session.accessToken]);

  const running = Boolean(status?.job && RUNNING_STAGES.includes(status.job.stage));
  const succeeded = status?.job?.stage === 'SUCCEEDED';
  const showUpdate = !succeeded || Boolean(status?.updateAvailable);
  useEffect(() => {
    if (!running && !disconnected && !status?.checkInProgress) return;
    const timer = window.setInterval(() => void load(), 2_500);
    return () => window.clearInterval(timer);
  }, [running, disconnected, status?.checkInProgress, load]);

  useEffect(() => {
    if (!confirming) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && !busy && setConfirming(false);
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [confirming, busy]);

  const check = async () => {
    if (checkInFlight.current || running || status?.checkInProgress) return;
    checkInFlight.current = true;
    const sequence = ++checkSequence.current;
    setBusy('check');
    setMessage('');
    setStatus((current) =>
      current
        ? {
            ...current,
            error: null,
            checkErrorCode: null,
            checkAttemptedAt: new Date().toISOString(),
            checkAttempts: 0,
            checkInProgress: true,
          }
        : current,
    );
    try {
      const result = await request<SystemUpdateStatus>(
        '/admin/system/update/check',
        { method: 'POST' },
        session.accessToken,
      );
      if (mounted.current && sequence === checkSequence.current) {
        setStatus(result);
        setMessage('');
      }
    } catch {
      if (mounted.current && sequence === checkSequence.current) {
        setStatus((current) =>
          current
            ? {
                ...current,
                error: '无法连接更新服务完成检查；请稍后重试。',
                checkErrorCode: 'UPDATER_CHECK_UNAVAILABLE',
                checkAttemptedAt: new Date().toISOString(),
                checkAttempts: 0,
                checkInProgress: false,
              }
            : current,
        );
        setMessage('');
      }
    } finally {
      if (sequence === checkSequence.current) {
        checkInFlight.current = false;
        if (mounted.current) setBusy(null);
      }
    }
  };

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!status?.latest || !password) return;
    setBusy('apply');
    setMessage('');
    try {
      await request<{ jobId: string; stage: SystemUpdateStage }>(
        '/admin/system/update/apply',
        {
          method: 'POST',
          body: JSON.stringify({
            targetVersion: status.latest.version,
            targetSha: status.latest.sha,
            password,
          }),
        },
        session.accessToken,
      );
      setPassword('');
      setConfirming(false);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新任务创建失败');
    } finally {
      setBusy(null);
    }
  };

  let headline = '尚未完成检查';
  if (!status?.updaterAvailable) headline = '更新服务未连接';
  else if (running) headline = '系统正在更新';
  else if (status.job?.stage === 'FAILED') headline = '上次更新未完成';
  else if (busy === 'check' || status.checkInProgress) headline = '正在检查更新';
  else if (status.checkErrorCode || status.error) headline = '检查更新失败';
  else if (status.updateAvailable)
    headline = status.sameVersionRevision ? '发现同版本修订' : '发现新版本';
  else if (status.checkedAt) headline = '当前已是最新版本';

  const checking = busy === 'check' || Boolean(status?.checkInProgress);
  const statusNotice = checking
    ? status?.checkedAt
      ? `正在重新检查；当前版本信息保留自上次成功检查（${formatTime(status.checkedAt)}），确认完成前不会允许安装。`
      : '正在读取受信任的远端版本；确认完成前不会显示为最新或允许安装。'
    : status?.error
      ? `${status.error} ${
          status.checkedAt
            ? `当前版本信息保留自上次成功检查（${formatTime(status.checkedAt)}）。`
            : '远端版本尚未确认。'
        }`
      : '';

  return (
    <div className="system-update-panel">
      <header className="update-hero">
        <span
          className={`update-hero-mark ${status?.updateAvailable && !status.error && !checking ? 'has-update' : ''}`}
        >
          {running || checking ? <LoaderCircle className="is-spinning" /> : <ServerCog />}
        </span>
        <div>
          <p>SYSTEM RELEASE</p>
          <h3>{headline}</h3>
          <span>版本检查只读取受信任的 master 标签；手动安装仍需管理员确认。</span>
        </div>
        <Tooltip label="立即读取远端标签">
          <button
            type="button"
            className="update-check-button"
            onClick={() => void check()}
            disabled={Boolean(busy) || running || checking}
          >
            <RefreshCw className={checking ? 'is-spinning' : ''} size={17} />
            {checking ? '检查中' : '检查更新'}
          </button>
        </Tooltip>
      </header>

      {(message || status?.error || disconnected || (checking && Boolean(status?.checkedAt))) && (
        <div className="update-notice" role="status">
          <AlertTriangle size={18} />
          <div>
            <strong>
              {disconnected ? '服务正在切换' : checking ? '正在检查更新' : '更新提示'}
            </strong>
            <span>
              {disconnected
                ? 'API 暂时不可用，页面会自动重连并恢复任务进度。'
                : message || statusNotice}
              {status?.error && status.checkAttempts ? (
                <small>已尝试 {status.checkAttempts} 次；此检查不会安装更新。</small>
              ) : null}
            </span>
          </div>
        </div>
      )}

      <div className="update-version-grid">
        <article>
          <small>当前运行版本</small>
          <strong>v{status?.currentVersion ?? '—'}</strong>
          <code>{status ? shortSha(status.currentSha) : '------------'}</code>
        </article>
        <span className="update-version-arrow" aria-hidden="true">
          →
        </span>
        <article
          className={status?.updateAvailable && !status.error && !checking ? 'is-ready' : ''}
        >
          <small>远端最新版本</small>
          <strong>{status?.latest ? `v${status.latest.version}` : '—'}</strong>
          <code>{status?.latest ? shortSha(status.latest.sha) : '------------'}</code>
        </article>
      </div>

      <div className="update-meta-row">
        <span>最近成功检查：{formatTime(status?.checkedAt ?? null)}</span>
        {status?.checkAttemptedAt && <span>最近尝试：{formatTime(status.checkAttemptedAt)}</span>}
        {status?.latest?.compareUrl && status.updateAvailable && (
          <a href={status.latest.compareUrl} target="_blank" rel="noreferrer">
            查看代码差异 <ExternalLink size={14} />
          </a>
        )}
      </div>

      {status?.job && <UpdateProgress job={status.job} />}

      <AutoUpdateSettings session={session} onRefreshStatus={load} />

      <section className="update-safety-note">
        <ShieldCheck size={22} />
        <div>
          <strong>受控更新</strong>
          <p>更新前自动备份数据库，构建成功后才切换服务；失败时恢复上一版应用镜像。</p>
        </div>
      </section>

      <footer className="update-actions">
        <span>
          {checking
            ? '正在检查远端状态；本次检查不会安装更新。'
            : status?.error
              ? '检查失败，请重新检查后再更新。'
              : status?.sameVersionRevision
                ? '标签版本未变化，但提交内容已经更新。'
                : status?.updateAvailable
                  ? '更新期间局域网访问可能短暂中断。'
                  : '自动更新默认关闭；管理员启用后才会自动安装。'}
        </span>
        <div className="update-action-buttons">
          {succeeded && (
            <button type="button" onClick={() => window.location.reload()}>
              <RefreshCw size={17} />
              重新载入
            </button>
          )}
          {showUpdate && (
            <button
              type="button"
              className="update-apply-button"
              disabled={
                !status?.updateAvailable ||
                !status.updaterAvailable ||
                running ||
                Boolean(busy) ||
                Boolean(status.error) ||
                Boolean(status.checkInProgress) ||
                !status.checkedAt
              }
              onClick={() => setConfirming(true)}
            >
              <Rocket size={18} />
              立即更新
            </button>
          )}
        </div>
      </footer>

      {confirming && status?.latest && (
        <div
          className="update-dialog-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-dialog-title"
        >
          <button
            className="update-dialog-scrim"
            aria-label="取消更新"
            onClick={() => !busy && setConfirming(false)}
          />
          <form className="update-dialog" onSubmit={(event) => void apply(event)}>
            <header>
              <span>
                <LockKeyhole size={24} />
              </span>
              <div>
                <p>ADMIN CONFIRMATION</p>
                <h2 id="update-dialog-title">确认更新到 v{status.latest.version}</h2>
              </div>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                aria-label="关闭"
                disabled={Boolean(busy)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="update-dialog-warning">
              <AlertTriangle size={19} />
              <span>服务预计会中断 10–60 秒。数据库会先备份，但数据库迁移不会自动回滚。</span>
            </div>
            {message && (
              <div className="update-dialog-error" role="alert">
                <AlertTriangle size={17} />
                {message}
              </div>
            )}
            <label>
              输入当前账号密码以确认
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <footer>
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirming(false)}
                disabled={Boolean(busy)}
              >
                取消
              </button>
              <button disabled={busy === 'apply' || password.length < 8}>
                <Rocket size={17} />
                {busy === 'apply' ? '正在创建任务…' : '确认并开始更新'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

function AutoUpdateSettings({
  session,
  onRefreshStatus,
}: {
  session: Session;
  onRefreshStatus: () => Promise<void>;
}) {
  const [status, setStatus] = useState<SystemAutoUpdateStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const onRefreshRef = useRef(onRefreshStatus);
  const formDirty = useRef(false);

  useEffect(() => {
    onRefreshRef.current = onRefreshStatus;
  }, [onRefreshStatus]);

  const refresh = useCallback(async () => {
    try {
      const result = await request<SystemAutoUpdateStatus>(
        '/admin/system/update/auto',
        {},
        session.accessToken,
      );
      setStatus(result);
      if (!formDirty.current) {
        setEnabled(result.enabled);
        setIntervalHours(result.intervalHours);
      }
      setError('');
      void onRefreshRef.current();
    } catch {
      setError('无法读取自动更新设置；请检查更新服务连接。');
    } finally {
      setLoading(false);
    }
  }, [session.accessToken]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (enabled && !acknowledged) {
      setError('请先确认自动更新会自动安装版本并可能中断服务。');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await request<SystemAutoUpdateStatus>(
        '/admin/system/update/auto',
        { method: 'POST', body: JSON.stringify({ enabled, intervalHours }) },
        session.accessToken,
      );
      setStatus(result);
      formDirty.current = false;
      setEnabled(result.enabled);
      setIntervalHours(result.intervalHours);
      setAcknowledged(false);
      setMessage(result.enabled ? '自动更新设置已保存。' : '自动更新已关闭。');
      void onRefreshRef.current();
    } catch {
      setError('自动更新设置未保存；请重试并确认更新服务可用。');
    } finally {
      setSaving(false);
    }
  };

  const checkResultLabel: Record<SystemAutoUpdateStatus['lastCheckResult'], string> = {
    never: '尚未自动检查',
    scheduled: '等待下次自动检查',
    checking: '正在检查远端版本',
    up_to_date: '检查完成，未发现新版本',
    update_available: '已发现新版本',
    check_failed: '最近一次自动检查失败',
    updating: '自动更新正在进行',
  };
  const updateResultLabel: Record<SystemAutoUpdateStatus['lastUpdateResult'], string> = {
    never: '尚无自动安装记录',
    running: '自动安装进行中',
    succeeded: '最近一次自动安装完成',
    failed: '最近一次自动安装失败',
  };

  return (
    <section className="update-auto-settings" aria-labelledby="auto-update-title">
      <header>
        <div>
          <p>AUTOMATIC UPDATES</p>
          <h4 id="auto-update-title">自动检查与安装</h4>
        </div>
        <strong className={status?.enabled ? 'is-enabled' : ''}>
          {loading ? '正在读取' : status?.enabled ? '已开启' : '默认关闭'}
        </strong>
      </header>
      <p className="update-auto-warning">
        开启后，系统会按设定周期检查受信任的 master
        版本，并在发现新版本时自动安装，无需逐次输入管理员密码。安装会构建镜像、备份数据库并迁移，可能中断服务；迁移失败不会自动回滚数据库。关闭设置不会中断已经开始的更新。
      </p>
      <form onSubmit={(event) => void save(event)}>
        <label className="update-auto-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading || !status?.available || saving}
            onChange={(event) => {
              formDirty.current = true;
              setEnabled(event.target.checked);
            }}
          />
          启用自动检查并安装
        </label>
        <label className="update-auto-interval">
          检查周期（小时）
          <input
            type="number"
            min={6}
            max={168}
            step={1}
            required
            value={intervalHours}
            disabled={loading || !status?.available || saving}
            onChange={(event) => {
              formDirty.current = true;
              setIntervalHours(Number(event.target.value));
            }}
          />
          <small>可设置 6–168 小时；调度器每分钟检查一次是否到期。</small>
        </label>
        {enabled && (
          <label className="update-auto-acknowledge">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={loading || !status?.available || saving}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            我理解开启后会自动安装更新，且服务可能短暂中断。
          </label>
        )}
        {error && (
          <p className="update-auto-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="update-auto-message" role="status">
            {message}
          </p>
        )}
        <button type="submit" disabled={loading || !status?.available || saving}>
          {saving ? '正在保存…' : '保存自动更新设置'}
        </button>
      </form>
      <dl className="update-auto-status">
        <div>
          <dt>自动检查状态</dt>
          <dd>{status ? checkResultLabel[status.lastCheckResult] : '—'}</dd>
        </div>
        <div>
          <dt>最近检查</dt>
          <dd>{formatTime(status?.lastCheckAt ?? null)}</dd>
        </div>
        <div>
          <dt>下次检查</dt>
          <dd>{status?.enabled ? formatTime(status.nextCheckAt) : '未安排'}</dd>
        </div>
        <div>
          <dt>自动安装状态</dt>
          <dd>{status ? updateResultLabel[status.lastUpdateResult] : '—'}</dd>
        </div>
        {status?.lastUpdateAt && (
          <div>
            <dt>最近自动安装</dt>
            <dd>{formatTime(status.lastUpdateAt)}</dd>
          </div>
        )}
      </dl>
      {status?.lastCheckErrorCode && (
        <small className="update-auto-code">检查错误分类：{status.lastCheckErrorCode}</small>
      )}
      {status?.lastUpdateError && (
        <p className="update-auto-error" role="status">
          {status.lastUpdateError}
        </p>
      )}
      {!status?.available && (
        <p className="update-auto-error" role="status">
          当前更新服务不支持自动更新设置。
        </p>
      )}
    </section>
  );
}

function UpdateProgress({ job }: { job: SystemUpdateJob }) {
  const currentIndex = RUNNING_STAGES.indexOf(job.stage);
  return (
    <section className={`update-progress is-${job.stage.toLowerCase()}`}>
      <header>
        <div>
          {job.stage === 'FAILED' ? (
            <AlertTriangle />
          ) : job.stage === 'SUCCEEDED' ? (
            <Check />
          ) : (
            <LoaderCircle className="is-spinning" />
          )}
          <strong>{STAGE_LABELS[job.stage]}</strong>
        </div>
        <code>{job.id.slice(0, 8)}</code>
      </header>
      <p>{job.message}</p>
      <ol>
        {RUNNING_STAGES.map((stage, index) => {
          const done = job.stage === 'SUCCEEDED' || (currentIndex >= 0 && index < currentIndex);
          const active = stage === job.stage;
          return (
            <li key={stage} className={done ? 'done' : active ? 'active' : ''}>
              {done ? <Check size={13} /> : <CircleDot size={13} />}
              <span>{STAGE_LABELS[stage]}</span>
            </li>
          );
        })}
      </ol>
      {job.logs.length > 0 && (
        <details>
          <summary>查看更新记录</summary>
          <pre>{job.logs.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
