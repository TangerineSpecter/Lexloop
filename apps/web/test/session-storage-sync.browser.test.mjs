import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'account changes hide the previous page and isolate delayed study-plan recovery',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-session-sync-test-'));
    const browser = spawnChromium(
      process.env.LAB_BROWSER_EXECUTABLE ?? 'chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-popup-blocking',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: 'ignore', detached: process.platform !== 'win32' },
    );
    const sockets = [];
    let launchError;
    browser.on('error', (error) => {
      launchError = error;
    });

    try {
      let port;
      for (let attempt = 0; attempt < 100; attempt += 1) {
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
      const debugUrl = `http://127.0.0.1:${port}`;
      const targets = await (await fetch(`${debugUrl}/json`)).json();
      const firstTarget = targets.find((target) => target.type === 'page');
      assert.ok(firstTarget, 'Chromium did not expose an initial page target');

      const connect = async (webSocketDebuggerUrl) => {
        const socket = new WebSocket(webSocketDebuggerUrl);
        sockets.push(socket);
        const pending = new Map();
        let sequence = 0;
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', reject, { once: true });
        });
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (!message.id) return;
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        });
        const send = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
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
        await send('Page.enable');
        await send('Runtime.enable');
        return { send, evaluate };
      };

      const firstTab = await connect(firstTarget.webSocketDebuggerUrl);
      await firstTab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.makeSessionStudyPlan = (userId, status = 'GENERATING') => {
          const question = {
            bookWordId: 'session-word-' + userId,
            type: 'MEANING_RECOGNITION',
            prompt: 'What does “adapt” mean here?',
            options: ['适应', '拒绝'],
          };
          return {
            id: 'session-plan-' + userId,
            mode: 'group', purpose: 'normal', status, wordCount: 1, groupCount: 1,
            completed: 0, blocksNewPlanCreation: true, createdAt: new Date().toISOString(),
            words: [{
              id: question.bookWordId, word: 'adapt', part: 'vt.', meaning: '适应',
              source: 'NEW', groupIndex: 0, completed: false, nextReviewAt: null,
              activeWeaknesses: [], question: status === 'ACTIVE' ? question : null,
            }],
            content: status === 'ACTIVE' ? { groups: [{
              index: 0, title: 'A new routine', wordOccurrences: { adapt: 1 },
              sentences: [{ english: 'People adapt to new routines.', chinese: '人们会适应新的日常安排。', simplified: '人们会适应新的安排。', grammar: 'adapt to 表示适应某种变化。' }],
              questions: [question],
            }] } : null,
            summary: { totalQuestions: 0, correctQuestions: 0, durationSeconds: 0, typeStats: [] },
          };
        };
        window.fetch = async (input, options = {}) => {
          const url = String(input);
          const path = new URL(url, location.href).pathname;
          const method = options.method || 'GET';
          const session = JSON.parse(localStorage.getItem('lexloop.session') || 'null');
          const userId = session?.user?.id || 'missing-user';
          if (path.endsWith('/auth/me')) return Response.json({ id: userId });
          if (path.endsWith('/vocabulary/default')) {
            return Response.json({ id: 'book-a', title: 'Book A', totalWords: 1 });
          }
          if (path.endsWith('/vocabulary/progress-summary')) {
            return Response.json({ totalWords: 1, masteredWords: 0, progress: 0 });
          }
          if (path.includes('/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
          if (path.includes('/vocabulary/dashboard-words')) {
            return Response.json({ defaultNewWordCount: 1, reviewWords: [], newWords: [
              { id: 'session-word-' + userId, word: 'adapt', part: 'vt.', meaning: '适应' },
            ] });
          }
          if (path.endsWith('/study/plans') && method === 'GET') {
            const plans = JSON.parse(localStorage.getItem('fixture.study-plans.' + userId) || '[]');
            return Response.json(plans);
          }
          if (path.endsWith('/study/plans') && method === 'POST') {
            const attempts = JSON.parse(localStorage.getItem('fixture.study-plan-create-attempts') || '[]');
            attempts.push({ userId, body: JSON.parse(options.body || '{}') });
            localStorage.setItem('fixture.study-plan-create-attempts', JSON.stringify(attempts));
            localStorage.setItem('fixture.study-plan-create-pending.' + userId, JSON.stringify(window.makeSessionStudyPlan(userId)));
            return new Promise((resolve) => { window.resolveStudyPlanCreate = resolve; });
          }
          if (path.endsWith('/study/plans/session-plan-' + userId + '/generate') && method === 'POST') {
            const plan = window.makeSessionStudyPlan(userId, 'ACTIVE');
            localStorage.setItem('fixture.study-plans.' + userId, JSON.stringify([plan]));
            return Response.json(plan);
          }
          return new Response(JSON.stringify({ message: 'fixture response' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        };`,
      });
      await firstTab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.addEventListener('beforeunload', () => {
          localStorage.setItem('fixture.session-sync.visibility', getComputedStyle(document.documentElement).visibility);
        });`,
      });
      await firstTab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.sessionSyncDocumentId = Math.random().toString(36).slice(2);`,
      });
      await firstTab.send('Page.navigate', { url: `${baseUrl}/login` });

      const untilFirstTab = async (expression, label) => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            if (await firstTab.evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation briefly replaces the page execution context.
          }
          await delay(100);
        }
        const state = await firstTab
          .evaluate(`({ path: location.pathname, text: document.body.innerText.slice(0, 400) })`)
          .catch(() => null);
        assert.fail(`Timed out waiting for ${label}; page=${JSON.stringify(state)}`);
      };
      await untilFirstTab('document.querySelector("form")', 'login form');
      await firstTab.evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-token-a',
        user: { id: 'sync-user-a', email: 'a@example.invalid', displayName: '学习者 A', role: 'USER' }
      }));
      localStorage.setItem('lexloop.study.draft.sync-user-a.plan-fixture.0', JSON.stringify({
        snapshotId: 'draft-a', answers: { word: { selected: ['明亮的'], confirmed: true } }
      }));`);
      await firstTab.send('Page.navigate', { url: `${baseUrl}/dashboard` });
      await untilFirstTab(
        '[...document.querySelectorAll(".sidebar-book strong")].some((item) => item.textContent.trim() === "学习者 A")',
        'first account page',
      );
      await untilFirstTab(
        'document.querySelector(".create") && !document.querySelector(".create").disabled',
        'first account study plan controls',
      );
      await firstTab.evaluate('document.querySelector(".create").click()');
      await untilFirstTab(
        'JSON.parse(localStorage.getItem("fixture.study-plan-create-attempts") || "[]").length === 1',
        'the first account plan request to start',
      );
      assert.equal(
        await firstTab.evaluate('document.querySelector(".create").disabled'),
        true,
        'the pending create action should not allow a duplicate request',
      );
      assert.equal(
        await firstTab.evaluate('document.querySelector(".plan-preview-layer") === null'),
        true,
        'the first account waits for its create response before showing a preview',
      );

      const popupOpened = await firstTab.evaluate(
        `Boolean(window.open(${JSON.stringify(`${baseUrl}/login`)}, '_blank'))`,
      );
      assert.equal(popupOpened, true, 'could not open a second same-origin tab');

      let secondTarget;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const currentTargets = await (await fetch(`${debugUrl}/json`)).json();
        secondTarget = currentTargets.find(
          (target) =>
            target.type === 'page' &&
            target.id !== firstTarget.id &&
            target.url.startsWith(`${baseUrl}/login`),
        );
        if (secondTarget) break;
        await delay(100);
      }
      assert.ok(secondTarget, 'second tab did not reach the login page');
      const secondTab = await connect(secondTarget.webSocketDebuggerUrl);
      await secondTab.evaluate(`localStorage.removeItem('fixture.session-sync.visibility');
        localStorage.setItem('lexloop.session', JSON.stringify({
          accessToken: 'fixture-token-b',
          user: { id: 'sync-user-b', email: 'b@example.invalid', displayName: '学习者 B', role: 'USER' }
        }));`);

      await untilFirstTab(
        '[...document.querySelectorAll(".sidebar-book strong")].some((item) => item.textContent.trim() === "学习者 B")',
        'the first tab to reload with the second account',
      );
      assert.equal(
        await secondTab.evaluate("localStorage.getItem('fixture.session-sync.visibility')"),
        'hidden',
        'the previous account page was not concealed before it reloaded',
      );
      assert.equal(
        await firstTab.evaluate(
          '[...document.querySelectorAll(".sidebar-book strong")].some((item) => item.textContent.trim() === "学习者 A")',
        ),
        false,
        'the previous account name remained visible after switching accounts',
      );
      assert.equal(
        await firstTab.evaluate(
          "localStorage.getItem('lexloop.study.draft.sync-user-a.plan-fixture.0')",
        ),
        '{"snapshotId":"draft-a","answers":{"word":{"selected":["明亮的"],"confirmed":true}}}',
        'switching accounts deleted the previous account draft',
      );
      assert.equal(
        await firstTab.evaluate(
          "localStorage.getItem('lexloop.study.draft.sync-user-b.plan-fixture.0')",
        ),
        null,
        'switching accounts copied the previous account draft to the new account',
      );

      await untilFirstTab(
        'document.querySelector(".create") && !document.querySelector(".create").disabled',
        'the second account plan controls to finish loading',
      );
      assert.deepEqual(
        await firstTab.evaluate(
          "JSON.parse(localStorage.getItem('fixture.study-plans.sync-user-b') || '[]')",
        ),
        [],
        'the second account must not load the first account plan',
      );
      assert.equal(
        await firstTab.evaluate('document.querySelector(".plan-preview-layer") === null'),
        true,
        'the previous account plan must never open as the second account preview',
      );
      await firstTab.evaluate(`localStorage.setItem(
        'fixture.study-plan-create-outcome.sync-user-a.1', 'failed'
      );`);

      // Account changes reload the document, so its in-flight fetch callback
      // cannot run. Model A's first create failing after that reload; it must
      // leave no plan behind and allow a deliberate retry on return.
      await secondTab.evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-token-a-returned',
        user: { id: 'sync-user-a', email: 'a@example.invalid', displayName: '学习者 A', role: 'USER' }
      }));`);
      await untilFirstTab(
        '[...document.querySelectorAll(".sidebar-book strong")].some((item) => item.textContent.trim() === "学习者 A") && document.querySelector(".create") && !document.querySelector(".create").disabled',
        'the first account to recover after its failed request',
      );
      assert.equal(
        await firstTab.evaluate('document.querySelector(".plan-preview-layer") === null'),
        true,
        'the failed request must not show a stale preview on return',
      );
      assert.equal(
        await firstTab.evaluate(
          'document.querySelector(".book-message")?.textContent.includes("创建计划测试失败") ?? false',
        ),
        false,
        'the failed request must not show a stale error after the account reload',
      );
      assert.deepEqual(
        await firstTab.evaluate(
          "JSON.parse(localStorage.getItem('fixture.study-plans.sync-user-a') || '[]')",
        ),
        [],
        'the failed first attempt must not create a saved plan',
      );
      await firstTab.evaluate('document.querySelector(".create").click()');
      await untilFirstTab(
        'JSON.parse(localStorage.getItem("fixture.study-plan-create-attempts") || "[]").filter((item) => item.userId === "sync-user-a").length === 2',
        'the first account retry to start',
      );
      assert.equal(await firstTab.evaluate('document.querySelector(".create").disabled'), true);

      await secondTab.evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-token-b-returned',
        user: { id: 'sync-user-b', email: 'b@example.invalid', displayName: '学习者 B', role: 'USER' }
      }));`);
      await untilFirstTab(
        '[...document.querySelectorAll(".sidebar-book strong")].some((item) => item.textContent.trim() === "学习者 B") && document.querySelector(".create") && !document.querySelector(".create").disabled',
        'the second account to return without A state',
      );
      assert.equal(
        await firstTab.evaluate(
          "localStorage.getItem('fixture.study-plan-create-outcome.sync-user-a.1')",
        ),
        'failed',
        'the fixture should model the abandoned first-account request failing after the account switch',
      );
      assert.deepEqual(
        await firstTab.evaluate(
          "JSON.parse(localStorage.getItem('fixture.study-plans.sync-user-b') || '[]')",
        ),
        [],
        'the second account must not load the first account plan',
      );
      assert.equal(
        await firstTab.evaluate('document.querySelector(".plan-preview-layer") === null'),
        true,
      );

      // Persist the retried A plan only after B is active, as if the server
      // completed the request late. B remains clean until A explicitly returns.
      await firstTab.evaluate(`const pendingPlan = JSON.parse(localStorage.getItem('fixture.study-plan-create-pending.sync-user-a'));
        localStorage.setItem('fixture.study-plan-create-outcome.sync-user-a.2', 'succeeded');
        localStorage.setItem('fixture.study-plans.sync-user-a', JSON.stringify([pendingPlan]));`);
      assert.equal(
        await firstTab.evaluate('document.querySelector(".plan-preview-layer") === null'),
        true,
      );
      assert.deepEqual(
        await firstTab.evaluate(
          "JSON.parse(localStorage.getItem('fixture.study-plans.sync-user-b') || '[]')",
        ),
        [],
        'late completion for A must not add a plan to B',
      );
      await secondTab.evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-token-a-final',
        user: { id: 'sync-user-a', email: 'a@example.invalid', displayName: '学习者 A', role: 'USER' }
      }));`);
      await untilFirstTab(
        '[...document.querySelectorAll(".sidebar-book strong")].some((item) => item.textContent.trim() === "学习者 A") && document.querySelector(".create")?.textContent.includes("打开当前学习计划")',
        'the first account plan to recover after the late success',
      );
      assert.equal(
        await firstTab.evaluate('document.querySelector(".plan-preview-layer") === null'),
        true,
        'a late successful create must not auto-open after the account switch',
      );
      await firstTab.evaluate('document.querySelector(".create").click()');
      await untilFirstTab(
        'document.querySelector(".plan-preview-layer")',
        'the learner to explicitly reopen the recovered plan',
      );

      const activeDocumentId = await firstTab.evaluate('window.sessionSyncDocumentId');
      await secondTab.evaluate(`const session = JSON.parse(localStorage.getItem('lexloop.session'));
        localStorage.setItem('lexloop.session', JSON.stringify({ ...session, accessToken: 'fixture-token-b-refreshed' }));`);
      await delay(250);
      assert.equal(
        await firstTab.evaluate('window.sessionSyncDocumentId'),
        activeDocumentId,
        'a same-account token refresh interrupted the open page',
      );

      await secondTab.evaluate(`localStorage.removeItem('fixture.session-sync.visibility');
        localStorage.removeItem('lexloop.session')`);
      await untilFirstTab(
        'location.pathname === "/login"',
        'the first tab to leave the old account page after logout',
      );
      assert.equal(
        await secondTab.evaluate("localStorage.getItem('fixture.session-sync.visibility')"),
        'hidden',
        'the previous account page was not concealed before logout navigation',
      );
      assert.equal(
        await firstTab.evaluate('Boolean(document.querySelector(".study-app"))'),
        false,
        'the previous account dashboard remained visible after logout',
      );
    } finally {
      for (const socket of sockets) {
        if (socket.readyState < WebSocket.CLOSING) socket.close();
      }
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
