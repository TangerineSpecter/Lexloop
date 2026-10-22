import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

// Opt in against a running Web build. Only API fixtures are used, never a real
// account or database. Chromium is isolated in a temporary browser profile.
test(
  'switching reading history replaces collection drafts and saves the current source',
  {
    skip: !baseUrl,
    timeout: 30_000,
  },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-collection-test-'));
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
    browser.on('error', (error) => {
      launchError = error;
    });
    let socket;
    let closed = false;
    browser.on('close', () => {
      closed = true;
    });
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
        if (!message.id) return;
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
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate(`Boolean(${expression})`)) return;
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };
      const lesson = (id) => ({
        id,
        kind: 'READING',
        status: 'READY',
        evidence: [],
        answers: null,
        score: null,
        error: null,
        createdAt: '2026-10-22T00:00:00.000Z',
        submittedAt: null,
        content: {
          title: `Lesson ${id}`,
          introduction: 'Fixture reading',
          targets: [],
          topics: [],
          sentences: [{ english: `${id} original sentence.`, chinese: '译文', note: '讲解' }],
          questions: [{ id: 'q1', prompt: 'Choose one', options: ['a', 'b', 'c'] }],
        },
      });
      const history = { items: [lesson('A'), lesson('B')], hasMore: false };
      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'fixture', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
      window.collectionRequests = [];
      const nativeFetch = window.fetch;
      window.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'fixture' });
        if (path.includes('/api/v1/learning-lab/lessons?')) return Response.json(${JSON.stringify(history)});
        if (path.includes('/api/v1/vocabulary/personal/items')) {
          window.collectionRequests.push(JSON.parse(options.body));
          return Response.json({ id: 'captured' });
        }
        if (path.includes('/api/v1/')) throw new Error('Unexpected API request in browser fixture');
        return nativeFetch(url, options);
      };
    `,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard/notebook?tab=reading', baseUrl).href,
      });
      await until('document.body && document.querySelector("textarea")');
      assert.equal(
        await evaluate('document.querySelector("textarea").value'),
        'A original sentence.',
      );
      // A real typed draft must also be discarded when switching source context.
      await evaluate(`(() => {
      const textarea = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Draft for A');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('button')].find(button => button.textContent.includes('Lesson B')).click();
    })()`);
      await until('document.querySelector("h3").textContent === "Lesson B"');
      assert.equal(
        await evaluate('document.querySelector("textarea").value'),
        'B original sentence.',
      );
      await evaluate(`(() => {
      const form = document.querySelector('details form');
      form.closest('details').open = true;
      [...form.querySelectorAll('input')].forEach((input, index) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, index ? '语境词义' : 'river');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    })()`);
      await evaluate(`document.querySelector('details form button').click()`);
      await until('window.collectionRequests.length === 1');
      assert.deepEqual(await evaluate('window.collectionRequests[0]'), {
        text: 'river',
        type: 'WORD',
        meaning: '语境词义',
        example: 'B original sentence.',
        sourceScenario: 'Lesson B',
        sourceType: 'READING',
      });
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
