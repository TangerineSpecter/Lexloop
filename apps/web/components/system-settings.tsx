'use client';

import { StyledSelect } from './styled-select';

import {
  AlertTriangle,
  Bot,
  ChevronDown,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  PlugZap,
  Settings2,
  Pencil,
  Plus,
  Trash2,
  X,
  Volume2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { request, type Session } from '../lib/api';
import { Tooltip } from './tooltip';
import { SystemBackupPanel } from './system-backup/system-backup-panel';
import { DailySentenceSettings } from './daily-sentence/daily-sentence-settings';
import { AutomaticStudyPlanSettings } from './automatic-study-plan-settings';
import { TtsSettings } from './tts-settings';

type AiModel = {
  id: string;
  displayName: string;
  provider: 'DEEPSEEK' | 'MINIMAX' | 'OPENAI_COMPATIBLE';
  model: string;
  baseUrl: string;
  temperature?: number | null;
  isEnabled: boolean;
  hasApiKey: boolean;
};

type ModelConnectionTestResult = {
  success: boolean;
  endpoint: 'responded' | 'unreachable';
  authentication: 'accepted' | 'rejected' | 'unknown';
  selectedModel: 'accepted' | 'unknown';
  structuredGeneration: 'passed' | 'failed' | 'not_run';
  upstreamStatus?: number;
  code?: string;
  param?: string;
  reason: string;
};

type ModelTestState =
  | { state: 'loading' }
  | { state: 'done'; result: ModelConnectionTestResult }
  | { state: 'error'; message: string };

const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-flash', label: 'Flash' },
  { value: 'deepseek-v4-pro', label: 'Pro' },
] as const;

export function SystemSettings({ session }: { session: Session }) {
  const [tab, setTab] = useState<'models' | 'features' | 'backups' | 'tts'>('models');
  const [models, setModels] = useState<AiModel[]>([]);
  const [modal, setModal] = useState<AiModel | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiModel | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [message, setMessage] = useState('');
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [modelTestStates, setModelTestStates] = useState<Record<string, ModelTestState>>({});
  const load = () =>
    request<AiModel[]>('/admin/ai-models', {}, session.accessToken)
      .then(setModels)
      .catch((error) => setMessage(error instanceof Error ? error.message : '模型加载失败'));
  useEffect(() => {
    void load();
  }, [session.accessToken]);
  const toggle = async (model: AiModel) => {
    try {
      const updated = await request<AiModel>(
        `/admin/ai-models/${model.id}/enabled`,
        { method: 'PATCH', body: JSON.stringify({ isEnabled: !model.isEnabled }) },
        session.accessToken,
      );
      setModels((items) => items.map((item) => (item.id === model.id ? updated : item)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '状态更新失败');
    }
  };
  const remove = async (model: AiModel) => {
    try {
      setDeleting(true);
      setDeleteError('');
      await request(`/admin/ai-models/${model.id}`, { method: 'DELETE' }, session.accessToken);
      setModels((items) => items.filter((item) => item.id !== model.id));
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };
  const testModel = async (model: AiModel) => {
    if (testingModelId || !model.hasApiKey) return;
    setTestingModelId(model.id);
    setModelTestStates((states) => ({ ...states, [model.id]: { state: 'loading' } }));
    try {
      const result = await request<ModelConnectionTestResult>(
        `/admin/ai-models/${model.id}/test`,
        { method: 'POST' },
        session.accessToken,
      );
      setModelTestStates((states) => ({ ...states, [model.id]: { state: 'done', result } }));
    } catch (error) {
      setModelTestStates((states) => ({
        ...states,
        [model.id]: {
          state: 'error',
          message: error instanceof Error ? error.message : '测试请求未完成，请稍后重试。',
        },
      }));
    } finally {
      setTestingModelId(null);
    }
  };
  return (
    <section className="system-settings">
      <h2>系统设置</h2>
      <div className="system-tabs" role="tablist">
        <button
          className={tab === 'backups' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'backups'}
          onClick={() => setTab('backups')}
        >
          <Settings2 size={18} />
          远端备份
        </button>
        <button
          className={tab === 'features' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'features'}
          onClick={() => setTab('features')}
        >
          <Settings2 size={18} />
          功能开关
        </button>
        <button
          className={tab === 'tts' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'tts'}
          onClick={() => setTab('tts')}
        >
          <Volume2 size={18} />
          语音合成
        </button>
        <button
          className={tab === 'models' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'models'}
          onClick={() => setTab('models')}
        >
          <Bot size={18} />
          AI 模型管理
        </button>
      </div>
      {tab === 'backups' ? (
        <SystemBackupPanel session={session} />
      ) : tab === 'features' ? (
        <>
          <DailySentenceSettings session={session} />
          <AutomaticStudyPlanSettings session={session} />
        </>
      ) : tab === 'tts' ? (
        <TtsSettings session={session} />
      ) : (
        <>
          <div className="model-head">
            <div>
              <h3>
                已配置模型 <b>{models.length}</b>
              </h3>
              <p>添加后默认启用；学习助手会使用最早添加的启用模型。</p>
            </div>
            <Tooltip label="添加模型">
              <button onClick={() => setModal('new')}>
                <Plus size={18} />
                添加模型
              </button>
            </Tooltip>
          </div>
          {message && (
            <p className="form-error model-message" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              {message}
            </p>
          )}
          {models.length ? (
            <>
              <p className="model-test-warning" id="model-test-warning">
                测试仅使用已保存配置，会向对应模型发送一次简短生成请求，可能产生费用；不会保存或修改配置，也不会自动重试。
              </p>
              <div className="model-list">
                {models.map((model) => (
                  <article key={model.id}>
                    <div className="model-provider-mark">
                      {model.provider === 'DEEPSEEK'
                        ? 'DS'
                        : model.provider === 'MINIMAX'
                          ? 'MM'
                          : 'AI'}
                    </div>
                    <div className="model-copy">
                      <strong>{model.displayName}</strong>
                      <span>
                        {model.provider === 'DEEPSEEK'
                          ? 'DeepSeek'
                          : model.provider === 'MINIMAX'
                            ? 'MiniMax'
                            : '自定义 OpenAI'}{' '}
                        · {model.model}
                      </span>
                      <small>{model.baseUrl}</small>
                    </div>
                    <Tooltip label={model.isEnabled ? '点击关闭模型' : '点击启用模型'}>
                      <button
                        type="button"
                        className={`model-status ${model.isEnabled ? 'enabled' : ''}`}
                        onClick={() => void toggle(model)}
                        aria-label={`${model.isEnabled ? '关闭' : '启用'} ${model.displayName}`}
                      >
                        {model.isEnabled ? '已启用' : '已关闭'}
                      </button>
                    </Tooltip>
                    <Tooltip
                      label={model.hasApiKey ? '测试已保存的模型配置' : '请先为该模型配置 API Key'}
                    >
                      <button
                        type="button"
                        className="model-test-button"
                        onClick={() => void testModel(model)}
                        disabled={!model.hasApiKey || testingModelId !== null}
                        aria-describedby="model-test-warning"
                        aria-label={`测试 ${model.displayName} 的连接`}
                      >
                        {testingModelId === model.id ? (
                          <LoaderCircle
                            size={16}
                            className="model-test-spinner"
                            aria-hidden="true"
                          />
                        ) : (
                          <PlugZap size={16} aria-hidden="true" />
                        )}
                        {testingModelId === model.id ? '正在测试…' : '测试连接'}
                      </button>
                    </Tooltip>
                    <Tooltip label="编辑模型">
                      <button
                        className="model-icon-button model-edit-button"
                        disabled={testingModelId === model.id}
                        onClick={() => setModal(model)}
                        aria-label={`编辑 ${model.displayName}`}
                      >
                        <Pencil size={17} />
                      </button>
                    </Tooltip>
                    <Tooltip label="删除模型">
                      <button
                        className="model-icon-button model-delete-button danger"
                        disabled={testingModelId === model.id}
                        onClick={() => {
                          setDeleteError('');
                          setDeleteTarget(model);
                        }}
                        aria-label={`删除 ${model.displayName}`}
                      >
                        <Trash2 size={17} />
                      </button>
                    </Tooltip>
                    {modelTestStates[model.id] && (
                      <ModelTestFeedback testState={modelTestStates[model.id]} />
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="model-empty">
              <Bot size={28} />
              <strong>还没有配置模型</strong>
              <p>添加 DeepSeek 或兼容 OpenAI Chat Completions 的模型开始使用。</p>
            </div>
          )}
          {modal && (
            <AiModelDialog
              session={session}
              model={modal === 'new' ? null : modal}
              onClose={() => setModal(null)}
              onSaved={(model) => {
                setModels((items) =>
                  items.some((item) => item.id === model.id)
                    ? items.map((item) => (item.id === model.id ? model : item))
                    : [...items, model],
                );
                setModal(null);
              }}
            />
          )}
          {deleteTarget && (
            <ModelDeleteDialog
              model={deleteTarget}
              busy={deleting}
              error={deleteError}
              onCancel={() => {
                setDeleteError('');
                setDeleteTarget(null);
              }}
              onConfirm={() => void remove(deleteTarget)}
            />
          )}
        </>
      )}
    </section>
  );
}

function ModelTestFeedback({ testState }: { testState: ModelTestState }) {
  if (testState.state === 'loading') {
    return (
      <div className="model-test-result pending" role="status" aria-live="polite">
        <LoaderCircle size={17} className="model-test-spinner" aria-hidden="true" />
        正在等待一次模型响应；不会自动重试。
      </div>
    );
  }
  if (testState.state === 'error') {
    return (
      <div className="model-test-result failed" role="alert">
        <CircleAlert size={18} aria-hidden="true" />
        <p>{testState.message}</p>
      </div>
    );
  }

  const { result } = testState;
  return (
    <div
      className={`model-test-result ${result.success ? 'passed' : 'failed'}`}
      role={result.success ? 'status' : 'alert'}
      aria-live="polite"
    >
      {result.success ? (
        <CheckCircle2 size={18} aria-hidden="true" />
      ) : (
        <CircleAlert size={18} aria-hidden="true" />
      )}
      <div className="model-test-result-copy">
        <strong>{result.success ? '本次结构化生成测试通过' : '本次测试未通过'}</strong>
        <dl>
          <div>
            <dt>接口响应</dt>
            <dd>{result.endpoint === 'responded' ? '已响应' : '未收到响应'}</dd>
          </div>
          <div>
            <dt>认证</dt>
            <dd>
              {result.authentication === 'accepted'
                ? '已接受'
                : result.authentication === 'rejected'
                  ? '被拒绝'
                  : '未确认'}
            </dd>
          </div>
          <div>
            <dt>所选模型</dt>
            <dd>{result.selectedModel === 'accepted' ? '已接受请求' : '未确认'}</dd>
          </div>
          <div>
            <dt>结构化生成</dt>
            <dd>
              {result.structuredGeneration === 'passed'
                ? '通过'
                : result.structuredGeneration === 'failed'
                  ? '未通过'
                  : '未执行'}
            </dd>
          </div>
          {result.upstreamStatus !== undefined && (
            <div>
              <dt>上游状态</dt>
              <dd>HTTP {result.upstreamStatus}</dd>
            </div>
          )}
          {result.code && (
            <div>
              <dt>code</dt>
              <dd>{result.code}</dd>
            </div>
          )}
          {result.param && (
            <div>
              <dt>param</dt>
              <dd>{result.param}</dd>
            </div>
          )}
        </dl>
        <p>{result.reason}</p>
      </div>
    </div>
  );
}

function ModelDeleteDialog({
  model,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  model: AiModel;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="learning-clear-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-delete-title"
    >
      <button
        className="learning-clear-scrim"
        aria-label="取消删除"
        onClick={() => !busy && onCancel()}
      />
      <section className="learning-clear-dialog model-delete-dialog">
        <span className="learning-clear-icon">
          <AlertTriangle size={29} />
        </span>
        <h2 id="model-delete-title">确认删除「{model.displayName}」？</h2>
        <div>
          <strong>仅移除这条模型配置</strong>
          <span>
            不会影响学习记录、词书或账户数据；使用该模型的用户下次使用时可选择其他可用模型。
          </span>
          <small>模型 ID：{model.model}</small>
        </div>
        {error && (
          <p className="form-error model-message" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="confirm-danger" disabled={busy} onClick={onConfirm}>
            <Trash2 size={17} />
            {busy ? '正在删除…' : '确认删除模型'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AiModelDialog({
  session,
  model,
  onClose,
  onSaved,
}: {
  session: Session;
  model: AiModel | null;
  onClose: () => void;
  onSaved: (model: AiModel) => void;
}) {
  const [provider, setProvider] = useState<AiModel['provider']>(model?.provider ?? 'DEEPSEEK');
  const [displayName, setDisplayName] = useState(model?.displayName ?? '');
  const [modelName, setModelName] = useState(model?.model ?? 'deepseek-v4-flash');
  const [baseUrl, setBaseUrl] = useState(
    model?.provider === 'OPENAI_COMPATIBLE' ? model.baseUrl : '',
  );
  const [temperature, setTemperature] = useState(
    model?.temperature == null ? '' : String(model.temperature),
  );
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !displayName.trim() ||
      !modelName.trim() ||
      (!model && !apiKey.trim()) ||
      (provider === 'OPENAI_COMPATIBLE' && !baseUrl.trim())
    )
      return setMessage('请填写所有必填项。');
    const temperatureValue = temperature.trim() ? Number(temperature) : null;
    if (
      temperatureValue !== null &&
      (!Number.isFinite(temperatureValue) || temperatureValue < 0 || temperatureValue > 2)
    ) {
      return setMessage('温度请填写 0 到 2 之间的数字；留空则使用默认策略。');
    }
    setBusy(true);
    setMessage('');
    try {
      const payload = {
        displayName,
        provider,
        model: modelName,
        temperature: temperatureValue,
        ...(provider === 'OPENAI_COMPATIBLE' ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
      };
      const result = await request<AiModel>(
        model ? `/admin/ai-models/${model.id}` : '/admin/ai-models',
        { method: model ? 'PUT' : 'POST', body: JSON.stringify(payload) },
        session.accessToken,
      );
      onSaved(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  const selectedModel =
    DEEPSEEK_MODELS.find(({ value }) => value === modelName) ?? DEEPSEEK_MODELS[0];
  return (
    <div
      className="model-dialog-layer"
      role="dialog"
      aria-modal="true"
      aria-label={model ? '编辑模型' : '添加模型'}
    >
      <button className="model-dialog-scrim" aria-label="关闭" onClick={onClose} />
      <form className="model-dialog" onSubmit={submit}>
        <header>
          <div>
            <p>AI MODEL</p>
            <h2>{model ? '编辑模型' : '添加模型'}</h2>
          </div>
          <Tooltip label="关闭弹窗">
            <button type="button" onClick={onClose} aria-label="关闭">
              <X size={22} />
            </button>
          </Tooltip>
        </header>
        <label>
          模型提供方
          <StyledSelect
            label="模型提供方"
            value={provider}
            options={[
              { value: 'DEEPSEEK', label: 'DeepSeek' },
              { value: 'MINIMAX', label: 'MiniMax' },
              { value: 'OPENAI_COMPATIBLE', label: '自定义 OpenAI' },
            ]}
            onChange={(value) => {
              const next = value as AiModel['provider'];
              setProvider(next);
              setModelPickerOpen(false);
              if (next === model?.provider) setModelName(model.model);
              else if (next === 'MINIMAX') setModelName('MiniMax-M3.1-Flash');
              else if (next === 'DEEPSEEK') setModelName('deepseek-v4-flash');
            }}
          />
        </label>
        <label>
          模型展示名称
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="例如：主学习助手"
            autoFocus
          />
        </label>
        <label>
          模型 ID
          {provider === 'MINIMAX' ? (
            <StyledSelect
              label="MiniMax 模型"
              value={modelName}
              onChange={setModelName}
              options={[
                { value: 'MiniMax-M3.1-Flash', label: 'MiniMax-M3.1-Flash' },
                { value: 'MiniMax-M3', label: 'MiniMax-M3' },
              ]}
            />
          ) : provider === 'DEEPSEEK' ? (
            <div className="model-picker">
              <Tooltip label="选择模型版本">
                <button
                  type="button"
                  className="model-picker-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={modelPickerOpen}
                  onClick={() => setModelPickerOpen((open) => !open)}
                >
                  <span>
                    <strong>DeepSeek {selectedModel.label}</strong>
                    <small>{selectedModel.value}</small>
                  </span>
                  <ChevronDown size={20} aria-hidden="true" />
                </button>
              </Tooltip>
              {modelPickerOpen && (
                <div
                  className="model-picker-options"
                  role="listbox"
                  aria-label="选择 DeepSeek 模型"
                >
                  {DEEPSEEK_MODELS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      role="option"
                      aria-selected={modelName === value}
                      className={modelName === value ? 'selected' : ''}
                      onClick={() => {
                        setModelName(value);
                        setModelPickerOpen(false);
                      }}
                    >
                      <span>DeepSeek {label}</span>
                      <small>{value}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <input
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              placeholder="例如：gpt-4o-mini"
            />
          )}
        </label>
        {provider === 'OPENAI_COMPATIBLE' && (
          <label>
            API 地址
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
            <small>
              填写兼容接口根地址（如 https://4sapi.org/v1）；系统会在末尾请求 /chat/completions。
            </small>
          </label>
        )}
        <label>
          API 密钥{model?.hasApiKey && <small>留空则保持当前密钥</small>}
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={model?.hasApiKey ? '已配置' : '输入 API 密钥'}
            autoComplete="off"
          />
        </label>
        {provider === 'MINIMAX' && <p>使用 MiniMax 中国站。当前模型不支持调整温度。</p>}
        {provider !== 'MINIMAX' && (
          <label>
            温度（可选）
            <input
              type="number"
              min="0"
              max="2"
              step="any"
              inputMode="decimal"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
              aria-describedby="model-temperature-help"
              placeholder="留空使用默认策略"
            />
            <small id="model-temperature-help">
              留空时，自定义 OpenAI 不发送 temperature，由供应商使用默认值；DeepSeek
              保持现有功能默认值。填写后会覆盖该模型各功能的温度（0–2），具体支持范围请以供应商文档为准。
            </small>
          </label>
        )}
        {message && (
          <p className="form-error model-message" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            {message}
          </p>
        )}
        <footer>
          <Tooltip label="不保存并关闭">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
          </Tooltip>
          <Tooltip label={model ? '保存修改' : '添加模型'}>
            <button disabled={busy}>{busy ? '保存中…' : model ? '保存修改' : '添加模型'}</button>
          </Tooltip>
        </footer>
      </form>
    </div>
  );
}
