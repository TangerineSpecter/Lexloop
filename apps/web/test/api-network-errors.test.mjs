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
  fetch: globalThis.fetch,
};
const compiled = ts.transpile(source, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
});
runInNewContext(compiled, sandbox);
const { request, streamSse } = module.exports;
const networkErrorMessage = '暂时无法连接学习服务，请检查网络或稍后重试。';

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
