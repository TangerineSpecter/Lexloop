import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'late study generation responses do not reopen or replace the selected preview',
  { skip: !baseUrl, timeout: 120_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-generation-preview-test-'));
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
      { stdio: 'ignore', detached: true },
    );
    let launchError;
    let closed = false;
    let socket;
    const browserErrors = [];
    const waiting = new Map();
    let sequence = 0;
    browser.on('error', (error) => {
      launchError = error;
    });
    browser.on('close', () => {
      closed = true;
    });

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
          if (message.method === 'Runtime.exceptionThrown') {
            browserErrors.push(
              message.params.exceptionDetails.exception?.description ??
                message.params.exceptionDetails.text,
            );
          }
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
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
          );
        }
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation can briefly replace the page's JavaScript context.
          }
          await delay(100);
        }
        const pageState = await evaluate(
          `({ path: location.pathname, text: document.body.innerText.slice(-900) })`,
        ).catch(() => null);
        assert.fail(
          `Timed out waiting for ${expression}; state=${JSON.stringify({ pageState, browserErrors })}`,
        );
      };
      const clickHistory = async () => {
        await evaluate(
          '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("今日学习历史")).click()',
        );
      };
      const openRetry = async (index) => {
        await evaluate(
          `document.querySelectorAll(".history-grid article")[${index}].querySelector("button").click()`,
        );
        await until('document.querySelector(".plan-preview-layer")');
      };
      const startGeneration = async (expectedCount) => {
        await evaluate('document.querySelector(".plan-preview .start-challenge").click()');
        await until(`window.generationAttempts.length === ${expectedCount}`);
      };
      const resolvePlan = async (id, status, response) => {
        await evaluate(`(() => {
          const plan = window.planLists["study-user"].find((item) => item.id === ${JSON.stringify(id)});
          plan.status = ${JSON.stringify(status)};
          window.resolveGeneration(${JSON.stringify(id)}, ${response});
        })()`);
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          const makePlan = (id, word, status = 'FAILED') => ({
            id, mode: 'group', purpose: 'normal', status,
            wordCount: 1, groupCount: 1, completed: 0,
            createdAt: new Date().toISOString(), completedAt: null,
            generationError: status === 'FAILED' ? 'fixture failure' : null,
            words: [{ id: id + '-word', word, part: 'adj.', meaning: '平稳的', source: 'NEW', groupIndex: 0, completed: false, nextReviewAt: null, activeWeaknesses: [] }],
            content: null,
            summary: { totalQuestions: 0, correctQuestions: 0, durationSeconds: 0, typeStats: [] },
          });
          const firstSession = { accessToken: 'first-fixture', user: { id: 'study-user', email: 'first@example.invalid', displayName: 'First user', role: 'USER' } };
          const secondSession = { accessToken: 'second-fixture', user: { id: 'second-study-user', email: 'second@example.invalid', displayName: 'Second user', role: 'USER' } };
          localStorage.setItem('lexloop.session', JSON.stringify(firstSession));
          window.planLists = {
            'study-user': [
              makePlan('preview-a', 'bright'),
              makePlan('preview-b', 'gentle'),
              makePlan('preview-c', 'calm'),
              makePlan('preview-account', 'useful'),
            ],
            'second-study-user': [],
          };
          window.generationAttempts = [];
          window.studyPlanCreateBodies = [];
          window.generationResolvers = {};
          window.resolveGeneration = (id, response) => {
            const resolve = window.generationResolvers[id];
            if (!resolve) throw new Error('No pending generation for ' + id);
            delete window.generationResolvers[id];
            resolve(response);
          };
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            const session = JSON.parse(localStorage.getItem('lexloop.session') || 'null');
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: session?.user.id ?? null });
            if (path.endsWith('/api/v1/auth/refresh')) return Response.json({ message: 'No fixture session' }, { status: 401 });
            if (path.endsWith('/api/v1/auth/login') && method === 'POST') return Response.json(secondSession);
            if (path.includes('/api/v1/vocabulary/default')) return Response.json({ id: 'book-a', title: 'Book A', totalWords: 10 });
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 1, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 1, reviewWords: [
              { id: 'review-oldest', word: 'steady', part: 'adj.', meaning: '稳定的' },
              { id: 'review-next', word: 'patient', part: 'adj.', meaning: '耐心的' },
              { id: 'review-latest', word: 'curious', part: 'adj.', meaning: '好奇的' },
            ], newWords: [] });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            const generation = path.match(new RegExp('/api/v1/study/plans/([^/]+)/generate$'));
            if (generation && method === 'POST') {
              const id = generation[1];
              window.generationAttempts.push(id);
              return new Promise((resolve) => { window.generationResolvers[id] = resolve; });
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'GET') {
              return Response.json(window.planLists[session?.user.id] ?? []);
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'POST') {
              window.studyPlanCreateBodies.push(JSON.parse(options.body));
              return Response.json({ message: 'Fixture stopped before plan generation' }, { status: 409 });
            }
            return Response.json({});
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector("[role=tab]")');
      await clickHistory();
      await until('document.querySelectorAll(".history-grid article").length === 4');

      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("单词列表")).click()',
      );
      await until('document.querySelector("#review-session-count")?.value === "3"');
      await evaluate('document.querySelector("#review-session-count").focus()');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
      });
      await until(
        'document.querySelector(".review-session-control output")?.textContent.includes("2 / 3")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".review-session-control p")?.textContent.includes("1 个仍待复习")',
        ),
        true,
      );
      await evaluate('document.querySelector(".toolbar button.create").click()');
      await until('window.studyPlanCreateBodies.length === 1');
      assert.deepEqual(await evaluate('window.studyPlanCreateBodies[0]'), {
        newWordCount: 0,
        reviewWordCount: 2,
        mode: 'group',
      });
      await until(
        'document.querySelector(".book-message")?.textContent.includes("Fixture stopped before plan generation")',
      );
      await evaluate('document.querySelector("#review-session-count").focus()');
      for (let step = 0; step < 2; step++) {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          windowsVirtualKeyCode: 37,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          windowsVirtualKeyCode: 37,
        });
      }
      await until(
        'document.querySelector(".review-session-control output")?.textContent.includes("0 / 3")',
      );
      assert.equal(
        await evaluate('document.querySelector(".toolbar button.create").disabled'),
        true,
      );
      assert.equal(await evaluate('window.studyPlanCreateBodies.length'), 1);
      await clickHistory();
      await until('document.querySelectorAll(".history-grid article").length === 4');

      // Closing the first preview leaves its server request alive. A double
      // click still starts only one client request.
      await openRetry(0);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'bright',
      );
      await evaluate(
        'document.querySelector(".plan-preview .start-challenge").click(); document.querySelector(".plan-preview .start-challenge").click()',
      );
      await until('window.generationAttempts.length === 1');
      assert.deepEqual(await evaluate('window.generationAttempts'), ['preview-a']);
      await evaluate('document.querySelector(".plan-preview header button").click()');
      await until('document.querySelector(".plan-preview-layer") === null');

      // Escape acts like Back/close without cancelling the plan. The previous
      // success and failure must not replace the third plan selected below.
      await openRetry(1);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'gentle',
      );
      await startGeneration(2);
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await until('document.querySelector(".plan-preview-layer") === null');

      await openRetry(2);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'calm',
      );
      await startGeneration(3);
      await resolvePlan('preview-a', 'ACTIVE', 'Response.json(window.planLists["study-user"][0])');
      await until('document.querySelector(".preview-word-title strong")?.textContent === "calm"');
      await until('document.querySelector(".history-grid article")?.innerText.includes("学习中")');
      assert.equal(await evaluate('document.querySelector(".plan-preview-layer") !== null'), true);

      await resolvePlan(
        'preview-b',
        'FAILED',
        'Response.json({ message: "fixture generation failed" }, { status: 502 })',
      );
      await until(
        'window.planLists["study-user"][1].status === "FAILED" && window.generationResolvers["preview-b"] === undefined',
      );
      await delay(150);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'calm',
      );
      assert.equal(
        await evaluate('document.querySelector(".plan-preview .book-message") === null'),
        true,
      );

      await resolvePlan('preview-c', 'ACTIVE', 'Response.json(window.planLists["study-user"][2])');
      await until(
        'document.querySelector(".plan-preview .start-challenge")?.textContent.includes("开始今天的挑战")',
      );
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'calm',
      );
      await evaluate('document.querySelector(".plan-preview-scrim").click()');
      await until('document.querySelector(".plan-preview-layer") === null');

      // An outstanding response from the prior account cannot populate the
      // next account's dashboard after logout and login.
      await openRetry(3);
      await startGeneration(4);
      await evaluate('document.querySelector(".sidebar-book").click()');
      await until('document.querySelector(".account-menu")');
      await evaluate(
        '[...document.querySelectorAll(".account-menu button")].find((button) => button.textContent.includes("退出登录")).click()',
      );
      await until('document.querySelector(".welcome-page")');
      await evaluate(`document.querySelector('a[href="/login"]').click()`);
      await until('document.querySelector("input[name=email]")');
      await evaluate(`(() => {
        const setValue = (selector, value) => {
          const input = document.querySelector(selector);
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setValue('input[name=email]', 'second@example.invalid');
        setValue('input[name=password]', 'fixture-password');
        document.querySelector('form').requestSubmit();
      })()`);
      await until(
        'document.querySelector(".study-app .sidebar-book")?.innerText.includes("Second user")',
      );
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("单词列表")).click()',
      );
      await until(
        'document.querySelector(".review-session-control output")?.textContent.includes("3 / 3")',
      );
      await clickHistory();
      await until(
        'document.querySelector(".plan-empty")?.innerText.includes("今天还没有学习记录")',
      );
      await resolvePlan(
        'preview-account',
        'ACTIVE',
        'Response.json(window.planLists["study-user"][3])',
      );
      await delay(200);
      assert.equal(await evaluate('document.querySelector(".plan-preview-layer") === null'), true);
      assert.equal(await evaluate('document.querySelectorAll(".history-grid article").length'), 0);
      assert.deepEqual(browserErrors, []);
    } finally {
      socket?.close();
      try {
        if (browser.pid) process.kill(-browser.pid, 'SIGTERM');
      } catch {
        browser.kill('SIGTERM');
      }
      if (!closed) await new Promise((resolve) => browser.once('close', resolve));
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
