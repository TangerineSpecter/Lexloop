import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'daily output retries preserve submission identity across failures, reloads, expiry, and accounts',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-output-retry-test-'));
    const browser = spawn(
      process.env.LAB_BROWSER_EXECUTABLE ?? 'chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    let launchError;
    let closed = false;
    browser.on('error', (error) => (launchError = error));
    browser.on('close', () => (closed = true));
    let socket;
    const browserEvents = [];
    const waiting = new Map();
    let sequence = 0;
    try {
      let port;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        try {
          port = Number(
            (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
          );
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(port, 'Chromium did not start');
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      socket = new WebSocket(targets[0].webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (!message.id) {
          if (message.method === 'Runtime.exceptionThrown')
            browserEvents.push(JSON.stringify(message.params.exceptionDetails));
          if (message.method === 'Runtime.consoleAPICalled')
            browserEvents.push(
              message.params.args.map((item) => item.value ?? item.description).join(' '),
            );
          return;
        }
        const pending = waiting.get(message.id);
        if (!pending) return;
        waiting.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      });
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          waiting.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
          );
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A navigation briefly replaces the JavaScript context.
          }
          await delay(100);
        }
        const diagnostics = await evaluate(
          `JSON.stringify({ url: location.href, body: document.body.innerText, writes: localStorage.getItem('fixture.output.requests'), session: localStorage.getItem('lexloop.session'), fetchLog: localStorage.getItem('fixture.output.fetch-log'), keys: Object.keys(localStorage) })`,
        ).catch((error) => String(error));
        assert.fail(
          `Timed out waiting for ${expression}; page=${diagnostics}; events=${browserEvents.join(' | ')}`,
        );
      };
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture-a', user: { id: 'user-a', email: 'a@example.invalid', displayName: 'A', role: 'USER' } }));
          const rowsKey = (userId) => 'fixture.output.rows.' + userId;
          const readRows = (userId) => JSON.parse(localStorage.getItem(rowsKey(userId)) || '[]');
          const writeRows = (userId, rows) => localStorage.setItem(rowsKey(userId), JSON.stringify(rows));
          if (!localStorage.getItem('fixture.output.mode')) localStorage.setItem('fixture.output.mode', 'first-fail');
          if (!localStorage.getItem('fixture.output.requests')) localStorage.setItem('fixture.output.requests', '[]');
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            const method = options.method || 'GET';
            const fetchLog = JSON.parse(localStorage.getItem('fixture.output.fetch-log') || '[]');
            fetchLog.push({ path, method });
            localStorage.setItem('fixture.output.fetch-log', JSON.stringify(fetchLog));
            const user = JSON.parse(localStorage.getItem('lexloop.session') || '{}').user;
            const userId = user?.id || 'user-a';
            const challengeId = 'challenge-' + userId;
            const makeResponse = (value, status = 200) => Response.json(value, { status });
            if (path.includes('/api/v1/auth/me')) return makeResponse({ id: userId });
            if (path.includes('/api/v1/practice/output/today')) {
              const rows = readRows(userId);
              return makeResponse({
                id: challengeId,
                date: '2026-10-27',
                prompt: 'Use the target words in a short paragraph.',
                targets: [
                  { bookWordId: userId + '-w1', word: 'journey', meaning: '旅程' },
                  { bookWordId: userId + '-w2', word: 'bright', meaning: '明亮的' },
                ],
                remaining: 3 - rows.filter((row) => row.status !== 'FAILED').length,
                submissions: rows,
              });
            }
            if (method === 'POST' && path.includes('/practice/output/') && path.endsWith('/submissions')) {
              const payload = JSON.parse(options.body);
              const requests = JSON.parse(localStorage.getItem('fixture.output.requests') || '[]');
              requests.push({ userId, challengeId, ...payload });
              localStorage.setItem('fixture.output.requests', JSON.stringify(requests));
              const rows = readRows(userId);
              let row = rows.find((item) => item.id === 'submission-' + payload.clientRequestId);
              const now = new Date().toISOString();
              if (!row) {
                row = { id: 'submission-' + payload.clientRequestId, answer: payload.answer, status: 'FAILED', feedback: null, error: '批改队列暂时不可用，请稍后重新提交。', createdAt: now, clientRequestId: payload.clientRequestId };
                rows.push(row);
              }
              const mode = localStorage.getItem('fixture.output.mode');
              if (mode === 'first-fail' && requests.length === 1) {
                writeRows(userId, rows);
                return makeResponse({ message: 'queue unavailable' }, 503);
              }
              if (mode === 'lost-response') {
                row.status = 'QUEUED';
                row.error = null;
                writeRows(userId, rows);
                throw new TypeError('simulated response lost after server accepted submission');
              }
              if (mode === 'expired') {
                row.status = 'FAILED';
                row.error = '批改任务已超时，请重新提交。';
                row.createdAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
                writeRows(userId, rows);
                return makeResponse(row);
              }
              row.status = 'QUEUED';
              row.error = null;
              writeRows(userId, rows);
              return makeResponse(row);
            }
            if (path.includes('/api/v1/practice/output/submissions/')) {
              const id = path.split('/').pop();
              return makeResponse(readRows(userId).find((item) => item.id === id) || { message: 'missing' }, 404);
            }
            if (path.includes('/api/v1/practice/output/history')) return makeResponse({ items: [], hasMore: false });
            if (path.includes('/api/v1/')) throw new Error('Unexpected output retry fixture request: ' + path);
            return nativeFetch(url, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard/practice?tab=output', baseUrl).href });
      await until('document.querySelector("#output-answer")');
      const answer = 'Our journey was bright and full of small surprises.';
      await evaluate(`(() => {
        const input = document.querySelector('#output-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(answer)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until('document.querySelector("#output-answer").value.length > 0');
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('提交批改'));
        button.click();
        button.click();
      })()`);
      await until(
        'JSON.parse(localStorage.getItem("fixture.output.requests") || "[]").length >= 1',
      );
      await until('document.querySelector("[role=alert]")');
      let draft = await evaluate('JSON.parse(localStorage.getItem("lexloop.output.draft.user-a"))');
      assert.equal(draft.answer, answer);
      assert.equal(draft.userId, 'user-a');
      assert.equal(draft.challengeId, 'challenge-user-a');
      assert.equal(draft.date, '2026-10-27');
      assert.equal(draft.clientRequestId?.length >= 8, true);
      const firstId = draft.clientRequestId;
      assert.equal(
        await evaluate('JSON.parse(localStorage.getItem("fixture.output.requests")).length'),
        1,
      );
      assert.equal(
        await evaluate('JSON.parse(localStorage.getItem("fixture.output.rows.user-a")).length'),
        1,
      );

      await evaluate('localStorage.setItem("fixture.output.mode", "lost-response")');
      await evaluate(
        `[...document.querySelectorAll('button')].find((item) => item.textContent.includes('提交批改')).click()`,
      );
      await until('JSON.parse(localStorage.getItem("fixture.output.requests")).length === 2');
      await until('document.querySelector("[role=alert]")');
      assert.equal(
        await evaluate(
          'JSON.parse(localStorage.getItem("fixture.output.requests"))[1].clientRequestId',
        ),
        firstId,
      );
      assert.equal(
        await evaluate('JSON.parse(localStorage.getItem("fixture.output.rows.user-a")).length'),
        1,
      );
      await send('Page.reload');
      await until('document.querySelector("#output-answer")?.value === ' + JSON.stringify(answer));
      await until('document.querySelector("#output-answer").disabled');
      draft = await evaluate('JSON.parse(localStorage.getItem("lexloop.output.draft.user-a"))');
      assert.equal(draft.clientRequestId, firstId);
      assert.equal(
        await evaluate('JSON.parse(localStorage.getItem("fixture.output.rows.user-a")).length'),
        1,
      );

      await evaluate(`(() => {
        const rows = JSON.parse(localStorage.getItem('fixture.output.rows.user-a'));
        rows[0].status = 'FAILED';
        rows[0].error = '批改任务已超时，请重新提交。';
        rows[0].createdAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
        localStorage.setItem('fixture.output.rows.user-a', JSON.stringify(rows));
        localStorage.setItem('fixture.output.mode', 'expired');
      })()`);
      await send('Page.reload');
      await until('document.querySelector("#output-answer")?.value === ' + JSON.stringify(answer));
      await evaluate(
        `[...document.querySelectorAll('button')].find((item) => item.textContent.includes('提交批改')).click()`,
      );
      await until('document.body.innerText.includes("超过 15 分钟有效期")');
      assert.equal(await evaluate('document.querySelector("#output-answer").value'), answer);
      draft = await evaluate('JSON.parse(localStorage.getItem("lexloop.output.draft.user-a"))');
      assert.equal('clientRequestId' in draft, false);
      assert.equal('requestAnswer' in draft, false);

      await evaluate('localStorage.setItem("fixture.output.mode", "accept")');
      await evaluate(
        `[...document.querySelectorAll('button')].find((item) => item.textContent.includes('提交批改')).click()`,
      );
      await until('JSON.parse(localStorage.getItem("fixture.output.requests")).length === 4');
      const newId = await evaluate(
        'JSON.parse(localStorage.getItem("fixture.output.requests"))[3].clientRequestId',
      );
      assert.notEqual(newId, firstId);
      assert.equal(
        await evaluate('JSON.parse(localStorage.getItem("fixture.output.rows.user-a")).length'),
        2,
      );

      const otherAnswer = 'The future looked bright along our journey home.';
      const otherDraft = {
        version: 2,
        userId: 'user-b',
        challengeId: 'challenge-user-b',
        date: '2026-10-27',
        answer: otherAnswer,
        clientRequestId: 'request-user-b-123',
        requestAnswer: otherAnswer,
      };
      await evaluate(`(() => {
        const session = JSON.parse(localStorage.getItem('lexloop.session'));
        localStorage.setItem('lexloop.output.draft.user-b', ${JSON.stringify(JSON.stringify(otherDraft))});
        localStorage.setItem('lexloop.session', JSON.stringify({ ...session, accessToken: 'fixture-b', user: { id: 'user-b', email: 'b@example.invalid', displayName: 'B', role: 'USER' } }));
      })()`);
      await send('Page.reload');
      await until(
        'document.querySelector("#output-answer")?.value === ' + JSON.stringify(otherAnswer),
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#output-answer").value.includes("Our journey was bright")',
        ),
        false,
      );
      assert.equal(
        await evaluate('JSON.parse(localStorage.getItem("lexloop.output.draft.user-a")).answer'),
        answer,
      );
      await evaluate(`(() => {
        const input = document.querySelector('#output-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(otherAnswer)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find((item) => item.textContent.includes('提交批改')).click();
      })()`);
      await until('JSON.parse(localStorage.getItem("fixture.output.requests")).length === 5');
      const accountBRequest = await evaluate(
        'JSON.parse(localStorage.getItem("fixture.output.requests"))[4]',
      );
      assert.equal(accountBRequest.userId, 'user-b');
      assert.equal(accountBRequest.challengeId, 'challenge-user-b');
      assert.equal(accountBRequest.clientRequestId, otherDraft.clientRequestId);
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
