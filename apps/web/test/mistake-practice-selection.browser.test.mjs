import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'mixed mistake selections offer distinct practice paths without dropping ordinary words',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-mistake-practice-test-'));
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
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation briefly replaces the page's JavaScript context.
          }
          await delay(100);
        }
        assert.fail(
          `Timed out waiting for ${expression}; body=${await evaluate('document.body.innerText.slice(0, 900)')}; requests=${await evaluate('JSON.stringify(window.mistakeListRequests ?? [])')}`,
        );
      };

      const weaknesses = (id, questionType) => ({
        id,
        questionType,
        status: 'active',
        wrongCount: 2,
        consecutiveCorrect: 0,
        lastWrongAt: '2026-10-26T10:00:00.000Z',
      });
      const items = [
        {
          bookWordId: 'standard-word',
          word: 'careful',
          part: 'adj.',
          meaning: '仔细的',
          bookTitle: 'Test book',
          severity: 56,
          lastWrongAt: '2026-10-26T10:00:00.000Z',
          weaknesses: [weaknesses('standard-signal', 'READING_COMPREHENSION')],
        },
        {
          bookWordId: 'output-word',
          word: 'journey',
          part: 'n.',
          meaning: '旅程',
          bookTitle: 'Test book',
          severity: 56,
          lastWrongAt: '2026-10-26T10:00:00.000Z',
          weaknesses: [weaknesses('output-signal', 'OUTPUT')],
        },
        {
          bookWordId: 'confusion-word',
          word: 'borrow',
          part: 'v.',
          meaning: '借入',
          bookTitle: 'Test book',
          severity: 56,
          lastWrongAt: '2026-10-26T10:00:00.000Z',
          weaknesses: [weaknesses('confusion-signal', 'CONFUSION')],
        },
      ];

      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'mistake-user', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
          window.mistakePlanWrites = [];
          window.mistakeListRequests = [];
          window.failOutputFilterOnce = true;
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'mistake-user' });
            if (path.includes('/api/v1/mistakes?')) {
              const query = new URL(path, location.origin).searchParams;
              const status = query.get('status');
              const questionType = query.get('questionType') || '';
              const activeRace = new URL(location.href).searchParams.has('activeRace');
              window.mistakeListRequests.push({ status, questionType, activeRace });
              if (activeRace && questionType === 'OUTPUT') {
                await new Promise(resolve => setTimeout(resolve, 700));
                return Response.json({ items: [{ ...${JSON.stringify(items[1])}, bookWordId: 'stale-output', word: 'stale-output' }], page: 1, total: 1, hasMore: false });
              }
              if (activeRace && questionType === 'WORD_MATCHING') {
                return Response.json({ items: [{ ...${JSON.stringify(items[0])}, bookWordId: 'current-standard', word: 'current-standard' }], page: 1, total: 1, hasMore: false });
              }
              if (new URL(location.href).searchParams.has('race') && questionType === 'OUTPUT' && window.failOutputFilterOnce) {
                window.failOutputFilterOnce = false;
                return Response.json({ message: '模拟筛选加载失败' }, { status: 500 });
              }
              if (new URL(location.href).searchParams.has('race') && questionType === 'OUTPUT') {
                return Response.json({ items: [{ ...${JSON.stringify(items[0])}, bookWordId: 'output-only', word: 'output-only' }], page: 1, total: 1, hasMore: false });
              }
              if (new URL(location.href).searchParams.has('race') && status === 'ignored') {
                await new Promise(resolve => setTimeout(resolve, 700));
                return Response.json({ items: [{ ...${JSON.stringify(items[0])}, bookWordId: 'ignored-only', word: 'ignored-only' }], page: 1, total: 1, hasMore: false });
              }
              if (new URL(location.href).searchParams.has('race') && status === 'resolved') {
                return Response.json({ items: [{ ...${JSON.stringify(items[0])}, bookWordId: 'resolved-only', word: 'resolved-only' }], page: 1, total: 1, hasMore: false });
              }
              return Response.json({ items: ${JSON.stringify(items)}, page: 1, total: 3, hasMore: false });
            }
            if (path.endsWith('/api/v1/mistakes/practice-plans') && method === 'POST') {
              window.mistakePlanWrites.push(JSON.parse(options.body));
              return Response.json({ message: 'Fixture stopped before model generation' }, { status: 409 });
            }
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 0, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            return Response.json({});
          };
        `,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("生成专项")).click()',
      );
      await until('document.querySelector(".mistakes-practice-choices")');
      assert.equal(await evaluate('window.mistakePlanWrites.length'), 0);
      const choiceText = await evaluate(
        'document.querySelector(".mistakes-practice-choices").innerText',
      );
      assert.ok(choiceText.includes('每日输出 1 词'));
      assert.ok(choiceText.includes('易混辨析 1 词'));
      assert.ok(choiceText.includes('普通题型 1 词'));
      assert.ok(choiceText.includes('不会把本页所选词自动设为练习目标'));

      await evaluate(
        '[...document.querySelectorAll(".mistakes-practice-choices button")].find((button) => button.textContent.includes("只生成普通专项")).click()',
      );
      await until('window.mistakePlanWrites.length === 1');
      await until('document.querySelector(".book-message")');
      assert.deepEqual(await evaluate('window.mistakePlanWrites[0]'), {
        bookWordIds: ['standard-word'],
      });

      await evaluate(
        '[...document.querySelectorAll(".mistakes-practice-choices button")].find((button) => button.textContent.includes("打开每日输出")).click()',
      );
      await until(
        'location.pathname === "/dashboard/practice" && location.search.includes("tab=output")',
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("生成专项")).click()',
      );
      await until('document.querySelector(".mistakes-practice-choices")');
      await evaluate(
        '[...document.querySelectorAll(".mistakes-practice-choices button")].find((button) => button.textContent.includes("打开易混词训练")).click()',
      );
      await until(
        'location.pathname === "/dashboard/practice" && location.search.includes("tab=confusion")',
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes&race=1', baseUrl).href,
      });
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(100);
      const desktopBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const p = document.querySelector(".mistakes-page").getBoundingClientRect(); const t = document.querySelector(".mistakes-toolbar").getBoundingClientRect(); const l = document.querySelector(".mistakes-list > article").getBoundingClientRect(); return { pageLeft:p.left, pageRight:p.right, toolbarRight:t.right, listRight:l.right, viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(desktopBounds.pageLeft >= 0 && desktopBounds.pageRight <= desktopBounds.viewport);
      assert.ok(desktopBounds.toolbarRight <= desktopBounds.viewport);
      assert.ok(desktopBounds.listRight <= desktopBounds.viewport);
      assert.ok(desktopBounds.scrollWidth <= desktopBounds.viewport);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      await evaluate('document.querySelector(".sidebar-scrim")?.click()');
      await until('!document.querySelector(".sidebar-scrim")');
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 0');
      const mobileBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const p = document.querySelector(".mistakes-page").getBoundingClientRect(); const t = document.querySelector(".mistakes-toolbar").getBoundingClientRect(); const l = document.querySelector(".mistakes-list > article").getBoundingClientRect(); return { pageLeft:p.left, pageRight:p.right, toolbarRight:t.right, listRight:l.right, viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(mobileBounds.pageLeft >= 0 && mobileBounds.pageRight <= mobileBounds.viewport);
      assert.ok(mobileBounds.toolbarRight <= mobileBounds.viewport);
      assert.ok(mobileBounds.listRight <= mobileBounds.viewport);
      assert.ok(mobileBounds.scrollWidth <= mobileBounds.viewport);
      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("已忽略")).click()',
      );
      await until('window.mistakeListRequests.some((item) => item.status === "ignored")');
      assert.equal(await evaluate('document.querySelector(".mistakes-list")'), null);
      assert.match(
        await evaluate('document.querySelector(".mistakes-empty[role=status]")?.textContent'),
        /正在读取薄弱词/,
      );

      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("已纠正")).click()',
      );
      await until(
        'document.querySelector(".mistakes-list")?.textContent.includes("resolved-only")',
      );
      await delay(850);
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-list")?.textContent.includes("resolved-only")',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-list")?.textContent.includes("ignored-only")',
        ),
        false,
      );

      await evaluate(
        `Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(document.querySelector('select[aria-label="按题型筛选"]'), 'OUTPUT'); document.querySelector('select[aria-label="按题型筛选"]').dispatchEvent(new Event('change', { bubbles: true }));`,
      );
      await until(
        'document.querySelector(".mistakes-empty[role=alert]")?.textContent.includes("薄弱词暂时无法加载")',
      );
      assert.equal(await evaluate('document.querySelector(".mistakes-list")'), null);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      await evaluate('document.querySelector(".sidebar-scrim")?.click()');
      await until('!document.querySelector(".sidebar-scrim")');
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 0');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate('document.querySelector(".mistakes-empty[role=alert] button").click()');
      await until('document.querySelector(".mistakes-list")?.textContent.includes("output-only")');

      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes&activeRace=1', baseUrl).href,
      });
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        `Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(document.querySelector('select[aria-label="按题型筛选"]'), 'OUTPUT'); document.querySelector('select[aria-label="按题型筛选"]').dispatchEvent(new Event('change', { bubbles: true }));`,
      );
      await until(
        'window.mistakeListRequests.some((item) => item.activeRace && item.questionType === "OUTPUT")',
      );
      assert.equal(await evaluate('document.querySelector(".mistakes-list")'), null);
      assert.equal(await evaluate('document.querySelector(".mistakes-create").disabled'), true);
      await evaluate(
        `Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(document.querySelector('select[aria-label="按题型筛选"]'), 'WORD_MATCHING'); document.querySelector('select[aria-label="按题型筛选"]').dispatchEvent(new Event('change', { bubbles: true }));`,
      );
      await until(
        'document.querySelector(".mistakes-list")?.textContent.includes("current-standard")',
      );
      await delay(850);
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-list")?.textContent.includes("current-standard")',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-list")?.textContent.includes("stale-output")',
        ),
        false,
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("生成专项")).click()',
      );
      await until('window.mistakePlanWrites.length === 1');
      assert.deepEqual(await evaluate('window.mistakePlanWrites[0]'), {
        bookWordIds: ['current-standard'],
      });
      assert.equal(
        await evaluate('window.mistakeListRequests.filter((item) => item.activeRace).length'),
        3,
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
