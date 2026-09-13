const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:52101/api/v1';

export type Session = { accessToken: string; user: { id: string; email: string; displayName: string | null; role: 'USER' | 'ADMIN' } };
export function saveSession(session: Session) { localStorage.setItem('lexloop.session', JSON.stringify(session)); }
export function readSession(): Session | null { const raw = localStorage.getItem('lexloop.session'); return raw ? JSON.parse(raw) as Session : null; }
export function clearSession() { localStorage.removeItem('lexloop.session'); }
export function refreshSession() { return request<Session>('/auth/refresh', { method: 'POST' }); }
export async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  } catch {
    throw new Error('请求未能完成，请检查 API 服务或跨域配置。');
  }
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message ?? '请求失败，请稍后重试'); }
  return response.json() as Promise<T>;
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
  const response = await fetch(`${API_URL}${path}`, { ...init, credentials: 'include', headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? 'AI 助手请求失败');
  }
  if (!response.body) throw new Error('AI 助手没有返回内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
}
