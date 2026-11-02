'use client';

import { useEffect, useState } from 'react';
import { request, type Session, userFacingError } from '../lib/api';
import styles from './daily-sentence/daily-sentence.module.css';

type AutomaticStudyPlanSettingsValue = {
  enabled: boolean;
  scheduleTime: string;
  timeZone: 'Asia/Shanghai';
  today: {
    dateKey: string;
    QUEUED: number;
    RUNNING: number;
    GENERATED: number;
    SKIPPED: number;
    FAILED: number;
  };
  reasons: Record<string, number>;
};

const REASON_LABELS: Record<string, string> = {
  DISABLED: '设置已关闭',
  MISSED_DATE: '已错过当天计划',
  PLAN_IN_PROGRESS: '用户已有未完成计划',
  MODEL_NOT_SELECTED: '未选择可用模型',
  MODEL_NOT_READY: '模型配置不可用',
  NO_ELIGIBLE_WORDS: '没有可练词条',
  WORKER_INTERRUPTED: '后台任务中断',
  PLAN_CREATE_FAILED: '计划创建失败',
  GENERATION_FAILED: '材料生成失败',
  PREVIOUS_AUTO_PLAN_FAILED: '此前自动计划尚未处理',
};

export function AutomaticStudyPlanSettings({ session }: { session: Session }) {
  const [settings, setSettings] = useState<AutomaticStudyPlanSettingsValue | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('06:30');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const ready = settings !== null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    request<AutomaticStudyPlanSettingsValue>(
      '/admin/automatic-study-plan/settings',
      {},
      session.accessToken,
    )
      .then((result) => {
        if (!active) return;
        setSettings(result);
        setEnabled(result.enabled);
        setScheduleTime(result.scheduleTime);
      })
      .catch((err) => {
        if (active) setError(userFacingError(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, revision]);

  const save = async () => {
    if (!ready || loading || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await request<AutomaticStudyPlanSettingsValue>(
        '/admin/automatic-study-plan/settings',
        { method: 'PATCH', body: JSON.stringify({ enabled, scheduleTime }) },
        session.accessToken,
      );
      setSettings(result);
      setEnabled(result.enabled);
      setScheduleTime(result.scheduleTime);
      setSaved(true);
    } catch (err) {
      setError(userFacingError(err));
    } finally {
      setSaving(false);
    }
  };

  const today = settings?.today;
  return (
    <section className={styles.card} aria-labelledby="automatic-study-plan-settings-title">
      <div className={styles.settingsRow}>
        <div>
          <h3 id="automatic-study-plan-settings-title">每日自动学习计划</h3>
          <p className={styles.note}>
            面向全部用户。开启后，系统每天按北京时间为符合条件的用户准备一份学习计划。
          </p>
        </div>
        <button
          type="button"
          className={styles.button}
          role="switch"
          aria-checked={enabled}
          aria-label="启用每日自动学习计划"
          disabled={!ready || loading || saving}
          onClick={() => {
            setEnabled((value) => !value);
            setSaved(false);
          }}
        >
          {loading ? '正在读取…' : enabled ? '已开启' : '已关闭'}
        </button>
      </div>

      <div className={styles.automaticSettings}>
        <label htmlFor="automatic-study-plan-time">每天执行时间（北京时间）</label>
        <input
          id="automatic-study-plan-time"
          type="time"
          value={scheduleTime}
          disabled={!ready || loading || saving}
          onChange={(event) => {
            setScheduleTime(event.target.value);
            setSaved(false);
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={!ready || loading || saving}
          onClick={save}
        >
          {saving ? '正在保存…' : '保存设置'}
        </button>
      </div>

      <p className={styles.note}>
        自动计划使用用户默认新词数和现有到期复习选择（最多 40
        个），按普通分组练习生成；不会推算未保存的练习偏好。没有可用模型、词书或可练词时会跳过。每人每天最多处理一次，失败最多再试一次并复用同一计划；连续失败不会每天新建计划，需由用户手动处理；错过的日期不会补生成。
      </p>
      <p className={styles.warning}>
        开启后会为所有符合条件的用户调用其已选模型，可能产生模型费用。请先确认费用与服务容量。关闭会阻止尚未开始的排队任务；已经开始的生成无法安全中断，可能完成。
      </p>
      {today && (
        <p className={styles.note} role="status">
          {today.dateKey}：已生成 {today.GENERATED}，跳过 {today.SKIPPED}，处理中 {today.RUNNING}
          ，待处理 {today.QUEUED}，失败 {today.FAILED}。
        </p>
      )}
      {settings && Object.keys(settings.reasons).length > 0 && (
        <p className={styles.note}>
          今日结果说明：
          {Object.entries(settings.reasons)
            .map(([code, count]) => `${REASON_LABELS[code] ?? '其他原因'} ${count} 人`)
            .join('；')}
          。
        </p>
      )}
      {saved && (
        <p className={styles.note} role="status">
          设置已保存。
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
          {!ready && !loading && (
            <button className={styles.button} onClick={() => setRevision((value) => value + 1)}>
              重新加载
            </button>
          )}
        </p>
      )}
    </section>
  );
}
