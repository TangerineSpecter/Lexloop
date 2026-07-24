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
