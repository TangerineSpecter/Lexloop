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
let refreshInFlight: Promise<string | null> | null = null;

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
  if (status === 401) {
    return isAccessTokenExpired(status, body)
      ? '登录状态已过期，请重新登录后继续。'
      : message || '当前账号无法访问此内容，请检查登录状态后重试。';
  }
  if (status === 403) return '当前账号没有执行此操作的权限。';
  if (status === 404) return '要访问的内容不存在，可能已被移除。';
  if (status === 408 || status === 429) return message || '请求较多或服务繁忙，请稍后再试。';
  if (status >= 500)
    return message && /^[\u3400-\u9fff]/.test(message) ? message : '服务暂时不可用，请稍后再试。';
  return message || fallback;
}

async function errorResponseBody(response: Response) {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {};
  }
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
async function authorizedResponse(path: string, init: RequestInit, token?: string) {
  let requestToken = currentSessionToken(token);
  let response = await sendRequest(path, init, requestToken);
  let body: unknown;
  if (!response.ok) {
    body = await errorResponseBody(response);
    const canRefresh =
      Boolean(requestToken) &&
      response.status === 401 &&
      isAccessTokenExpired(response.status, body) &&
      path !== '/auth/me' &&
      path !== '/auth/refresh' &&
      !init.signal?.aborted &&
      (init.body === undefined || typeof init.body === 'string');
    if (canRefresh) {
      const nextToken = await refreshExpiredSession(requestToken!);
      if (nextToken && !init.signal?.aborted && tokenBelongsToCurrentSession(nextToken)) {
        requestToken = nextToken;
        response = await sendRequest(path, init, requestToken);
        if (!response.ok) body = await errorResponseBody(response);
      }
    }
  }
  if (!response.ok) {
    throw new ApiRequestError(
      responseMessage(response.status, body, '请求失败，请稍后重试'),
      response.status,
    );
  }
  return response;
}

export async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await authorizedResponse(path, init, token);
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isTypeError(error)) throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
    throw error;
  }
}

export async function requestBlob(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Blob> {
  const response = await authorizedResponse(path, init, token);
  try {
    return await response.blob();
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isTypeError(error)) throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
    throw error;
  }
}

async function sendRequest(path: string, init: RequestInit, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    return await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
  }
}

async function refreshExpiredSession(expiredToken: string): Promise<string | null> {
  const expiredUserId = tokenSubject(expiredToken);
  const saved = safeReadSession();
  if (!expiredUserId || !saved || saved.user.id !== expiredUserId) return null;
  if (saved.accessToken !== expiredToken) return saved.accessToken;
  if (refreshInFlight) {
    const refreshedToken = await refreshInFlight;
    const latest = safeReadSession();
    return latest?.user.id === expiredUserId && latest.accessToken === refreshedToken
      ? refreshedToken
      : null;
  }

  const refresh = async () => {
    const run = async () => {
      const current = safeReadSession();
      if (!current || current.user.id !== expiredUserId) return null;
      if (current.accessToken !== expiredToken) return current.accessToken;
      try {
        const next = await request<Session>('/auth/refresh', { method: 'POST' });
        const latest = safeReadSession();
        if (!latest || latest.user.id !== expiredUserId || next.user.id !== expiredUserId) {
          return null;
        }
        if (latest.accessToken !== expiredToken) return latest.accessToken;
        saveSession(next);
        return next.accessToken;
      } catch {
        return null;
      }
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request('lexloop-access-token-refresh', run);
      }
      return await run();
    } catch {
      return null;
    }
  };

  refreshInFlight = refresh().finally(() => {
    refreshInFlight = null;
  });
  const refreshedToken = await refreshInFlight;
  const latest = safeReadSession();
  return latest?.user.id === expiredUserId && latest.accessToken === refreshedToken
    ? refreshedToken
    : null;
}

function currentSessionToken(token?: string): string | undefined {
  if (!token) return undefined;
  const saved = safeReadSession();
  return saved && tokenSubject(token) === saved.user.id ? saved.accessToken : token;
}

function tokenBelongsToCurrentSession(token: string): boolean {
  const saved = safeReadSession();
  return Boolean(saved && tokenSubject(token) === saved.user.id);
}

function safeReadSession(): Session | null {
  try {
    const raw = localStorage.getItem('lexloop.session');
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('accessToken' in value) ||
      typeof value.accessToken !== 'string' ||
      !('user' in value) ||
      typeof value.user !== 'object' ||
      value.user === null ||
      !('id' in value.user) ||
      typeof value.user.id !== 'string'
    ) {
      return null;
    }
    return value as Session;
  } catch {
    return null;
  }
}

function tokenSubject(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const value: unknown = JSON.parse(decoded);
    return typeof value === 'object' &&
      value !== null &&
      'sub' in value &&
      typeof value.sub === 'string'
      ? value.sub
      : null;
  } catch {
    return null;
  }
}

function isAccessTokenExpired(status: number, body: unknown): boolean {
  if (status !== 401) return false;
  const raw =
    typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message?: unknown }).message
      : undefined;
  const message = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string').join('；')
    : typeof raw === 'string'
      ? raw
      : '';
  return (
    message === '访问令牌无效或已过期' || message === '缺少访问令牌' || message === 'Unauthorized'
  );
}

export async function streamSse(
  path: string,
  init: RequestInit,
  token: string,
  onEvent: (event: string, data: unknown) => void,
) {
  let requestToken = currentSessionToken(token) ?? token;
  let response = await sendStreamRequest(path, init, requestToken);
  if (!response.ok) {
    const body = await errorResponseBody(response);
    const canRefresh =
      response.status === 401 &&
      isAccessTokenExpired(response.status, body) &&
      path !== '/auth/me' &&
      path !== '/auth/refresh' &&
      !init.signal?.aborted &&
      (init.body === undefined || typeof init.body === 'string');
    if (canRefresh) {
      const nextToken = await refreshExpiredSession(requestToken);
      if (nextToken && !init.signal?.aborted && tokenBelongsToCurrentSession(nextToken)) {
        requestToken = nextToken;
        response = await sendStreamRequest(path, init, requestToken);
        if (!response.ok) {
          const retryBody = await errorResponseBody(response);
          throw new ApiRequestError(
            responseMessage(response.status, retryBody, '助手请求失败，请稍后重试。'),
            response.status,
          );
        }
      } else {
        throw new ApiRequestError(
          responseMessage(response.status, body, '助手请求失败，请稍后重试。'),
          response.status,
        );
      }
    } else {
      throw new ApiRequestError(
        responseMessage(response.status, body, '助手请求失败，请稍后重试。'),
        response.status,
      );
    }
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

async function sendStreamRequest(path: string, init: RequestInit, token: string) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  try {
    return await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
  }
}
