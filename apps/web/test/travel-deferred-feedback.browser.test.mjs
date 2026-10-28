import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'travel dialogue feedback is optional per turn and remains in the final review',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-travel-feedback-test-'));
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
    let socket;
    let closed = false;
    const waiting = new Map();
    const browserErrors = [];
    let sequence = 0;
    browser.on('error', (error) => (launchError = error));
    browser.on('close', () => (closed = true));

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
            // A page transition can replace the execution context briefly.
          }
          await delay(100);
        }
        const state = await evaluate(
          `JSON.stringify({ path: location.pathname, text: document.body.innerText.slice(-800), errors: window.travelFeedbackFixture?.errors })`,
        ).catch(() => 'unavailable');
        assert.fail(`Timed out waiting for ${expression}; state=${state}`);
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          const user = { id: 'travel-learner', email: 'travel@example.invalid', displayName: 'Traveller', role: 'USER' };
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user }));
          const scenario = {
            id: 'hotel-check-in', category: 'HOTEL', categoryLabel: '酒店', title: '在酒店办理入住',
            description: '说明你有预订并询问入住安排。', userRole: '旅客', aiRole: '前台工作人员',
            minTurns: 1, maxTurns: 6, objectives: ['说明自己有预订'], starterPhrases: ['I have a reservation.'],
            grammarFrames: [{ intent: '说明预订', natural: 'I have a reservation under…', frame: 'I have a reservation under + name', explanation: '用 under 引出预订姓名。' }],
            completedCount: 0, bestOutcome: null,
          };
          window.travelFeedbackFixture = { turnPending: false, turnRequests: 0, errors: [] };
          window.fetch = async (input, options = {}) => {
            const path = String(input);
            const method = options.method ?? 'GET';
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: user.id });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 0, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.includes('/api/v1/proficiency/profile')) return Response.json({ overallLevel: 'A1', confidence: 'LOW', provisional: true, assessedAt: null, dimensions: { vocabulary: 0, grammar: 0, sentenceBuilding: 0, taskCompletion: 0, naturalness: 0, pronunciation: null, listening: null, fluency: null } });
            if (path.includes('/api/v1/practice/today')) return Response.json({ id: 'daily-plan', totalMinutes: 15, items: [{ id: 'daily-scenario', type: 'SCENARIO', position: 1, minutes: 8, title: scenario.title, reason: '练习真实入住沟通', completedAt: null, scenario }] });
            if (path.includes('/api/v1/scenarios')) return Response.json([scenario]);
            if (path.includes('/api/v1/vocabulary/notebook')) return Response.json({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false });
            if (path.endsWith('/api/v1/scenario-sessions/active') && method === 'GET') return Response.json(null);
            if (path.endsWith('/api/v1/scenario-sessions') && method === 'POST') return Response.json({ session: { id: 'session-a', templateId: scenario.id, level: 'A1', status: 'ACTIVE', turnCount: 0 }, template: scenario, turns: [] });
            if (path.endsWith('/api/v1/scenario-sessions/session-a/turns') && method === 'POST') {
              window.travelFeedbackFixture.turnPending = true;
              window.travelFeedbackFixture.turnRequests += 1;
              return await new Promise(resolve => {
                window.travelFeedbackFixture.resolveTurn = (result) => {
                  window.travelFeedbackFixture.turnPending = false;
                  resolve(Response.json(result));
                };
              });
            }
            if (path.endsWith('/api/v1/scenario-sessions/session-a/complete') && method === 'POST') return Response.json({ outcome: 'PARTIAL', dimensions: { vocabulary: 50, grammar: 50, sentenceBuilding: 50, taskCompletion: 50, naturalness: 50 }, rewrites: [{ type: 'naturalness', original: 'I want check in.', natural: 'I’d like to check in.', explanation: 'would like to 是更礼貌的请求表达。' }], grammarFrames: scenario.grammarFrames, evidence: scenario.objectives.map(objective => ({ objective, completed: false })), vocabulary: [], recommendation: '先复习这页句子骨架，再试一次。' });
            if (path.includes('/api/v1/')) {
              window.travelFeedbackFixture.errors.push(method + ' ' + path);
              return Response.json([]);
            }
            return new Response('Not found', { status: 404 });
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until(
        '[...document.querySelectorAll("button")].some(button => button.textContent.includes("场景口语"))',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find(button => button.textContent.includes("场景口语")).click()',
      );
      await until('document.body.innerText.includes("在酒店办理入住")');
      await evaluate(
        '[...document.querySelectorAll("button")].find(button => button.textContent.includes("进入场景")).click()',
      );
      await until('document.querySelector(".scene-composer textarea")');

      await evaluate(`(() => {
        const textarea = document.querySelector('.scene-composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'I want check in.');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.scene-composer button[aria-label="发送回复"]').click();
      })()`);
      await until('window.travelFeedbackFixture.turnPending');
      assert.equal(
        await evaluate('document.querySelector(".travel-deferred-feedback") === null'),
        true,
      );
      assert.equal(await evaluate('window.travelFeedbackFixture.turnRequests'), 1);

      await evaluate(`window.travelFeedbackFixture.revealStartedAt = performance.now();
        window.travelFeedbackFixture.resolveTurn({
        turn: { id: 'assistant-1', role: 'assistant', content: 'Certainly. Could I have the name on the reservation?', evaluation: {
            taskProgress: [{ objective: '说明自己有预订', completed: false }], blockingCorrection: { issue: '你说的内容暂时不够清楚。', hint: '补充预订姓名。', natural: 'I have a reservation under Lee.', frame: 'I have a reservation under + name', explanation: '用 under 引出预订姓名。' },
          deferredFeedback: [{ type: 'politeness', original: 'I want check in.', natural: 'I’d like to check in.', explanation: 'would like to 是更礼貌的请求表达。' }],
          vocabulary: [], sessionShouldEnd: false
        } },
        evaluation: { taskProgress: [{ objective: '说明自己有预订', completed: false }], blockingCorrection: { issue: '你说的内容暂时不够清楚。', hint: '补充预订姓名。', natural: 'I have a reservation under Lee.', frame: 'I have a reservation under + name', explanation: '用 under 引出预订姓名。' },
          deferredFeedback: [{ type: 'politeness', original: 'I want check in.', natural: 'I’d like to check in.', explanation: 'would like to 是更礼貌的请求表达。' }], vocabulary: [], sessionShouldEnd: false },
        session: { id: 'session-a', templateId: 'hotel-check-in', level: 'A1', status: 'ACTIVE', turnCount: 1 }
      })`);
      await until('document.querySelector(".travel-deferred-feedback summary")');
      const feedbackRenderMs = await evaluate(
        'performance.now() - window.travelFeedbackFixture.revealStartedAt',
      );
      const initialFeedbackState = await evaluate(`(() => {
          const disclosure = document.querySelector('.travel-deferred-feedback');
          const list = disclosure.querySelector('[data-feedback-list]');
          const composer = document.querySelector('.scene-composer textarea');
          return {
            collapsed: !disclosure.open,
            hidden: getComputedStyle(list).display === 'none',
            composerEnabled: !composer.disabled,
            summaryLabel: disclosure.querySelector('summary').innerText,
            blockingCorrectionVisible: Boolean(document.querySelector('.correction-card')),
            requestCount: window.travelFeedbackFixture.turnRequests,
            unexpectedApiCalls: window.travelFeedbackFixture.errors,
          };
        })()`);
      assert.equal(initialFeedbackState.collapsed, true);
      assert.equal(initialFeedbackState.hidden, true);
      assert.equal(initialFeedbackState.composerEnabled, true);
      assert.match(initialFeedbackState.summaryLabel, /本轮补充语言提示 · 1 条（选读）/);
      assert.equal(initialFeedbackState.blockingCorrectionVisible, true);
      assert.equal(initialFeedbackState.requestCount, 1);
      assert.deepEqual(initialFeedbackState.unexpectedApiCalls, []);
      assert.ok(
        feedbackRenderMs < 1000,
        `feedback took ${feedbackRenderMs}ms to render after the fixture response`,
      );

      await evaluate('document.querySelector(".travel-deferred-feedback summary").focus()');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      assert.equal(
        await evaluate('document.querySelector(".travel-deferred-feedback").open'),
        true,
      );
      assert.equal(
        await evaluate('document.activeElement.matches(".travel-deferred-feedback summary")'),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".travel-deferred-feedback").innerText.includes("I’d like to check in.")',
        ),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".correction-card blockquote").textContent'),
        'I have a reservation under Lee.',
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
        text: ' ',
        unmodifiedText: ' ',
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
      });
      assert.equal(
        await evaluate('document.querySelector(".travel-deferred-feedback").open'),
        false,
      );

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileLayout = await evaluate(`(() => {
        const composerNode = document.querySelector('.scene-composer');
        composerNode.scrollIntoView({ block: 'center' });
        const summary = document.querySelector('.travel-deferred-feedback summary').getBoundingClientRect();
        const composer = composerNode.getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, summaryRight: summary.right, composerVisible: composer.width > 0 && composer.bottom <= innerHeight };
      })()`);
      assert.equal(mobileLayout.scrollWidth, mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.ok(mobileLayout.summaryRight <= mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.equal(mobileLayout.composerVisible, true);

      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate(
        '[...document.querySelectorAll(".conversation-actions button")].find(button => button.textContent.includes("完成场景")).click()',
      );
      await until('document.querySelector(".rewrite-notes")');
      assert.equal(
        await evaluate(
          'document.querySelector(".rewrite-notes").innerText.includes("I’d like to check in.")',
        ),
        true,
      );
      assert.equal(await evaluate('window.travelFeedbackFixture.turnRequests'), 1);
      assert.deepEqual(await evaluate('window.travelFeedbackFixture.errors'), []);
      assert.deepEqual(browserErrors, []);
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      if (!closed) await new Promise((resolve) => browser.once('close', resolve)).catch(() => {});
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
