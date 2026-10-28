import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'completed study history can recover selected answers and explanations on demand',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-study-history-review-'));
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
            // A navigation can briefly replace the page's JavaScript context.
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

      const historyResponse = {
        items: [
          {
            id: 'plan-review-fixture',
            kind: 'PLAN',
            occurredAt: '2026-10-28T08:00:00.000Z',
            mode: 'group',
            wordCount: 2,
            totalQuestions: 2,
            correctQuestions: 1,
            durationSeconds: 24,
            typeStats: [{ type: 'MEANING_RECOGNITION', total: 2, correct: 1 }],
            weakWords: ['bright'],
          },
        ],
        hasMore: false,
        totals: {
          records: 1,
          plans: 1,
          words: 2,
          questions: 2,
          correctQuestions: 1,
          assessments: 0,
          scenarios: 0,
        },
      };
      const reviewResponse = {
        id: 'plan-review-fixture',
        status: 'COMPLETED',
        words: [
          {
            id: 'bright-id',
            word: 'bright',
            result: false,
            selectedAnswer: ['暗的'],
            savedContext: {
              scenario: '微故事 · 上班路上 · 第 1 段',
              example: 'Maya missed the bus, so she called a taxi.',
            },
            question: {
              type: 'MEANING_RECOGNITION',
              prompt: 'Choose the meaning of bright.',
              correctAnswers: ['明亮的'],
              explanation: 'bright 描述光线充足或颜色鲜明。',
            },
          },
          {
            id: 'help-id',
            word: 'help',
            result: true,
            selectedAnswer: ['帮助'],
            question: {
              type: 'MEANING_RECOGNITION',
              prompt: 'Choose the meaning of help.',
              correctAnswers: ['帮助'],
              explanation: 'help 表示提供帮助。',
            },
          },
        ],
      };

      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture-token', user: { id: 'learner-a', email: 'learner@example.invalid', displayName: 'Learner', role: 'USER' } }));
          window.studyHistoryFixture = { reviewCalls: [], failFirstReview: true };
          const historyResponse = ${JSON.stringify(historyResponse)};
          const reviewResponse = ${JSON.stringify(reviewResponse)};
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'learner-a' });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 2, todayActive: true });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 20, masteredWords: 4, progress: 20 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 5, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.includes('/api/v1/reports/history')) return Response.json(historyResponse);
            if (path.includes('/api/v1/study/plans/plan-review-fixture/review')) {
              window.studyHistoryFixture.reviewCalls.push({ url: path, authorization: new Headers(options.headers).get('Authorization') });
              if (window.studyHistoryFixture.failFirstReview) {
                window.studyHistoryFixture.failFirstReview = false;
                return Response.json({ message: '复盘读取暂时失败' }, { status: 503 });
              }
              return Response.json(reviewResponse);
            }
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/')) return Response.json({ message: 'unexpected fixture API request: ' + path }, { status: 404 });
            return nativeFetch(url, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector(".progress-grid .metric-card")');
      await evaluate(
        '[...document.querySelectorAll("button.nav-item.nav-button")].find((button) => button.textContent.includes("学习历史")).click()',
      );
      await until('document.querySelector(".learning-history-page h1")');
      await until('document.querySelector(".learning-history-card.is-plan")');
      assert.equal(await evaluate('window.studyHistoryFixture.reviewCalls.length'), 0);

      await evaluate('document.querySelector(".history-details-toggle").click()');
      await until('document.querySelector(".history-question-review")');
      assert.equal(await evaluate('window.studyHistoryFixture.reviewCalls.length'), 0);
      await evaluate('document.querySelector(".history-review-button").click()');
      await until('document.querySelector(".history-review-error[role=alert]")');
      assert.match(
        await evaluate('document.querySelector(".history-review-error").textContent'),
        /复盘读取暂时失败/,
      );
      assert.equal(await evaluate('window.studyHistoryFixture.reviewCalls.length'), 1);
      assert.equal(
        await evaluate('window.studyHistoryFixture.reviewCalls[0].authorization'),
        'Bearer fixture-token',
      );

      await evaluate('document.querySelector(".history-review-button").click()');
      await until('document.querySelectorAll(".history-review-question").length === 2');
      assert.equal(await evaluate('document.body.innerText.includes("暗的")'), true);
      assert.equal(await evaluate('document.body.innerText.includes("明亮的")'), true);
      assert.equal(
        await evaluate('document.body.innerText.includes("bright 描述光线充足或颜色鲜明")'),
        true,
      );
      assert.equal(await evaluate('document.body.innerText.includes("help 表示提供帮助")'), true);
      assert.equal(
        await evaluate('document.querySelector(".saved-review-context p")?.textContent'),
        'Maya missed the bus, so she called a taxi.',
      );
      assert.match(
        await evaluate('document.querySelector(".saved-review-context small").textContent'),
        /微故事 · 上班路上/,
      );
      assert.equal(
        await evaluate('document.querySelectorAll(".saved-review-context").length'),
        1,
        'older items without saved source context keep their existing review layout',
      );
      assert.equal(await evaluate('window.studyHistoryFixture.reviewCalls.length'), 2);

      const desktopLayout = await evaluate(
        `(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, cards: document.querySelectorAll('.history-review-question').length }))()`,
      );
      assert.equal(desktopLayout.document, desktopLayout.viewport, JSON.stringify(desktopLayout));
      assert.equal(desktopLayout.body, desktopLayout.viewport, JSON.stringify(desktopLayout));
      await evaluate('document.querySelector(".history-review-button").click()');
      await evaluate('document.querySelector(".history-review-button").click()');
      assert.equal(await evaluate('window.studyHistoryFixture.reviewCalls.length'), 2);

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const mobileLayout = await evaluate(
        `(() => {
          const review = document.querySelector('.history-review-list')?.getBoundingClientRect();
          const context = document.querySelector('.saved-review-context')?.getBoundingClientRect();
          return {
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            review: review?.width ?? 0,
            reviewLeft: review?.left ?? 0,
            reviewRight: review?.right ?? 0,
            context: context?.width ?? 0,
            contextLeft: context?.left ?? 0,
            contextRight: context?.right ?? 0,
          };
        })()`,
      );
      assert.equal(mobileLayout.document, mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.equal(mobileLayout.body, mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.ok(mobileLayout.review > 0, JSON.stringify(mobileLayout));
      assert.ok(
        mobileLayout.context > 0 && mobileLayout.context <= mobileLayout.review,
        JSON.stringify(mobileLayout),
      );
      assert.ok(mobileLayout.contextLeft >= mobileLayout.reviewLeft, JSON.stringify(mobileLayout));
      assert.ok(
        mobileLayout.contextRight <= mobileLayout.reviewRight,
        JSON.stringify(mobileLayout),
      );
      assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
      console.log(
        `study history review layout: desktop ${desktopLayout.viewport}px, mobile ${mobileLayout.viewport}px; review requests ${2}`,
      );
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
