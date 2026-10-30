import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'mistakes preserve distinct practice paths and page linked history without writes',
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
          window.dashboardRouteFrames = [];
          (() => {
            let frame = 0;
            const sample = () => {
              const page = document.querySelector('.mistakes-page, .dashboard-chunk-loading, .study-content');
              const heading = page?.querySelector('h1');
              window.dashboardRouteFrames.push({
                page: page?.classList.contains('mistakes-page') ? 'mistakes' : page?.classList.contains('dashboard-chunk-loading') ? page.dataset.dashboardPage ?? 'loading' : page ? 'study' : document.querySelector('[data-dashboard-bootstrap-loading]') ? 'bootstrap' : null,
                title: heading?.textContent?.trim() ?? null,
              });
              if (frame++ < 300) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          })();
          window.mistakePlanWrites = [];
          window.mistakeListRequests = [];
          window.mistakeDetailRequests = [];
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
            if (path.includes('/api/v1/mistakes/standard-signal?') && method === 'GET') {
              const query = new URL(path, location.origin).searchParams;
              const attemptCursor = query.get('attemptCursor');
              const attemptDirection = query.get('attemptDirection');
              const newerPage = attemptDirection === 'newer';
              const secondPage = Boolean(attemptCursor && !newerPage);
              window.mistakeDetailRequests.push({ attemptCursor, attemptDirection });
              const attempts = !secondPage
                ? Array.from({ length: 20 }, (_, index) => ({ id: 'saved-' + String(41 - index).padStart(2, '0'), isCorrect: index % 3 === 0, selectedAnswer: 'saved answer ' + index, createdAt: '2026-10-28T10:00:00.000Z', question: { prompt: 'Saved source question ' + index, options: ['A', 'B'], correctAnswers: ['A'], explanation: 'Saved explanation' } }))
                : [{ id: 'saved-old-without-question', isCorrect: false, selectedAnswer: null, createdAt: '2026-10-20T10:00:00.000Z', question: null }, { id: 'saved-old-with-snapshot', isCorrect: true, selectedAnswer: 'B', createdAt: '2026-10-19T10:00:00.000Z', question: { prompt: 'Older saved source question', correctAnswers: ['B'] } }];
              return Response.json({ ...${JSON.stringify(weaknesses('standard-signal', 'READING_COMPREHENSION'))}, bookWordId: 'standard-word', word: 'careful', part: 'adj.', meaning: '仔细的', bookTitle: 'Test book', attempts, attemptPageSize: 20, attemptHasOlder: !secondPage, attemptHasNewer: secondPage, olderAttemptCursor: !secondPage ? 'older-cursor' : null, newerAttemptCursor: secondPage ? 'newer-cursor' : null });
            }
            if (path.includes('/api/v1/ai/tutor/history')) return Response.json({ messages: [], remaining: 30, limit: 30, hasMore: false });
            if (path.endsWith('/api/v1/mistakes/practice-plans') && method === 'POST') {
              const selection = JSON.parse(options.body);
              window.mistakePlanWrites.push(selection);
              const message = selection.bookWordIds.includes('current-standard')
                ? '已有薄弱项专项包含其他选择，本次选择未应用。请先处理现有专项，再重新选择。'
                : 'Fixture stopped before model generation';
              return Response.json({ message }, { status: 409 });
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
      const directLinkFrames = await evaluate('window.dashboardRouteFrames');
      assert.ok(directLinkFrames.some((frame) => frame.page === 'mistakes'));
      assert.ok(
        !directLinkFrames.some((frame) => frame.page === 'study'),
        `direct /dashboard?view=mistakes showed the default study page before the requested page: ${JSON.stringify(directLinkFrames.filter((frame) => frame.page === 'study').slice(0, 3))}`,
      );
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
      await until(
        'document.querySelector(".book-message")?.textContent.includes("本次选择未应用")',
      );
      assert.equal(
        await evaluate(
          'location.pathname === "/dashboard" && location.search.includes("view=mistakes")',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistake-check")].some((button) => button.getAttribute("aria-label") === "取消选择 current-standard")',
        ),
        true,
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（1）/,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const conflictBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const message = document.querySelector(".book-message").getBoundingClientRect(); return { left: message.left, right: message.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(conflictBounds.left >= 0 && conflictBounds.right <= conflictBounds.viewport);
      assert.ok(conflictBounds.scrollWidth <= conflictBounds.viewport);
      await send('Emulation.clearDeviceMetricsOverride');
      assert.equal(
        await evaluate('window.mistakeListRequests.filter((item) => item.activeRace).length'),
        3,
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("阅读理解")).click()',
      );
      await until('document.querySelector(".mistake-detail-layer[role=dialog]")');
      await until('document.querySelectorAll(".mistake-attempt").length === 20');
      assert.match(
        await evaluate('document.querySelector(".mistake-attempt").textContent'),
        /Saved source question 0/,
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[0])')),
        {
          attemptCursor: null,
          attemptDirection: null,
        },
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const detailDesktopBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const d = document.querySelector(".mistake-detail").getBoundingClientRect(); const n = document.querySelector(".mistake-attempt-heading").getBoundingClientRect(); return { left:d.left, right:d.right, headingRight:n.right, viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(
        detailDesktopBounds.left >= 0 && detailDesktopBounds.right <= detailDesktopBounds.viewport,
      );
      assert.ok(detailDesktopBounds.headingRight <= detailDesktopBounds.right);
      assert.ok(detailDesktopBounds.scrollWidth <= detailDesktopBounds.viewport);
      await evaluate(
        '[...document.querySelectorAll(".mistake-attempt-pagination button")].find((button) => button.textContent.includes("更早")).click()',
      );
      await until(
        'document.querySelector(".mistake-attempt-pagination span")?.textContent.includes("第 2 页")',
      );
      await until('document.querySelectorAll(".mistake-attempt").length === 2');
      assert.match(
        await evaluate('document.querySelector(".mistake-attempt").textContent'),
        /题目内容不可用/,
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-attempt").textContent'),
        /未记录/,
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[1])')),
        {
          attemptCursor: 'older-cursor',
          attemptDirection: 'older',
        },
      );
      await evaluate(
        '[...document.querySelectorAll(".mistake-attempt-pagination button")].find((button) => button.textContent.includes("较新")).click()',
      );
      await until(
        'document.querySelector(".mistake-attempt-pagination span")?.textContent.includes("第 1 页")',
      );
      await until('document.querySelectorAll(".mistake-attempt").length === 20');
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[2])')),
        {
          attemptCursor: 'newer-cursor',
          attemptDirection: 'newer',
        },
      );
      assert.equal(await evaluate('window.mistakePlanWrites.length'), 0);

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const detailMobileBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const d = document.querySelector(".mistake-detail").getBoundingClientRect(); return { left:d.left, right:d.right, viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(
        detailMobileBounds.left >= 0 && detailMobileBounds.right <= detailMobileBounds.viewport,
      );
      assert.ok(detailMobileBounds.scrollWidth <= detailMobileBounds.viewport);
      await evaluate('document.querySelector(".mistake-detail-practice-button").click()');
      await until('!document.querySelector(".mistake-detail-layer[role=dialog]")');
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistake-check")].find((button) => button.getAttribute("aria-label") === "取消选择 careful") !== undefined',
        ),
        true,
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（1）/,
      );
      assert.equal(await evaluate('window.mistakePlanWrites.length'), 0);
      await send('Emulation.clearDeviceMetricsOverride');
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
