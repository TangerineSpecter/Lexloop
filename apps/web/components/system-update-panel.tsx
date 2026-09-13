'use client';

import type { SystemUpdateJob, SystemUpdateStage, SystemUpdateStatus } from '@lexloop/types';
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
import { useCallback, useEffect, useMemo, useState } from 'react';
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

  const running = Boolean(status?.job && RUNNING_STAGES.includes(status.job.stage));
  useEffect(() => {
    if (!running && !disconnected) return;
    const timer = window.setInterval(() => void load(), 2_500);
    return () => window.clearInterval(timer);
  }, [running, disconnected, load]);

  useEffect(() => {
    if (!confirming) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && !busy && setConfirming(false);
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [confirming, busy]);

  const check = async () => {
    setBusy('check');
    setMessage('');
    try {
      setStatus(
        await request<SystemUpdateStatus>(
          '/admin/system/update/check',
          { method: 'POST' },
          session.accessToken,
        ),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检查更新失败');
    } finally {
      setBusy(null);
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

  const headline = useMemo(() => {
    if (!status?.updaterAvailable) return '更新服务未连接';
    if (running) return '系统正在更新';
    if (status.job?.stage === 'FAILED') return '上次更新未完成';
    if (status.updateAvailable) return status.sameVersionRevision ? '发现同版本修订' : '发现新版本';
    return '当前已是最新版本';
  }, [running, status]);

  return (
    <div className="system-update-panel">
      <header className="update-hero">
        <span className={`update-hero-mark ${status?.updateAvailable ? 'has-update' : ''}`}>
          {running ? <LoaderCircle className="is-spinning" /> : <ServerCog />}
        </span>
        <div>
          <p>SYSTEM RELEASE</p>
          <h3>{headline}</h3>
          <span>版本检查只读取受信任的 master 标签；安装更新始终需要管理员确认。</span>
        </div>
        <Tooltip label="立即读取远端标签">
          <button
            type="button"
            className="update-check-button"
            onClick={() => void check()}
            disabled={Boolean(busy) || running}
          >
            <RefreshCw className={busy === 'check' ? 'is-spinning' : ''} size={17} />
            {busy === 'check' ? '检查中' : '检查更新'}
          </button>
        </Tooltip>
      </header>

      {(message || status?.error || disconnected) && (
        <div className="update-notice" role="status">
          <AlertTriangle size={18} />
          <div>
            <strong>{disconnected ? '服务正在切换' : '更新提示'}</strong>
            <span>
              {disconnected
                ? 'API 暂时不可用，页面会自动重连并恢复任务进度。'
                : message || status?.error}
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
        <article className={status?.updateAvailable ? 'is-ready' : ''}>
          <small>远端最新版本</small>
          <strong>{status?.latest ? `v${status.latest.version}` : '—'}</strong>
          <code>{status?.latest ? shortSha(status.latest.sha) : '------------'}</code>
        </article>
      </div>

      <div className="update-meta-row">
        <span>上次检查：{formatTime(status?.checkedAt ?? null)}</span>
        {status?.latest?.compareUrl && status.updateAvailable && (
          <a href={status.latest.compareUrl} target="_blank" rel="noreferrer">
            查看代码差异 <ExternalLink size={14} />
          </a>
        )}
      </div>

      {status?.job && <UpdateProgress job={status.job} />}

      <section className="update-safety-note">
        <ShieldCheck size={22} />
        <div>
          <strong>受控更新</strong>
          <p>更新前自动备份数据库，构建成功后才切换服务；失败时恢复上一版应用镜像。</p>
        </div>
      </section>

      <footer className="update-actions">
        <span>
          {status?.sameVersionRevision
            ? '标签版本未变化，但提交内容已经更新。'
            : status?.updateAvailable
              ? '更新期间局域网访问可能短暂中断。'
              : '系统不会自动安装更新。'}
        </span>
        {status?.job?.stage === 'SUCCEEDED' ? (
          <button type="button" onClick={() => window.location.reload()}>
            <RefreshCw size={17} />
            重新载入
          </button>
        ) : (
          <button
            type="button"
            className="update-apply-button"
            disabled={
              !status?.updateAvailable || !status.updaterAvailable || running || Boolean(busy)
            }
            onClick={() => setConfirming(true)}
          >
            <Rocket size={18} />
            立即更新
          </button>
        )}
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
