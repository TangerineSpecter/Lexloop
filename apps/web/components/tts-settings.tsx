'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LoaderCircle, Volume2 } from 'lucide-react';
import { request, type Session, userFacingError } from '../lib/api';
import styles from './tts-settings.module.css';

type Region = 'CHINA' | 'GLOBAL';
type TtsConfig = {
  enabled: boolean;
  region: Region | null;
  model: string;
  voiceId: string | null;
  speed: number;
  volume: number;
  pitch: number;
  maxGenerationsPerUserPerDay: number;
  hasApiKey: boolean;
};

const INITIAL: TtsConfig = {
  enabled: false,
  region: null,
  model: 'speech-2.8-hd',
  voiceId: 'English_captivating_female1',
  speed: 1,
  volume: 1,
  pitch: 0,
  maxGenerationsPerUserPerDay: 100,
  hasApiKey: false,
};

export function TtsSettings({ session }: { session: Session }) {
  const [config, setConfig] = useState<TtsConfig>(INITIAL);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      testAudioRef.current?.pause();
      testAudioRef.current = null;
      if (testAudioUrlRef.current) URL.revokeObjectURL(testAudioUrlRef.current);
      testAudioUrlRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setConfigLoaded(false);
    setError('');
    request<TtsConfig>('/admin/tts-config', {}, session.accessToken)
      .then((value) => {
        if (active) {
          setConfig(value);
          setConfigLoaded(true);
        }
      })
      .catch((reason) => {
        if (active) setError(userFacingError(reason, '语音设置加载失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, revision]);

  function update<K extends keyof TtsConfig>(key: K, value: TtsConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
    setNotice('');
  }

  async function save() {
    if (saving || loading || !configLoaded) return;
    setSaving(true);
    setError('');
    setNotice('');
    const body = {
      enabled: config.enabled,
      region: config.region,
      model: config.model,
      voiceId: config.voiceId,
      speed: config.speed,
      volume: config.volume,
      pitch: config.pitch,
      maxGenerationsPerUserPerDay: config.maxGenerationsPerUserPerDay,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(clearApiKey ? { clearApiKey: true } : {}),
    };
    try {
      const saved = await request<TtsConfig>(
        '/admin/tts-config',
        { method: 'PUT', body: JSON.stringify(body) },
        session.accessToken,
      );
      setConfig(saved);
      setApiKey('');
      setClearApiKey(false);
      setNotice('设置已保存');
    } catch (reason) {
      setError(userFacingError(reason, '语音设置未保存'));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (testing || saving || loading || !configLoaded || !config.hasApiKey || !config.region)
      return;
    setTesting(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ success: boolean; mimeType: string; audioBase64: string }>(
        '/admin/tts-config/test',
        { method: 'POST' },
        session.accessToken,
      );
      const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
      testAudioRef.current?.pause();
      if (testAudioUrlRef.current) URL.revokeObjectURL(testAudioUrlRef.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      testAudioUrlRef.current = url;
      const audio = new Audio(url);
      testAudioRef.current = audio;
      const releaseAudio = () => {
        if (testAudioUrlRef.current === url) {
          URL.revokeObjectURL(url);
          testAudioUrlRef.current = null;
        }
        if (testAudioRef.current === audio) testAudioRef.current = null;
      };
      audio.onended = releaseAudio;
      audio.onerror = releaseAudio;
      try {
        await audio.play();
        setNotice('连接与短样音生成成功，正在播放测试音频。');
      } catch {
        releaseAudio();
        setNotice('连接与短样音生成成功；浏览器未能自动播放，请检查浏览器播放权限。');
      }
    } catch (reason) {
      setError(userFacingError(reason, '连接测试失败'));
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="tts-settings-title">
      <header className={styles.header}>
        <div className={styles.title}>
          <Volume2 aria-hidden="true" size={21} />
          <div>
            <h3 id="tts-settings-title">MiniMax 按需语音</h3>
            <p>只有用户主动播放并确认后，系统才会向语音服务发送该文本。</p>
          </div>
        </div>
        <label className={styles.switchRow}>
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={loading || saving || !configLoaded}
            onChange={(event) => update('enabled', event.target.checked)}
          />
          启用
        </label>
      </header>

      <p className={styles.warning}>
        首次生成会把英文文本发送给
        MiniMax，可能产生费用。关闭后用户仍可使用浏览器本地朗读。测试连接只发送一条固定短句，也可能产生费用；不会自动重试。
      </p>

      {loading ? (
        <p role="status">正在读取语音设置…</p>
      ) : (
        <div className={styles.grid}>
          <label>
            服务区域
            <select
              value={config.region ?? ''}
              disabled={saving || !configLoaded}
              onChange={(event) => update('region', (event.target.value || null) as Region | null)}
            >
              <option value="">请选择</option>
              <option value="CHINA">中国区（api.minimaxi.com）</option>
              <option value="GLOBAL">国际区（api.minimax.io）</option>
            </select>
          </label>
          <label>
            模型
            <input
              value={config.model}
              maxLength={100}
              disabled={saving || !configLoaded}
              onChange={(event) => update('model', event.target.value)}
            />
          </label>
          <label className={styles.wide}>
            音色 ID
            <input
              value={config.voiceId ?? ''}
              maxLength={200}
              disabled={saving || !configLoaded}
              onChange={(event) => update('voiceId', event.target.value || null)}
            />
            <small>
              English_captivating_female1 是你提供的示例值；本系统未实测此账号和音色的兼容性。
            </small>
          </label>
          <label>
            语速（0.5–2）
            <input
              type="number"
              min="0.5"
              max="2"
              step="0.1"
              value={config.speed}
              disabled={saving || !configLoaded}
              onChange={(event) => update('speed', Number(event.target.value))}
            />
          </label>
          <label>
            音量（0.1–10）
            <input
              type="number"
              min="0.1"
              max="10"
              step="0.1"
              value={config.volume}
              disabled={saving || !configLoaded}
              onChange={(event) => update('volume', Number(event.target.value))}
            />
          </label>
          <label>
            音调（-12–12）
            <input
              type="number"
              min="-12"
              max="12"
              step="1"
              value={config.pitch}
              disabled={saving || !configLoaded}
              onChange={(event) => update('pitch', Number(event.target.value))}
            />
          </label>
          <label>
            每账号每日生成上限（1–100 次）
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={config.maxGenerationsPerUserPerDay}
              disabled={saving || !configLoaded}
              onChange={(event) =>
                update('maxGenerationsPerUserPerDay', Number(event.target.value))
              }
            />
          </label>
          <label className={styles.wide}>
            MiniMax API Key
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              maxLength={1000}
              disabled={saving || !configLoaded}
              onChange={(event) => {
                setApiKey(event.target.value);
                if (event.target.value) setClearApiKey(false);
              }}
              placeholder={config.hasApiKey ? '已配置；留空则保持不变' : '输入后仅加密保存'}
            />
            <small>
              {config.hasApiKey ? '密钥不会再次显示。' : '密钥使用服务端配置的加密密钥加密保存。'}
            </small>
          </label>
          {config.hasApiKey && (
            <label className={styles.clearKey}>
              <input
                type="checkbox"
                checked={clearApiKey}
                disabled={saving || !configLoaded}
                onChange={(event) => setClearApiKey(event.target.checked)}
              />
              保存时清除已保存的 API Key
            </label>
          )}
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving || !configLoaded}
        >
          {saving && <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />}
          {saving ? '保存中…' : '保存设置'}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void testConnection()}
          disabled={
            loading || saving || testing || !configLoaded || !config.hasApiKey || !config.region
          }
          aria-describedby="tts-test-warning"
        >
          {testing && <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />}
          {testing ? '正在测试…' : '测试连接'}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading || saving || testing}
        >
          重新加载
        </button>
      </div>
      <p className={styles.note} id="tts-test-warning">
        测试会使用已保存配置、发送固定短句并计入每日上限；用户请求还受每账号 20,000
        字符/日上限约束。个人音频缓存最多 256 MB，90
        天未播放会清理；缓存丢失后只在用户再次确认播放时重新生成。
      </p>
      {notice && (
        <p className={styles.success} role="status">
          <CheckCircle2 size={17} aria-hidden="true" /> {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
