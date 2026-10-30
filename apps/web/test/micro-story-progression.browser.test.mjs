import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'A2 completion opens the B1 story without revealing its answer before recall',
  { skip: !baseUrl, timeout: 30_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-micro-progression-test-'));
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
    const waiting = new Map();
    let sequence = 0;
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
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation briefly replaces the page's JavaScript context.
          }
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };
      const clickText = async (text) => {
        await evaluate(`(() => {
          const element = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
          element?.scrollIntoView({ block: 'center', inline: 'center' });
        })()`);
        const point = await evaluate(`(() => {
          const element = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, visible: rect.width > 0 && rect.height > 0, enabled: !element.disabled, hit: hit === element || element.contains(hit) };
        })()`);
        assert.ok(point?.visible, `Expected visible button: ${text}`);
        assert.equal(point.enabled, true, `Expected enabled button: ${text}`);
        assert.equal(point.hit, true, `Expected unobstructed button: ${text}`);
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
        });
      };

      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          const lesson = {
            key: 'deadline-01', series: '项目改期', part: 1, level: 'B1',
            english: 'The client moves the deadline up by a week. Nina realizes the design team is already running behind schedule.',
            interpretation: null,
          };
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'b1-learner', email: 'b1@example.invalid', displayName: 'Fixture', role: 'USER' } }));
          window.storyFixture = { requests: [], lesson };
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            window.storyFixture.requests.push({ path, method, body: options.body ? JSON.parse(options.body) : null });
            if (path.endsWith('/api/v1/auth/me')) return Response.json({ id: 'b1-learner' });
            if (path.endsWith('/api/v1/micro-stories/current')) return Response.json({ completed: 15, total: 21, lesson, review: null });
            if (path.endsWith('/api/v1/micro-stories/deadline-01/interpret') && method === 'POST') {
              return Response.json({
                ...lesson,
                interpretation: JSON.parse(options.body).interpretation,
                reference: '客户把截止日期提前了一周。妮娜意识到设计团队已经落后于进度。',
                explanation: 'move the deadline up 表示把截止日期提前；run behind schedule 表示工作进度落后于原计划。',
                frame: "We're running behind schedule on ___",
                example: "We're running behind schedule on the new menu.",
                focusPhrase: 'running behind schedule',
                focusMeaning: '进度落后于原计划。',
              });
            }
            return Response.json({});
          };
        `,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories', baseUrl).href,
      });
      await until('document.querySelector("#story-heading")?.textContent.includes("项目改期")');
      assert.equal(await evaluate('document.body.textContent.includes("B1 · 16/21")'), true);
      assert.equal(
        await evaluate('document.body.textContent.includes("客户把截止日期提前了一周")'),
        false,
      );
      assert.equal(await evaluate('document.querySelector("#story-meaning") !== null'), true);

      for (const [width, height, mobile] of [
        [1440, 900, false],
        [390, 844, true],
      ]) {
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile,
        });
        await delay(100);
        const bounds = JSON.parse(
          await evaluate(
            'JSON.stringify((() => { const card = document.querySelector("#story-heading").closest("section").getBoundingClientRect(); return { left: card.left, right: card.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
          ),
        );
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport);
        assert.ok(bounds.scrollWidth <= bounds.viewport);
      }
      await send('Emulation.clearDeviceMetricsOverride');

      await evaluate(`(() => {
        const field = document.querySelector('#story-meaning');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '客户把时间提前了。');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await clickText('查看解释');
      await until('document.body.textContent.includes("客户把截止日期提前了一周")');
      assert.equal(
        await evaluate(
          'window.storyFixture.requests.filter((item) => item.method === "POST").length',
        ),
        1,
      );
      assert.deepEqual(
        await evaluate('window.storyFixture.requests.find((item) => item.method === "POST").body'),
        { interpretation: '客户把时间提前了。' },
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("move the deadline up")'),
        true,
      );
      assert.equal(
        await evaluate(
          'window.storyFixture.requests.some((item) => item.path.endsWith("/complete"))',
        ),
        false,
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
