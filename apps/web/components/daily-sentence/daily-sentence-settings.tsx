'use client';

import { useEffect, useState } from 'react';
import { request, type Session, userFacingError } from '../../lib/api';
import styles from './daily-sentence.module.css';

export function DailySentenceSettings({ session }: { session: Session }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    request<{ enabled: boolean }>('/admin/daily-sentence/settings', {}, session.accessToken)
      .then((result) => {
        if (active) setEnabled(result.enabled);
      })
      .catch((err) => {
        if (active) setError(userFacingError(err));
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, revision]);
  const toggle = async () => {
    if (enabled === null || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await request<{ enabled: boolean }>(
        '/admin/daily-sentence/settings',
        { method: 'PATCH', body: JSON.stringify({ enabled: !enabled }) },
        session.accessToken,
      );
      setEnabled(result.enabled);
      setSaved(true);
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className={styles.card} aria-labelledby="daily-sentence-settings-title">
      <div className={styles.settingsRow}>
        <div>
          <h3 id="daily-sentence-settings-title">每日一句</h3>
          <p className={styles.note}>全站生效 · 每天北京时间 06:00 起准备新句，未读则保留。</p>
        </div>
        <button
          type="button"
          className={styles.button}
          role="switch"
          aria-checked={enabled === true}
          aria-label="启用每日一句"
          disabled={enabled === null || saving}
          onClick={() => void toggle()}
        >
          {saving ? '正在保存…' : enabled === null ? '正在读取…' : enabled ? '已开启' : '已关闭'}
        </button>
      </div>
      <p className={styles.note}>
        关闭后隐藏入口并停止新任务，进行中的生成可能完成；历史与收藏保留。
      </p>
      {saved && (
        <p className={styles.note} role="status">
          已保存
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
          {enabled === null && (
            <button className={styles.button} onClick={() => setRevision((value) => value + 1)}>
              重新加载
            </button>
          )}
        </p>
      )}
    </section>
  );
}
