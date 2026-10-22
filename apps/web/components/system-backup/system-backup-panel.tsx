'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteBackupStatus } from '@lexloop/types';
import { request, type Session, userFacingError } from '../../lib/api';
import styles from './system-backup.module.css';

const defaults = {
  enabled: true,
  host: '',
  port: 22,
  username: '',
  remotePath: '/backups/lexloop',
  hostKey: '',
};
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '尚无记录';

export function SystemBackupPanel({ session }: { session: Session }) {
  const [status, setStatus] = useState<RemoteBackupStatus | null>(null);
  const [form, setForm] = useState(defaults);
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const initialized = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    try {
      const result = await request<RemoteBackupStatus>(
        '/admin/system/backups',
        {},
        session.accessToken,
      );
      setStatus(result);
      if (result.available && !initialized.current) {
        if (result.settings) setForm(result.settings);
        initialized.current = true;
        setLoaded(true);
      }
      return result;
    } catch (err) {
      setError(userFacingError(err));
      return null;
    }
  }, [session.accessToken]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (kind: 'config' | 'run') => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const body =
        kind === 'config'
          ? {
              enabled: form.enabled,
              host: form.host.trim(),
              port: form.port,
              username: form.username.trim(),
              remotePath: form.remotePath.trim(),
              hostKey: form.hostKey.trim(),
              privateKey,
              passphrase,
              resetConfig: !!status?.configurationError && resetConfirmed,
              password,
            }
          : { password };
      const result = await request<RemoteBackupStatus>(
        `/admin/system/backups/${kind}`,
        { method: 'POST', body: JSON.stringify(body) },
        session.accessToken,
      );
      setStatus(result);
      setPassword('');
      if (kind === 'config') {
        setPrivateKey('');
        setPassphrase('');
        setResetConfirmed(false);
      }
      setMessage(
        kind === 'config'
          ? '配置已保存。请立即执行一次备份，确认远端可以接收。'
          : '备份任务已提交，完成后会更新下方状态。',
      );
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setBusy(false);
    }
  };
  const disabled = !loaded || !status?.available || busy || !!status.running;
  return (
    <section className={styles.panel} aria-labelledby="remote-backup-title">
      <header>
        <h3 id="remote-backup-title">远端备份 · SFTP</h3>
        <p>
          每天自动将数据库和恢复所需配置加密上传到另一台服务器或
          NAS。失败后一小时重试，保留独立历史文件。
        </p>
      </header>
      <div className={styles.status} aria-live="polite">
        <strong>
          {status?.running
            ? '正在备份并上传…'
            : !status?.settings
              ? '尚未配置远端备份'
              : status.settings.enabled
                ? '自动备份已开启'
                : '自动备份已关闭'}
        </strong>
        <span>最近尝试：{date(status?.lastAttemptAt)}</span>
        <span>最近成功：{date(status?.lastSuccessAt)}</span>
        {status?.lastFile && <small>最近文件：{status.lastFile}</small>}
        {status?.stale && (
          <p role="alert">尚无成功备份，或远端备份已超过 26 小时，请检查并执行备份。</p>
        )}
        {status?.error && <p role="alert">{status.error}</p>}
        {status?.configurationError && <p role="alert">{status.configurationError}</p>}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action('config');
        }}
      >
        <fieldset disabled={disabled} className={styles.fields}>
          {status?.configurationError && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={resetConfirmed}
                onChange={(event) => setResetConfirmed(event.target.checked)}
              />
              确认用下方完整配置替换无法解密的旧配置
            </label>
          )}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            启用每日自动备份
          </label>
          <label>
            SFTP 主机
            <input
              required
              value={form.host}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
              placeholder="backup.example.com 或 IP"
            />
          </label>
          <label>
            端口
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
            />
          </label>
          <label>
            用户名
            <input
              required
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
            />
          </label>
          <label>
            远端目录
            <input
              required
              value={form.remotePath}
              onChange={(event) => setForm({ ...form, remotePath: event.target.value })}
            />
            <small>提前创建可写的绝对目录；使用字母、数字、点、横线或下划线。</small>
          </label>
          <label className={styles.full}>
            服务器 SSH 主机公钥
            <input
              required
              value={form.hostKey}
              onChange={(event) => setForm({ ...form, hostKey: event.target.value })}
              placeholder="ssh-ed25519 AAAA…"
            />
            <small>向远端服务器管理员获取并核对，用于验证连接的是正确服务器。</small>
          </label>
          <label className={styles.full}>
            SSH 私钥
            <textarea
              rows={5}
              required={!status?.settings?.hasPrivateKey}
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              placeholder={
                status?.settings?.hasPrivateKey
                  ? '已配置，留空保留'
                  : '粘贴专用于备份的未加密 SSH 私钥'
              }
              autoComplete="off"
            />
            <small>将对应公钥加入远端账号。私钥仅在服务端加密保存，不会回显。</small>
          </label>
          <label className={styles.full}>
            备份解密口令
            <input
              type="password"
              minLength={16}
              required={!status?.settings?.hasPassphrase}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={
                status?.settings?.hasPassphrase
                  ? '已配置，留空保留'
                  : '至少 16 位，请在其他设备或密码管理器中保存'
              }
              autoComplete="new-password"
            />
            <small>原服务器损坏后，恢复必须使用该口令；更换口令后，旧备份仍需旧口令。</small>
          </label>
        </fieldset>
        <label className={styles.password}>
          当前管理员密码
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={disabled}
          />
        </label>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <footer>
          <button disabled={disabled || (!!status?.configurationError && !resetConfirmed)}>
            保存配置
          </button>
          <button
            type="button"
            disabled={disabled || !status?.settings || !password}
            onClick={() => void action('run')}
          >
            立即备份到已保存的远端
          </button>
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            刷新状态
          </button>
        </footer>
      </form>
      <p>
        备份包含账号、学习记录、模型配置和生产密钥；不包含 Redis 队列及 MinIO
        对象。远端历史文件不会自动删除，请在备份服务器配置保留策略并定期演练恢复。
      </p>
    </section>
  );
}
