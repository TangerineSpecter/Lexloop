const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

export type Session = {
  accessToken: string;
  user: { id: string; email: string; displayName: string | null; role: 'USER' | 'ADMIN' };
};
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const NETWORK_ERROR_MESSAGE = '暂时无法连接学习服务，请检查网络或稍后重试。';

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function isTypeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'TypeError'
  );
}

function responseMessage(status: number, body: unknown, fallback: string) {
  const raw =
    typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message?: unknown }).message
      : undefined;
  const message = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string').join('；')
    : typeof raw === 'string'
      ? raw
      : '';
  if (status === 401) return '登录状态已过期，请重新登录后继续。';
  if (status === 403) return '当前账号没有执行此操作的权限。';
  if (status === 404) return '要访问的内容不存在，可能已被移除。';
  if (status === 408 || status === 429) return message || '请求较多或服务繁忙，请稍后再试。';
  if (status >= 500)
    return message && /^[\u3400-\u9fff]/.test(message) ? message : '服务暂时不可用，请稍后再试。';
  return message || fallback;
}

export function userFacingError(error: unknown, fallback = '操作未完成，请稍后再试。') {
  return error instanceof Error && error.message ? error.message : fallback;
}
export function saveSession(session: Session) {
  localStorage.setItem('lexloop.session', JSON.stringify(session));
}
export function readSession(): Session | null {
  const raw = localStorage.getItem('lexloop.session');
  return raw ? (JSON.parse(raw) as Session) : null;
}
export function clearSession() {
  localStorage.removeItem('lexloop.session');
}
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
export function refreshSession() {
  return request<Session>('/auth/refresh', { method: 'POST' });
}
export async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiRequestError(
      responseMessage(response.status, body, '请求失败，请稍后重试'),
      response.status,
    );
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isTypeError(error)) throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
    throw error;
  }
}

export async function streamSse(
  path: string,
  init: RequestInit,
  token: string,
  onEvent: (event: string, data: unknown) => void,
) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiRequestError(
      responseMessage(response.status, body, '助手请求失败，请稍后重试。'),
      response.status,
    );
  }
  if (!response.body) throw new Error('AI 助手没有返回内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) onEvent(event, JSON.parse(data));
      }
      if (done) break;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError('助手连接中断了，请稍后重试。', 0);
  } finally {
    if (init.signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
