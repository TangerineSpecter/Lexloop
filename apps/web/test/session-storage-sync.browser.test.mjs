import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'an account change or logout in another tab hides the previous account page',
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
        source: `window.fetch = async (input) => {
          const url = String(input);
          if (url.includes('/api/v1/auth/me')) {
            const session = JSON.parse(localStorage.getItem('lexloop.session') || 'null');
            return Response.json({ id: session?.user?.id || 'missing-user' });
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
