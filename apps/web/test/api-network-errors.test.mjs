import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../lib/api.ts', import.meta.url), 'utf8');
const module = { exports: {} };
const sandbox = {
  module,
  exports: module.exports,
  process: { env: {} },
  Headers,
  Response,
  AbortController,
  DOMException,
  TextDecoder,
  atob,
  fetch: globalThis.fetch,
};
const compiled = ts.transpile(source, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
});
runInNewContext(compiled, sandbox);
const { request, streamSse } = module.exports;
const networkErrorMessage = '暂时无法连接学习服务，请检查网络或稍后重试。';
const userId = 'refresh-user-1';
const oldToken = makeToken(userId, 'old');
const newToken = makeToken(userId, 'new');

function isNetworkError(error) {
  return (
    error.name === 'ApiRequestError' && error.status === 0 && error.message === networkErrorMessage
  );
}

test('ordinary API connection failures give network recovery guidance', async () => {
  sandbox.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  await assert.rejects(request('/learning/history'), isNetworkError);
});

test('API response body interruptions use network recovery guidance too', async () => {
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new TypeError('The response body stream was interrupted');
    },
  });

  await assert.rejects(request('/learning/history'), isNetworkError);
});

test('API request cancellation remains an AbortError instead of an offline error', async () => {
  const controller = new AbortController();
  const abortError = new DOMException('The request was aborted', 'AbortError');
  sandbox.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError), { once: true });
    });

  const pending = request('/learning/history', { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, (error) => error === abortError);
});

test('API error responses preserve cancellation while their response body is read', async () => {
  const controller = new AbortController();
  const abortError = new DOMException('The response body read was aborted', 'AbortError');
  let markBodyReadStarted;
  const bodyReadStarted = new Promise((resolve) => {
    markBodyReadStarted = resolve;
  });
  sandbox.fetch = async () => ({
    ok: false,
    status: 503,
    json: () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(abortError), { once: true });
        markBodyReadStarted();
      }),
  });

  const pending = request('/learning/history', { signal: controller.signal });
  await bodyReadStarted;
  controller.abort();

  await assert.rejects(pending, (error) => error === abortError);
});

test('streamed API connection failures use the same network recovery guidance', async () => {
  sandbox.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  await assert.rejects(
    streamSse('/ai/tutor/messages', { method: 'POST' }, 'fixture-token', () => {}),
    isNetworkError,
  );
});

test('stream cancellation remains an AbortError after response headers arrive', async () => {
  const controller = new AbortController();
  const abortError = new DOMException('The stream was aborted', 'AbortError');
  const body = new ReadableStream({
    start(stream) {
      controller.signal.addEventListener('abort', () => stream.error(abortError), {
        once: true,
      });
    },
  });
  sandbox.fetch = async () => new Response(body);

  const pending = streamSse(
    '/ai/tutor/messages',
    { method: 'POST', signal: controller.signal },
    'fixture-token',
    () => {},
  );
  controller.abort();

  await assert.rejects(pending, (error) => error === abortError);
});

test('stream error responses preserve cancellation while their response body is read', async () => {
  const controller = new AbortController();
  const abortError = new DOMException('The error response read was aborted', 'AbortError');
  let markBodyReadStarted;
  const bodyReadStarted = new Promise((resolve) => {
    markBodyReadStarted = resolve;
  });
  sandbox.fetch = async () => ({
    ok: false,
    status: 503,
    json: () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(abortError), { once: true });
        markBodyReadStarted();
      }),
  });

  const pending = streamSse(
    '/ai/tutor/messages',
    { method: 'POST', signal: controller.signal },
    'fixture-token',
    () => {},
  );
  await bodyReadStarted;
  controller.abort();

  await assert.rejects(pending, (error) => error === abortError);
});

test('an expired access token refreshes once before opening the tutor stream', async () => {
  useSession({
    accessToken: oldToken,
    user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
  });
  const calls = [];
  sandbox.fetch = async (url, init) => {
    const path = new URL(String(url), 'https://lexloop.invalid').pathname;
    const authorization = new Headers(init.headers).get('Authorization');
    calls.push({ path, authorization });
    if (path.endsWith('/auth/refresh')) {
      return Response.json({
        accessToken: newToken,
        user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
      });
    }
    if (authorization === `Bearer ${oldToken}`) {
      return Response.json({ message: '访问令牌无效或已过期' }, { status: 401 });
    }
    return new Response('data: {"text":"已连接"}\n\n');
  };
  const events = [];

  await streamSse(
    '/ai/tutor/messages',
    { method: 'POST', body: '{"message":"hello"}' },
    oldToken,
    (event, data) => events.push({ event, data }),
  );

  assert.deepEqual(
    calls.map((call) => call.path.split('/').at(-1)),
    ['messages', 'refresh', 'messages'],
  );
  assert.equal(calls[2].authorization, `Bearer ${newToken}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message');
  assert.equal(events[0].data.text, '已连接');
});

test('business capability 401 from a stream is not retried as an expired login', async () => {
  useSession({
    accessToken: oldToken,
    user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
  });
  let refreshCalls = 0;
  sandbox.fetch = async (url) => {
    if (String(url).endsWith('/auth/refresh')) refreshCalls += 1;
    return Response.json({ message: '任务已过期' }, { status: 401 });
  };

  await assert.rejects(
    streamSse('/ai/tutor/messages', { method: 'POST', body: '{}' }, oldToken, () => {}),
    (error) => error.status === 401 && error.message === '任务已过期',
  );
  assert.equal(refreshCalls, 0);
});

test('expired access tokens refresh once and retry the original request with the rotated token', async () => {
  useSession({
    accessToken: oldToken,
    user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
  });
  const calls = [];
  sandbox.fetch = async (url, init) => {
    const path = new URL(String(url), 'https://lexloop.invalid').pathname;
    const authorization = new Headers(init.headers).get('Authorization');
    calls.push({ path, authorization });
    if (path.endsWith('/auth/refresh')) {
      return Response.json({
        accessToken: newToken,
        user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
      });
    }
    if (authorization === `Bearer ${oldToken}`) {
      return Response.json({ message: '访问令牌无效或已过期', statusCode: 401 }, { status: 401 });
    }
    return Response.json({ items: [] });
  };

  await assert.deepEqual(await request('/learning/history', {}, oldToken), { items: [] });
  assert.deepEqual(
    calls.map((call) => call.path.split('/').at(-1)),
    ['history', 'refresh', 'history'],
  );
  assert.equal(calls[2].authorization, `Bearer ${newToken}`);
  assert.equal(JSON.parse(sandbox.localStorage.getItem('lexloop.session')).accessToken, newToken);
});

test('simultaneous expired requests share a refresh and retry only once each', async () => {
  useSession({
    accessToken: oldToken,
    user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
  });
  let finishRefresh;
  let refreshCalls = 0;
  const retryTokens = [];
  sandbox.fetch = async (url, init) => {
    const path = new URL(String(url), 'https://lexloop.invalid').pathname;
    const authorization = new Headers(init.headers).get('Authorization');
    if (path.endsWith('/auth/refresh')) {
      refreshCalls += 1;
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    }
    if (authorization === `Bearer ${oldToken}`) {
      return Response.json({ message: '访问令牌无效或已过期' }, { status: 401 });
    }
    retryTokens.push(authorization);
    return Response.json({ ok: true });
  };

  const first = request('/one', {}, oldToken);
  const second = request('/two', {}, oldToken);
  while (refreshCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishRefresh(
    Response.json({
      accessToken: newToken,
      user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
    }),
  );
  await Promise.all([first, second]);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(retryTokens, [`Bearer ${newToken}`, `Bearer ${newToken}`]);
});

test('business capability 401 remains its own error and never refreshes login', async () => {
  useSession({
    accessToken: oldToken,
    user: { id: userId, email: 'learner@example.invalid', displayName: null, role: 'USER' },
  });
  let refreshCalls = 0;
  sandbox.fetch = async (url) => {
    if (String(url).endsWith('/auth/refresh')) refreshCalls += 1;
    return Response.json({ message: '任务已过期', statusCode: 401 }, { status: 401 });
  };

  await assert.rejects(request('/practice/output/submit', {}, oldToken), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, '任务已过期');
    return true;
  });
  assert.equal(refreshCalls, 0);
});

test('a stale token from another account cannot refresh or retry as the newly active account', async () => {
  useSession({
    accessToken: makeToken('user-b', 'active'),
    user: { id: 'user-b', email: 'b@example.invalid', displayName: null, role: 'USER' },
  });
  let refreshCalls = 0;
  let requestCalls = 0;
  sandbox.fetch = async (url) => {
    if (String(url).endsWith('/auth/refresh')) refreshCalls += 1;
    requestCalls += 1;
    return Response.json({ message: '访问令牌无效或已过期' }, { status: 401 });
  };

  await assert.rejects(request('/learning/history', {}, oldToken), (error) => error.status === 401);
  assert.equal(refreshCalls, 0);
  assert.equal(requestCalls, 1);
});

function makeToken(subject, suffix) {
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url');
  return `fixture-${suffix}.${payload}.signature`;
}

function useSession(session) {
  const values = new Map([['lexloop.session', JSON.stringify(session)]]);
  sandbox.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}
