'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { request, type Session } from '../lib/api';

function StudySettingsDrawer({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="study-drawer-layer">
      <button className="study-drawer-scrim" aria-label="关闭设置" onClick={onClose} />
      <aside className="study-settings-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="关闭">
            <X size={22} />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

type AvailableAiModel = {
  id: string;
  displayName: string;
  provider: 'DEEPSEEK' | 'OPENAI_COMPATIBLE';
  model: string;
  isSelected: boolean;
};

export function ReadingModelDrawer({
  session,
  onClose,
  onModelSelected,
}: {
  session: Session;
  onClose: () => void;
  onModelSelected?: () => void;
}) {
  const [models, setModels] = useState<AvailableAiModel[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const activeToken = useRef(session.accessToken);

  useEffect(() => {
    let cancelled = false;
    activeToken.current = session.accessToken;
    setLoading(true);
    setModels([]);
    setBusyId(undefined);
    setMessage('');
    request<AvailableAiModel[]>('/ai/models', {}, session.accessToken)
      .then((result) => {
        if (cancelled) return;
        setModels(result);
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : '模型加载失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  const select = async (id: string) => {
    const requestToken = session.accessToken;
    setBusyId(id);
    setMessage('');
    try {
      await request(`/ai/models/${id}/select`, { method: 'PATCH' }, requestToken);
      if (activeToken.current !== requestToken) return;
      setModels((items) => items.map((item) => ({ ...item, isSelected: item.id === id })));
      onModelSelected?.();
    } catch (error) {
      if (activeToken.current !== requestToken) return;
      setMessage(error instanceof Error ? error.message : '模型切换失败');
    } finally {
      if (activeToken.current === requestToken) setBusyId(undefined);
    }
  };

  return (
    <StudySettingsDrawer title="阅读材料模型" onClose={onClose}>
      {loading && (
        <p className="book-message" role="status">
          正在加载可用模型…
        </p>
      )}
      {message && (
        <p className="book-message" role="alert">
          {message}
        </p>
      )}
      {!loading && !message && !models.length && (
        <div className="model-options-empty">
          <Sparkles size={27} />
          <strong>暂时没有可用模型</strong>
          <p>请联系管理员在系统设置中添加并启用模型。</p>
        </div>
      )}
      <div className="model-options">
        {models.map((item) => (
          <button
            key={item.id}
            className={`model-option ${item.isSelected ? 'is-active' : ''}`}
            onClick={() => void select(item.id)}
            disabled={busyId === item.id}
          >
            <span className="model-icon">
              <Sparkles size={24} />
            </span>
            <span>
              <strong>{item.displayName}</strong>
              <small>
                {item.isSelected
                  ? '当前生效模型'
                  : `${item.provider === 'DEEPSEEK' ? 'DeepSeek' : 'OpenAI 兼容'} · ${item.model}`}
              </small>
            </span>
            {item.isSelected && <Check size={24} />}
          </button>
        ))}
      </div>
    </StudySettingsDrawer>
  );
}
