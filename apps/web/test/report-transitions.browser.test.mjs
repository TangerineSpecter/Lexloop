import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;
const screenshotDir = process.env.LAB_UI_SCREENSHOT_DIR;

test(
  'statistics and history keep the selected page stable through slow, cached, fast and failed loads',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-report-transition-'));
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
      const capture = async (name) => {
        if (!screenshotDir) return;
        await mkdir(screenshotDir, { recursive: true });
        const { data } = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        await writeFile(join(screenshotDir, name), Buffer.from(data, 'base64'));
      };
      const until = async (expression, timeoutMs = 12_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A navigation can briefly replace the execution context.
          }
          await delay(40);
        }
        const routeState = await evaluate(`({
          page: Boolean(document.querySelector('.learning-history-page')) ? 'history' : Boolean(document.querySelector('.statistics-page')) ? 'statistics' : 'other',
          title: document.querySelector('.learning-history-page h1, .statistics-page h1')?.textContent?.trim() ?? null,
          activeNav: document.querySelector('.sidebar-nav .nav-item.nav-button.active span')?.textContent?.trim() ?? null,
          focused: document.activeElement?.textContent?.trim()?.slice(0, 60) ?? null,
          historyRequests: window.reportFixture?.historyRequests?.length ?? null,
          statisticsRequests: window.reportFixture?.statisticsRequests?.length ?? null,
          keyEvents: window.reportKeyEvents ?? null,
          focusedStyle: document.activeElement ? { tag: document.activeElement.tagName, className: document.activeElement.className, display: getComputedStyle(document.activeElement).display, visibility: getComputedStyle(document.activeElement).visibility } : null,
          pageState: window.history.state?.lexloopDashboardPage ?? null,
        })`);
        assert.fail(
          `Timed out waiting for ${expression}; route state: ${JSON.stringify(routeState)}`,
        );
      };

      const emptyHistory = {
        items: [],
        hasMore: false,
        totals: {
          records: 0,
          plans: 0,
          words: 0,
          questions: 0,
          correctQuestions: 0,
          assessments: 0,
          scenarios: 0,
        },
      };
      const emptyStatistics = {
        activeDays: 0,
        chart: Array.from({ length: 7 }, (_, index) => ({
          label: `日 ${index + 1}`,
          words: 0,
          completed: false,
          today: index === 6,
        })),
        activity: [],
        currentStreak: 0,
        learnedWords: 0,
        masteredWords: 0,
        newWords: 0,
        reviewWords: 0,
        attemptCount: 0,
        accuracy: 0,
        averageResponseMs: 0,
        studySeconds: 0,
        completedPlans: 0,
        completedScenarios: 0,
        completedAssessments: 0,
        summary: '',
        suggestion: '',
        versusPrevious: 0,
        rankings: { reviews: [], unfamiliar: [], errorRate: [], accuracy: [] },
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
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture-token', user: { id: 'report-user-a', email: 'report@example.invalid', displayName: 'Report learner', role: 'USER' } }));
          window.reportFixture = {
            historyRequests: [],
            statisticsRequests: [],
            holdHistory: true,
            holdSevenDayStatistics: true,
            pendingHistory: [],
            pendingStatistics: [],
            failRange: null,
            historyResponse: ${JSON.stringify(emptyHistory)},
            statisticsResponse: ${JSON.stringify(emptyStatistics)},
            resolveHistory() { this.pendingHistory.shift()?.(Response.json(this.historyResponse)); },
            resolveStatistics() { this.pendingStatistics.shift()?.(Response.json(this.statisticsResponse)); },
          };
          window.reportTimeline = [];
          window.reportNavigationClick = null;
          document.addEventListener('click', event => {
            const button = event.target instanceof Element ? event.target.closest('.sidebar-nav .nav-item.nav-button') : null;
            if (button) window.reportNavigationClick = { text: button.textContent.trim(), at: performance.now() };
          });
          window.startReportTimeline = () => {
            window.reportTimeline = [];
            let frame = 0;
            const sample = () => {
              const page = document.querySelector('.learning-history-page, .statistics-page');
              if (page) {
                const heading = page.querySelector('h1');
                const card = page.querySelector('.history-loading-card, .learning-history-empty-card, .statistics-loading-card, .statistics-empty-card');
                const headingRect = heading?.getBoundingClientRect();
                const cardRect = card?.getBoundingClientRect();
                window.reportTimeline.push({
                  at: performance.now(),
                  page: page.classList.contains('learning-history-page') ? 'history' : 'statistics',
                  title: heading?.textContent?.trim() ?? '',
                  activeNav: document.querySelector('.sidebar-nav .nav-item.nav-button.active span')?.textContent?.trim() ?? '',
                  viewport: innerWidth,
                  loading: Boolean(page.querySelector('.history-loading-card, .statistics-loading-card')),
                  empty: Boolean(page.querySelector('.learning-history-empty-card:not(.history-loading-card), .statistics-empty-card:not(.statistics-loading-card)')),
                  headingY: headingRect?.top ?? null,
                  cardY: cardRect?.top ?? null,
                  cardHeight: cardRect?.height ?? null,
                });
              }
              if (frame++ < 600) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          };
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const parsed = new URL(String(url), location.href);
            const path = parsed.pathname;
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'report-user-a' });
            if (path.includes('/api/v1/reports/history')) {
              const index = window.reportFixture.historyRequests.length;
              window.reportFixture.historyRequests.push({ userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id, page: parsed.searchParams.get('page') });
              if (window.reportFixture.holdHistory && index === 0) return new Promise(resolve => window.reportFixture.pendingHistory.push(resolve));
              return Response.json(window.reportFixture.historyResponse);
            }
            if (path.includes('/api/v1/reports/statistics')) {
              const range = parsed.searchParams.get('range');
              const index = window.reportFixture.statisticsRequests.length;
              window.reportFixture.statisticsRequests.push({ userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id, range, timeZone: parsed.searchParams.get('timeZone') });
              if (window.reportFixture.failRange === range) {
                window.reportFixture.failRange = null;
                return Response.json({ message: '统计暂时不可用' }, { status: 503 });
              }
              if (range === '7d' && window.reportFixture.holdSevenDayStatistics && index === 0) return new Promise(resolve => window.reportFixture.pendingStatistics.push(resolve));
              return Response.json(window.reportFixture.statisticsResponse);
            }
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 0, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.startsWith('/api/v1/')) return Response.json({ message: 'unexpected fixture API request: ' + path }, { status: 404 });
            return nativeFetch(url, options);
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector(".progress-grid .metric-card")');
      await until('document.querySelector(".sidebar-nav .nav-item.nav-button")');

      await evaluate('window.startReportTimeline()');
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习历史")).click()',
      );
      await until(
        'window.reportFixture.pendingHistory.length === 1 && document.querySelector(".history-loading-card")',
      );
      await delay(240);
      await capture('history-loading-1440.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(350);
      await capture('history-loading-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      let historyLoadingFrames = await evaluate(
        'window.reportTimeline.filter(frame => frame.page === "history")',
      );
      assert.ok(
        historyLoadingFrames.length >= 8,
        `Expected frame-level history loading evidence, got ${historyLoadingFrames.length} frames`,
      );
      assert.ok(
        historyLoadingFrames.every(
          (frame) =>
            frame.title === '学习历史' &&
            frame.activeNav === '学习历史' &&
            frame.loading &&
            !frame.empty,
        ),
        `History showed an incorrect page or empty state before data: ${JSON.stringify(historyLoadingFrames.slice(-3))}`,
      );
      const historyFirstFrame = historyLoadingFrames[0];
      const historyStableFrame = historyLoadingFrames
        .filter((frame) => frame.viewport === 1440)
        .at(-1);
      assert.ok(historyStableFrame, 'Expected a desktop history loading frame');
      assert.ok(
        historyFirstFrame.at - (await evaluate('window.reportNavigationClick.at')) <= 200,
        'History skeleton should appear promptly after selecting the page',
      );
      await evaluate('window.reportFixture.resolveHistory()');
      await until(
        'document.querySelector(".learning-history-empty-card:not(.history-loading-card)")',
      );
      await until(
        '[...document.querySelector(".learning-history-page").getAnimations()].every(animation => animation.playState === "finished")',
      );
      await capture('history-empty-1440.png');
      const historyFinalGeometry = await evaluate(`(() => {
        const heading = document.querySelector('.learning-history-page h1').getBoundingClientRect();
        const card = document.querySelector('.learning-history-page .learning-history-empty-card').getBoundingClientRect();
        return { headingY: heading.top, cardY: card.top, cardHeight: card.height };
      })()`);
      assert.ok(
        Math.abs(historyFinalGeometry.headingY - historyStableFrame.headingY) <= 1,
        'History title shifted while loading completed',
      );
      assert.ok(
        Math.abs(historyFinalGeometry.cardY - historyStableFrame.cardY) <= 1,
        'History empty-state card moved while loading completed',
      );
      assert.ok(
        Math.abs(historyFinalGeometry.cardHeight - historyStableFrame.cardHeight) <= 1,
        'History card height changed after data arrived',
      );

      await evaluate('window.startReportTimeline()');
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习统计")).click()',
      );
      await until(
        'window.reportFixture.pendingStatistics.length === 1 && document.querySelector(".statistics-loading-card")',
      );
      await delay(240);
      await capture('statistics-loading-1440.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(350);
      await capture('statistics-loading-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const statsLoadingFrames = await evaluate(
        'window.reportTimeline.filter(frame => frame.page === "statistics")',
      );
      assert.ok(
        statsLoadingFrames.length >= 8,
        `Expected frame-level statistics loading evidence, got ${statsLoadingFrames.length} frames`,
      );
      assert.ok(
        statsLoadingFrames.every(
          (frame) =>
            frame.title === '学习统计' &&
            frame.activeNav === '学习统计' &&
            frame.loading &&
            !frame.empty,
        ),
        `Statistics showed a wrong or empty state before data: ${JSON.stringify(statsLoadingFrames.slice(-3))}`,
      );
      const historyButton =
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习历史"))';
      await evaluate(`${historyButton}.focus()`);
      await evaluate(
        `window.reportKeyEvents = []; for (const type of ['keydown', 'keyup', 'click']) document.addEventListener(type, event => window.reportKeyEvents.push({ type, key: event.key ?? null, target: event.target?.textContent?.trim()?.slice(0, 30) ?? null }), true)`,
      );
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'char',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        unmodifiedText: '\r',
        windowsVirtualKeyCode: 13,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await until(
        'document.querySelector(".learning-history-empty-card:not(.history-loading-card)")',
      );
      assert.equal(
        await evaluate('document.querySelector(".history-loading-card") === null'),
        true,
      );
      assert.equal(await evaluate('window.reportFixture.historyRequests.length'), 1);

      // The old response is allowed to populate its own cache, but must not replace the newer page.
      await evaluate('window.reportFixture.resolveStatistics()');
      await delay(100);
      assert.equal(
        await evaluate('document.querySelector(".learning-history-page") !== null'),
        true,
      );
      assert.equal(await evaluate('document.querySelector(".statistics-page") === null'), true);
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '学习历史',
      );
      await evaluate('window.history.back()');
      await until(
        'document.querySelector(".statistics-empty-card:not(.statistics-loading-card)") && document.body.innerText.includes("近 7 天还没有学习记录")',
      );
      await until(
        '[...document.querySelector(".statistics-page").getAnimations()].every(animation => animation.playState === "finished")',
      );
      await capture('statistics-empty-1440.png');
      const statsFinalGeometry = await evaluate(`(() => {
        const heading = document.querySelector('.statistics-page h1').getBoundingClientRect();
        const card = document.querySelector('.statistics-page .statistics-empty-card').getBoundingClientRect();
        return { headingY: heading.top, cardY: card.top, cardHeight: card.height };
      })()`);
      const statsLoadingFrame = statsLoadingFrames
        .filter((frame) => frame.viewport === 1440)
        .at(-1);
      assert.ok(statsLoadingFrame, 'Expected a desktop statistics loading frame');
      assert.ok(
        Math.abs(statsFinalGeometry.headingY - statsLoadingFrame.headingY) <= 1,
        'Statistics title shifted while loading completed',
      );
      assert.ok(
        Math.abs(statsFinalGeometry.cardY - statsLoadingFrame.cardY) <= 1,
        'Statistics empty-state card moved while loading completed',
      );
      assert.ok(
        Math.abs(statsFinalGeometry.cardHeight - statsLoadingFrame.cardHeight) <= 1,
        'Statistics card height changed after data arrived',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '学习统计',
      );

      const firstRequestCounts = await evaluate(
        '({ history: window.reportFixture.historyRequests.length, statistics: window.reportFixture.statisticsRequests.length })',
      );
      assert.deepEqual(firstRequestCounts, { history: 1, statistics: 1 });
      assert.equal(
        await evaluate('window.reportFixture.historyRequests[0].userId'),
        'report-user-a',
      );
      assert.equal(
        await evaluate('window.reportFixture.statisticsRequests[0].userId'),
        'report-user-a',
      );
      assert.equal(
        await evaluate('window.reportFixture.statisticsRequests[0].timeZone'),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );

      // Browser back/forward returns to the correct selected page using cached account-scoped data.
      await evaluate('window.history.forward()');
      await until(
        'document.querySelector(".learning-history-empty-card:not(.history-loading-card)")',
      );
      assert.equal(await evaluate('window.reportFixture.historyRequests.length'), 1);
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '学习历史',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习统计")).click()',
      );
      await until('document.querySelector(".statistics-empty-card:not(.statistics-loading-card)")');
      assert.equal(
        await evaluate('document.querySelector(".statistics-loading-card") === null'),
        true,
      );
      assert.equal(await evaluate('window.reportFixture.statisticsRequests.length'), 1);

      // A new range must not briefly reuse the previous range as if it were current; errors are retryable in place.
      await evaluate('window.reportFixture.failRange = "30d"');
      await evaluate(
        '[...document.querySelectorAll(".statistics-range button")].find(button => button.textContent.includes("近 30 天")).click()',
      );
      await until('document.querySelector(".statistics-empty-card[role=alert]")');
      assert.equal(
        await evaluate('document.querySelector("#statistics-title")?.textContent'),
        '学习统计',
      );
      await evaluate(
        '[...document.querySelectorAll(".statistics-empty-card[role=alert] button")].find(button => button.textContent.includes("重试")).click()',
      );
      await until(
        'document.querySelector(".statistics-empty-card:not([role=alert])") && document.body.innerText.includes("近 30 天还没有学习记录")',
      );
      const rangeRequests = await evaluate(
        'window.reportFixture.statisticsRequests.map(({ range }) => range)',
      );
      assert.deepEqual(rangeRequests, ['7d', '30d', '30d']);

      // A fast response still starts on the selected page and honors reduced motion.
      await evaluate('window.reportFixture.holdSevenDayStatistics = false');
      await evaluate(
        '[...document.querySelectorAll(".statistics-range button")].find(button => button.textContent.includes("近 1 年")).click()',
      );
      await until('document.body.innerText.includes("近 1 年还没有学习记录")');
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      const motion = await evaluate(`({
        page: getComputedStyle(document.querySelector('.statistics-page')).animationName,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
      })`);
      assert.equal(motion.reduced, true);
      assert.equal(motion.page, 'none');

      const assertReportLayout = async (width) => {
        const layout = await evaluate(`(() => {
          const page = document.querySelector('.statistics-page');
          const heading = page?.querySelector('h1');
          const card = page?.querySelector('.statistics-empty-card:not(.statistics-loading-card)');
          const nodes = [page, heading, card].filter(Boolean);
          return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: nodes.map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }; }) };
        })()`);
        assert.equal(layout.viewport, width);
        assert.ok(
          layout.scrollWidth <= width,
          `Statistics overflows at ${width}px: ${JSON.stringify(layout)}`,
        );
        assert.equal(layout.elements.length, 3);
        for (const element of layout.elements) {
          assert.ok(
            element.left >= -1 && element.right <= width + 1,
            `Report element crosses ${width}px viewport: ${JSON.stringify(element)}`,
          );
          assert.ok(element.width > 0 && element.height > 0);
        }
        return layout;
      };
      const desktopLayout = await assertReportLayout(1440);
      await evaluate('window.history.back()');
      await until(
        'document.querySelector(".learning-history-empty-card:not(.history-loading-card)")',
      );
      const desktopHistoryLayout = await evaluate(`(() => {
        const page = document.querySelector('.learning-history-page');
        const heading = page?.querySelector('h1');
        const card = page?.querySelector('.learning-history-empty-card:not(.history-loading-card)');
        const nodes = [page, heading, card].filter(Boolean);
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: nodes.map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }; }) };
      })()`);
      assert.equal(desktopHistoryLayout.viewport, 1440);
      assert.ok(
        desktopHistoryLayout.scrollWidth <= 1440,
        `History overflows at desktop: ${JSON.stringify(desktopHistoryLayout)}`,
      );
      assert.equal(desktopHistoryLayout.elements.length, 3);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileHistoryLayout = await evaluate(`(() => {
        const page = document.querySelector('.learning-history-page');
        const heading = page?.querySelector('h1');
        const card = page?.querySelector('.learning-history-empty-card:not(.history-loading-card)');
        const nodes = [page, heading, card].filter(Boolean);
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: nodes.map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }; }) };
      })()`);
      assert.equal(mobileHistoryLayout.viewport, 390);
      assert.ok(
        mobileHistoryLayout.scrollWidth <= 390,
        `History overflows at mobile: ${JSON.stringify(mobileHistoryLayout)}`,
      );
      await capture('history-empty-390.png');
      for (const element of mobileHistoryLayout.elements) {
        assert.ok(
          element.left >= -1 && element.right <= 391,
          `History element crosses 390px viewport: ${JSON.stringify(element)}`,
        );
      }
      await evaluate('window.history.forward()');
      await until('document.querySelector(".statistics-empty-card:not(.statistics-loading-card)")');
      const mobileLayout = await assertReportLayout(390);
      await capture('statistics-empty-390.png');
      process.stdout.write(
        `report transitions: history/stats initial requests ${firstRequestCounts.history}/${firstRequestCounts.statistics}, cached re-entry added 0 requests, range recovery requests ${rangeRequests.join(',')}; geometry stable to <=1px; statistics layout ${desktopLayout.scrollWidth}/${desktopLayout.viewport}px and ${mobileLayout.scrollWidth}/${mobileLayout.viewport}px; history layout ${desktopHistoryLayout.scrollWidth}/${desktopHistoryLayout.viewport}px and ${mobileHistoryLayout.scrollWidth}/${mobileHistoryLayout.viewport}px\n`,
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
