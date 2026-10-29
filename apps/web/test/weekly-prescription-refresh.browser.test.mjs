import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

function prescription(title, reason) {
  return {
    weekStart: '2026-10-26',
    weekEnd: '2026-11-01',
    evidenceStart: '2026-10-23',
    evidenceEnd: '2026-10-29',
    summary: {
      attempts: 12,
      accuracy: 75,
      dueReviews: 2,
      weaknesses: 1,
      outputs: 1,
      contrasts: 0,
      activeDays: 3,
    },
    actions: [
      {
        id: 'review',
        title,
        reason,
        instruction: '先完成已到期的复习，再考虑增加新词。',
        minutes: 6,
        href: '/dashboard',
      },
      {
        id: 'output',
        title: '写一段自己的英语',
        reason: '把学过的表达用在自己的经历里。',
        instruction: '先独立表达，再查看形成性反馈。',
        minutes: 8,
        href: '/dashboard/practice?tab=output',
      },
      {
        id: 'confusion',
        title: '比较相近表达',
        reason: '用语境区分词义和搭配。',
        instruction: '完成后间隔一天再试一次。',
        minutes: 4,
        href: '/dashboard/practice?tab=confusion',
      },
    ],
  };
}

test(
  'failed weekly-prescription refresh labels the retained result as stale and retry replaces it',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-weekly-prescription-test-'));
    const browser = spawnChromium(
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
      { stdio: 'ignore', detached: process.platform !== 'win32' },
    );
    let launchError;
    let socket;
    let sequence = 0;
    const waiting = new Map();
    const browserErrors = [];
    browser.on('error', (error) => (launchError = error));

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
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // The initial client-side session load may briefly replace the page context.
          }
          await delay(100);
        }
        assert.fail(
          `Timed out waiting for ${expression}; body=${await evaluate('document.body.innerText.slice(0, 900)')}`,
        );
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'weekly-user', email: 'weekly@example.invalid', displayName: 'Weekly fixture', role: 'USER' } }));
          window.weeklyRequests = [];
          const first = ${JSON.stringify(prescription('优先复习旧词', '旧建议：依据前一次学习记录'))};
          const latest = ${JSON.stringify(prescription('巩固刚学的新词', '新建议：已包含最近一次练习'))};
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'weekly-user' });
            if (path.includes('/api/v1/practice/weekly')) {
              const attempt = window.weeklyRequests.length + 1;
              window.weeklyRequests.push({ attempt, method: options.method ?? 'GET' });
              if (attempt === 2) return Response.json({ message: '模拟刷新失败' }, { status: 503 });
              return Response.json(attempt === 1 ? first : latest);
            }
            return Response.json({});
          };
        `,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard/practice?tab=weekly', baseUrl).href,
      });
      await until('document.querySelector("#weekly-title")');
      await until('window.weeklyRequests.length === 1');
      await until('document.body.innerText.includes("旧建议：依据前一次学习记录")');

      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("刷新处方")).click()',
      );
      await until('window.weeklyRequests.length === 2');
      await until('document.querySelector("[role=alert]")?.textContent.includes("模拟刷新失败")');
      const failedRefresh = await evaluate(`(() => {
        const alert = document.querySelector('[role="alert"]');
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('刷新处方'));
        const rect = alert.getBoundingClientRect();
        return {
          alertText: alert.textContent,
          oldRecommendationStillVisible: document.body.innerText.includes('旧建议：依据前一次学习记录'),
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          alertLeft: rect.left,
          alertRight: rect.right,
          retryEnabled: Boolean(button && !button.disabled),
        };
      })()`);
      assert.equal(
        failedRefresh.oldRecommendationStillVisible,
        true,
        JSON.stringify(failedRefresh),
      );
      assert.equal(failedRefresh.retryEnabled, true, JSON.stringify(failedRefresh));
      assert.equal(
        failedRefresh.documentWidth <= failedRefresh.viewportWidth,
        true,
        JSON.stringify(failedRefresh),
      );
      assert.equal(
        failedRefresh.alertText.includes('仍显示上次成功读取的处方，可能未包含最新学习记录。'),
        true,
        `retained recommendations must be explicitly labeled after refresh failure: ${JSON.stringify(failedRefresh)}`,
      );

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileAlert = await evaluate(`(() => {
        const alert = document.querySelector('[role="alert"]');
        const rect = alert.getBoundingClientRect();
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right };
      })()`);
      assert.equal(
        mobileAlert.documentWidth <= mobileAlert.width,
        true,
        JSON.stringify(mobileAlert),
      );
      assert.equal(
        mobileAlert.left >= 0 && mobileAlert.right <= mobileAlert.width,
        true,
        JSON.stringify(mobileAlert),
      );

      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("刷新处方")).focus()',
      );
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
      await until('window.weeklyRequests.length === 3');
      await until('document.body.innerText.includes("新建议：已包含最近一次练习")');
      assert.equal(
        await evaluate(
          'document.body.innerText.includes("仍显示上次成功读取的处方，可能未包含最新学习记录。")',
        ),
        false,
      );
      assert.equal(await evaluate('window.weeklyRequests.length'), 3);
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
