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
      const emptyArchivePage = { items: [], total: 0, nextCursor: null };
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
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture-token', user: { id: 'report-user-a', email: 'report@example.invalid', displayName: 'Report learner', role: 'USER' } }));
          window.reportFixture = {
            historyRequests: [],
            statisticsRequests: [],
            learningWordsRequests: [],
            masteredRequests: [],
            masteredRemoveRequests: [],
            holdHistory: true,
            holdSevenDayStatistics: true,
            holdLearningWords: true,
            holdMasteredWords: true,
            pendingHistory: [],
            pendingStatistics: [],
            pendingLearningWords: [],
            pendingMasteredWords: [],
            failRange: null,
            failLearningWords: false,
            failMasteredWords: false,
            failLearningNextPage: false,
            failMasteredNextPage: false,
            historyResponse: ${JSON.stringify(emptyHistory)},
            statisticsResponse: ${JSON.stringify(emptyStatistics)},
            learningWordsResponse: ${JSON.stringify(emptyArchivePage)},
            learningWordsNextResponse: ${JSON.stringify(emptyArchivePage)},
            masteredWordsResponse: ${JSON.stringify(emptyArchivePage)},
            masteredWordsNextResponse: ${JSON.stringify(emptyArchivePage)},
            resolveHistory() { this.pendingHistory.shift()?.(Response.json(this.historyResponse)); },
            resolveStatistics() { this.pendingStatistics.shift()?.(Response.json(this.statisticsResponse)); },
            resolveLearningWords(status = 200) { this.pendingLearningWords.shift()?.(Response.json(status === 200 ? this.learningWordsResponse : { message: 'learning words unavailable' }, { status })); },
            resolveMasteredWords(status = 200) { this.pendingMasteredWords.shift()?.(Response.json(status === 200 ? this.masteredWordsResponse : { message: 'mastered words unavailable' }, { status })); },
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
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: JSON.parse(localStorage.getItem('lexloop.session')).user.id });
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
            if (path.endsWith('/api/v1/vocabulary/learning-words')) {
              const cursor = parsed.searchParams.get('cursor');
              window.reportFixture.learningWordsRequests.push({ userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id, cursor, pageSize: parsed.searchParams.get('pageSize') });
              if (cursor && window.reportFixture.failLearningNextPage) {
                window.reportFixture.failLearningNextPage = false;
                return Response.json({ message: 'learning words page unavailable' }, { status: 503 });
              }
              if (cursor) return Response.json(window.reportFixture.learningWordsNextResponse);
              if (window.reportFixture.holdLearningWords) return new Promise(resolve => window.reportFixture.pendingLearningWords.push(resolve));
              if (window.reportFixture.failLearningWords) {
                window.reportFixture.failLearningWords = false;
                return Response.json({ message: 'learning words unavailable' }, { status: 503 });
              }
              return Response.json(window.reportFixture.learningWordsResponse);
            }
            if (path.endsWith('/api/v1/vocabulary/mastered')) {
              const cursor = parsed.searchParams.get('cursor');
              window.reportFixture.masteredRequests.push({ userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id, cursor, pageSize: parsed.searchParams.get('pageSize') });
              if (cursor && window.reportFixture.failMasteredNextPage) {
                window.reportFixture.failMasteredNextPage = false;
                return Response.json({ message: 'mastered words page unavailable' }, { status: 503 });
              }
              if (cursor) return Response.json(window.reportFixture.masteredWordsNextResponse);
              if (window.reportFixture.holdMasteredWords) return new Promise(resolve => window.reportFixture.pendingMasteredWords.push(resolve));
              if (window.reportFixture.failMasteredWords) {
                window.reportFixture.failMasteredWords = false;
                return Response.json({ message: 'mastered words unavailable' }, { status: 503 });
              }
              return Response.json(window.reportFixture.masteredWordsResponse);
            }
            if (path.startsWith('/api/v1/vocabulary/mastered/') && options.method === 'DELETE') {
              window.reportFixture.masteredRemoveRequests.push(path.split('/').at(-1));
              return Response.json({ success: true });
            }
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

      // Reduced motion is checked against each animated surface while it is visible,
      // rather than inferred from the page-level rule alone.
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      assert.deepEqual(
        await evaluate(`({
          page: getComputedStyle(document.querySelector('.statistics-page')).animationName,
          skeleton: getComputedStyle(document.querySelector('.statistics-loading-lines i')).animationName,
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
        })`),
        { page: 'none', skeleton: 'none', reduced: true },
      );

      await evaluate('document.querySelector(".sidebar-book").click()');
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      assert.deepEqual(
        await evaluate(`({
          animation: getComputedStyle(document.querySelector('.account-menu')).animationName,
          runningAnimations: document.querySelector('.account-menu').getAnimations().filter(animation => animation.playState !== 'finished').length
        })`),
        { animation: 'none', runningAnimations: 0 },
      );
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
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
      await until('document.querySelector(".account-menu") === null');

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await evaluate('document.querySelector(".menu-trigger").click()');
      await until(
        'document.querySelector(".study-sidebar.is-open") && document.querySelector(".sidebar-scrim")',
      );
      assert.deepEqual(
        await evaluate(`({
          sidebarTransition: getComputedStyle(document.querySelector('.study-sidebar')).transitionDuration,
          scrimAnimation: getComputedStyle(document.querySelector('.sidebar-scrim')).animationName,
          runningScrimAnimations: document.querySelector('.sidebar-scrim').getAnimations().filter(animation => animation.playState !== 'finished').length
        })`),
        { sidebarTransition: '0s', scrimAnimation: 'none', runningScrimAnimations: 0 },
      );
      await evaluate('document.querySelector(".sidebar-scrim").click()');
      await until('!document.querySelector(".study-sidebar.is-open")');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      await evaluate(`window.navigationAuditFrames = []; (() => {
        let frame = 0;
        const sample = () => {
          const pages = ['.study-content', '.travel-page', '.assessment-page', '.learning-words-page', '.mistakes-page', '.mastered-page', '.learning-history-page', '.statistics-page', '.settings-page'];
          const page = pages.map(selector => document.querySelector(selector)).find(Boolean);
          const heading = page?.querySelector('h1');
          window.navigationAuditFrames.push({
            at: performance.now(),
            page: page?.className.split(/\\s+/)[0] ?? null,
            title: heading?.textContent?.trim() ?? null,
            activeNav: document.querySelector('.sidebar-nav .nav-item.nav-button.active span, .nav-children button.active')?.textContent?.trim() ?? null,
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            headingTop: heading?.getBoundingClientRect().top ?? null
          });
          if (frame++ < 180) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      })()`);
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("账户设置")).focus()',
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
      await until('document.querySelector(".settings-page h1")?.textContent.trim() === "设置"');
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '账户设置',
      );
      assert.equal(
        await evaluate('document.activeElement?.textContent.trim()'),
        '账户设置',
        'Keyboard navigation should keep focus on the selected destination',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习历史")).click()',
      );
      await until(
        'document.querySelector(".learning-history-page h1")?.textContent.trim() === "学习历史"',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("账户设置")).click()',
      );
      await until('document.querySelector(".settings-page h1")?.textContent.trim() === "设置"');
      await evaluate('window.navigationAuditFrames = []');
      await delay(180);
      const delayedStatisticsFrames = await evaluate('window.navigationAuditFrames');
      assert.ok(
        delayedStatisticsFrames.length >= 8,
        `Expected frame samples during delayed-statistics navigation, got ${delayedStatisticsFrames.length}`,
      );
      assert.ok(
        delayedStatisticsFrames.every(
          (frame) =>
            frame.page === 'settings-page' &&
            frame.title === '设置' &&
            frame.activeNav === '账户设置' &&
            frame.viewport === 1440 &&
            frame.scrollWidth <= 1440,
        ),
        `A stale statistics response or layout state replaced the third destination: ${JSON.stringify(delayedStatisticsFrames.slice(-4))}`,
      );
      const settingsFrameTop = delayedStatisticsFrames.at(-1).headingTop;
      await evaluate('window.reportFixture.resolveStatistics()');
      await delay(160);
      assert.equal(
        await evaluate('document.querySelector(".settings-page h1")?.textContent.trim()'),
        '设置',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '账户设置',
      );
      assert.ok(
        Math.abs(
          (await evaluate(
            'document.querySelector(".settings-page h1").getBoundingClientRect().top',
          )) - settingsFrameTop,
        ) <= 1,
        'A late statistics response shifted the visible settings page',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习统计")).click()',
      );
      await until('document.querySelector(".statistics-empty-card:not(.statistics-loading-card)")');
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
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const clickWordPage = async (label) => {
        await evaluate(
          `[...document.querySelectorAll(".nav-children button")].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
        );
      };
      const wordArchiveLayout = async (selector, width) =>
        evaluate(`(() => {
          const page = document.querySelector('${selector}');
          const state = page?.querySelector('.word-archive-state');
          const heading = page?.querySelector('h1');
          const rect = state?.getBoundingClientRect();
          return {
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            title: heading?.textContent?.trim() ?? null,
            activeNav: page?.closest('.study-app')?.querySelector('.nav-children button.active')?.textContent?.trim() ?? null,
            stateTop: rect?.top ?? null,
            stateHeight: rect?.height ?? null,
            stateLeft: rect?.left ?? null,
            stateRight: rect?.right ?? null,
            count: page?.querySelector('.mastered-count b')?.textContent?.trim() ?? null
          };
        })()`);
      const assertWordArchiveLoading = async (selector, title, width) => {
        const layout = await wordArchiveLayout(selector, width);
        assert.equal(layout.viewport, width);
        assert.equal(layout.title, title);
        assert.equal(layout.activeNav, title);
        assert.ok(
          layout.scrollWidth <= width,
          `${title} horizontal overflow: ${JSON.stringify(layout)}`,
        );
        assert.equal(
          layout.count,
          '—',
          `${title} must not show a zero count before loading finishes`,
        );
        assert.ok(
          layout.stateHeight >= 300,
          `${title} loading state should reserve its result space: ${JSON.stringify(layout)}`,
        );
        assert.ok(
          layout.stateLeft >= -1 && layout.stateRight <= width + 1,
          `${title} state crosses the viewport: ${JSON.stringify(layout)}`,
        );
        assert.equal(
          await evaluate(
            `document.querySelector('${selector} .word-archive-state[aria-busy="true"]') !== null`,
          ),
          true,
        );
        assert.equal(
          await evaluate(
            `document.body.innerText.includes('${title === '学习中' ? '还没有学习中的单词' : '还没有已掌握的单词'}')`,
          ),
          false,
        );
        return layout;
      };
      const assertWordArchiveStable = async (selector, loading, width) => {
        const ready = await wordArchiveLayout(selector, width);
        assert.equal(ready.viewport, width);
        assert.equal(ready.activeNav, loading.title);
        assert.ok(ready.scrollWidth <= width, `Word archive overflow: ${JSON.stringify(ready)}`);
        assert.equal(ready.count, '0');
        assert.ok(
          Math.abs(ready.stateTop - loading.stateTop) <= 1,
          `Word archive card shifted vertically: loading=${JSON.stringify(loading)} ready=${JSON.stringify(ready)}`,
        );
        assert.ok(
          Math.abs(ready.stateHeight - loading.stateHeight) <= 1,
          `Word archive card changed height: loading=${JSON.stringify(loading)} ready=${JSON.stringify(ready)}`,
        );
        return ready;
      };
      const assertWordArchiveError = async (selector, title, width) => {
        const layout = await wordArchiveLayout(selector, width);
        assert.equal(layout.viewport, width);
        assert.equal(layout.activeNav, title);
        assert.ok(
          layout.scrollWidth <= width,
          `${title} error state overflows: ${JSON.stringify(layout)}`,
        );
        assert.equal(layout.count, '0', 'a refresh failure keeps the last authoritative count');
        const error = await evaluate(`(() => {
          const page = document.querySelector('${selector}');
          const alert = page?.querySelector('[role="alert"]');
          const button = page?.querySelector('.word-archive-pagination button');
          return { text: alert?.textContent?.trim() ?? '', button: button?.textContent?.trim() ?? '' };
        })()`);
        assert.match(error.text, /暂时|稍后|unavailable/);
        assert.match(error.button, /重试/);
        assert.equal(
          await evaluate(`document.querySelector('${selector} .mastered-empty') !== null`),
          true,
          'the cached empty state remains visible while showing the refresh error',
        );
        assert.equal(
          await evaluate(
            `document.body.innerText.includes('${title === '学习中' ? '还没有学习中的单词' : '还没有已掌握的单词'}')`,
          ),
          true,
          'the last empty result is preserved rather than cleared after refresh failure',
        );
        return layout;
      };

      await clickWordPage('学习中');
      await until(
        'window.reportFixture.pendingLearningWords.length === 1 && document.querySelector(".learning-words-page .word-archive-state[aria-busy=true]")',
      );
      const learningLoading1440 = await assertWordArchiveLoading(
        '.learning-words-page',
        '学习中',
        1440,
      );
      await capture('learning-words-loading-1440.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const learningLoading390 = await assertWordArchiveLoading(
        '.learning-words-page',
        '学习中',
        390,
      );
      await capture('learning-words-loading-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        'window.reportFixture.holdLearningWords = false; window.reportFixture.resolveLearningWords()',
      );
      await until(
        'document.querySelector(".learning-words-page .mastered-empty") && !document.querySelector(".learning-words-page .word-archive-state[aria-busy=true]")',
      );
      const learningEmpty1440 = await assertWordArchiveStable(
        '.learning-words-page',
        learningLoading1440,
        1440,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await assertWordArchiveStable('.learning-words-page', learningLoading390, 390);
      await capture('learning-words-empty-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      await clickWordPage('已掌握');
      await until(
        'window.reportFixture.pendingMasteredWords.length === 1 && document.querySelector(".mastered-page .word-archive-state[aria-busy=true]")',
      );
      const masteredLoading1440 = await assertWordArchiveLoading('.mastered-page', '已掌握', 1440);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const masteredLoading390 = await assertWordArchiveLoading('.mastered-page', '已掌握', 390);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        'window.reportFixture.holdMasteredWords = false; window.reportFixture.resolveMasteredWords()',
      );
      await until(
        'document.querySelector(".mastered-page .mastered-empty") && !document.querySelector(".mastered-page .word-archive-state[aria-busy=true]")',
      );
      const masteredEmpty1440 = await assertWordArchiveStable(
        '.mastered-page',
        masteredLoading1440,
        1440,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await assertWordArchiveStable('.mastered-page', masteredLoading390, 390);
      await capture('mastered-words-empty-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      await evaluate('window.reportFixture.failLearningWords = true');
      await clickWordPage('学习中');
      await until(
        'document.querySelector(".learning-words-page .word-archive-pagination [role=alert]")',
      );
      await assertWordArchiveError('.learning-words-page', '学习中', 1440);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await assertWordArchiveError('.learning-words-page', '学习中', 390);
      await capture('learning-words-error-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        'document.querySelector(".learning-words-page .word-archive-pagination button").click()',
      );
      await until(
        'window.reportFixture.learningWordsRequests.length === 3 && !document.querySelector(".learning-words-page .word-archive-refresh") && !document.querySelector(".learning-words-page .word-archive-pagination [role=alert]")',
      );
      assert.equal(await evaluate('window.reportFixture.learningWordsRequests.length'), 3);

      await evaluate('window.reportFixture.failMasteredWords = true');
      await clickWordPage('已掌握');
      await until('document.querySelector(".mastered-page .word-archive-pagination [role=alert]")');
      await assertWordArchiveError('.mastered-page', '已掌握', 1440);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await assertWordArchiveError('.mastered-page', '已掌握', 390);
      await capture('mastered-words-error-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        'document.querySelector(".mastered-page .word-archive-pagination button").click()',
      );
      await until(
        'window.reportFixture.masteredRequests.length === 3 && !document.querySelector(".mastered-page .word-archive-refresh") && !document.querySelector(".mastered-page .word-archive-pagination [role=alert]")',
      );
      assert.equal(await evaluate('window.reportFixture.masteredRequests.length'), 3);

      await send('Page.navigate', {
        url: new URL('/dashboard?archive-initial-error=1', baseUrl).href,
      });
      await until('document.querySelector(".progress-grid .metric-card")');
      await evaluate(
        'window.reportFixture.holdLearningWords = false; window.reportFixture.failLearningWords = true',
      );
      await clickWordPage('学习中');
      await until('document.querySelector(".learning-words-page .word-archive-state.is-error")');
      assert.equal(
        await evaluate(
          'document.querySelector(".learning-words-page .mastered-count b").textContent.trim()',
        ),
        '—',
        'a failed first load must not become an authoritative zero',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".learning-words-page .mastered-empty:not(.is-error)") !== null',
        ),
        false,
      );
      await evaluate(
        'document.querySelector(".learning-words-page .word-archive-state.is-error button").click()',
      );
      await until(
        'window.reportFixture.learningWordsRequests.length === 2 && document.querySelector(".learning-words-page .mastered-empty:not(.is-error)")',
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?archive-pagination=1', baseUrl).href,
      });
      await until('document.querySelector(".progress-grid .metric-card")');
      await evaluate(`(() => {
        const fixture = window.reportFixture;
        const learning = (index) => ({ id: 'learning-archive-' + index, word: 'learning' + index, part: 'n.', meaning: '学习词条 ' + index, meanings: [], state: 'LEARNING', accuracy: 80, reinforcement: '稳定学习', reviewCount: 1, lastReviewedAt: null, nextReviewAt: null, bookTitle: '测试词表' });
        const mastered = (index) => ({ id: 'mastered-archive-' + index, word: 'mastered' + index, part: 'n.', meaning: '掌握词条 ' + index, meanings: [], masteredAt: '2026-10-29T12:00:00.000Z' });
        fixture.holdLearningWords = false;
        fixture.holdMasteredWords = false;
        fixture.learningWordsResponse = { items: Array.from({ length: 50 }, (_, index) => learning(index)), total: 51, nextCursor: 'learning-archive-cursor-2' };
        fixture.learningWordsNextResponse = { items: [learning(50)], total: 51, nextCursor: null };
        fixture.masteredWordsResponse = { items: Array.from({ length: 50 }, (_, index) => mastered(index)), total: 51, nextCursor: 'mastered-archive-cursor-2' };
        fixture.masteredWordsNextResponse = { items: [mastered(50)], total: 51, nextCursor: null };
        fixture.failLearningNextPage = true;
        fixture.failMasteredNextPage = true;
      })()`);
      const firstArchiveRenderStartedAt = await evaluate('performance.now()');
      await clickWordPage('学习中');
      await until('document.querySelectorAll(".learning-word-table article").length === 50');
      const firstArchiveRenderMs = Math.round(
        (await evaluate('performance.now()')) - firstArchiveRenderStartedAt,
      );
      assert.ok(firstArchiveRenderMs < 1_000, `50-word page rendered in ${firstArchiveRenderMs}ms`);
      assert.equal(
        await evaluate(
          'document.querySelector(".learning-words-page .mastered-count b").textContent.trim()',
        ),
        '51',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const learningArchiveMobile = await evaluate(`(() => {
        const button = document.querySelector('.learning-words-page .word-archive-pagination button');
        const rect = button.getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, buttonLeft: rect.left, buttonRight: rect.right, rows: document.querySelectorAll('.learning-word-table article').length };
      })()`);
      assert.ok(learningArchiveMobile.scrollWidth <= 390, JSON.stringify(learningArchiveMobile));
      assert.ok(learningArchiveMobile.buttonLeft >= 0 && learningArchiveMobile.buttonRight <= 390);
      await capture('learning-words-page-one-390.png');
      await evaluate(
        'window.reportFixture.learningWordsRequests.length && (window.reportFixture.failLearningNextPage = true)',
      );
      await evaluate(
        'document.querySelector(".learning-words-page .word-archive-pagination button").click()',
      );
      await until(
        'document.querySelector(".learning-words-page .word-archive-pagination [role=alert]")',
      );
      assert.equal(
        await evaluate('document.querySelectorAll(".learning-word-table article").length'),
        50,
        'a failed next page must preserve the first page',
      );
      await evaluate(
        'document.querySelector(".learning-words-page .word-archive-pagination button").focus()',
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
      await until('document.querySelectorAll(".learning-word-table article").length === 51');
      const learningPageRequests = await evaluate('window.reportFixture.learningWordsRequests');
      assert.deepEqual(
        learningPageRequests.map((item) => item.cursor),
        [null, 'learning-archive-cursor-2', 'learning-archive-cursor-2'],
      );
      assert.ok(
        learningPageRequests.every(
          (item) => item.userId === 'report-user-a' && item.pageSize === '50',
        ),
      );
      const learningRendered = await evaluate(
        `[...document.querySelectorAll('.learning-word-table article strong')].map(item => item.textContent.trim())`,
      );
      assert.equal(new Set(learningRendered).size, 51);
      assert.equal(
        await evaluate(
          'document.querySelector(".learning-words-page .mastered-count b").textContent.trim()',
        ),
        '51',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await capture('learning-words-page-two-1440.png');

      await clickWordPage('已掌握');
      await until(
        'document.querySelectorAll(".mastered-page .mastered-list article").length === 50',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const masteredArchiveMobile = await evaluate(
        `(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: document.querySelectorAll('.mastered-page .mastered-list article').length, buttonRight: document.querySelector('.mastered-page .word-archive-pagination button').getBoundingClientRect().right }))()`,
      );
      assert.ok(masteredArchiveMobile.scrollWidth <= 390, JSON.stringify(masteredArchiveMobile));
      assert.equal(masteredArchiveMobile.cards, 50);
      assert.ok(masteredArchiveMobile.buttonRight <= 390);
      await capture('mastered-words-page-one-390.png');
      await evaluate(
        'document.querySelector(".mastered-page .word-archive-pagination button").click()',
      );
      await until('document.querySelector(".mastered-page .word-archive-pagination [role=alert]")');
      assert.equal(
        await evaluate('document.querySelectorAll(".mastered-page .mastered-list article").length'),
        50,
        'a failed next page must preserve the first page',
      );
      await evaluate(
        'document.querySelector(".mastered-page .word-archive-pagination button").click()',
      );
      await until(
        'document.querySelectorAll(".mastered-page .mastered-list article").length === 51',
      );
      const masteredPageRequests = await evaluate('window.reportFixture.masteredRequests');
      assert.deepEqual(
        masteredPageRequests.slice(-3).map((item) => item.cursor),
        [null, 'mastered-archive-cursor-2', 'mastered-archive-cursor-2'],
      );
      assert.ok(
        masteredPageRequests
          .slice(-3)
          .every((item) => item.userId === 'report-user-a' && item.pageSize === '50'),
      );
      await evaluate(
        'document.querySelector(".mastered-page .mastered-word-actions button").click()',
      );
      await until(
        'document.querySelectorAll(".mastered-page .mastered-list article").length === 50 && document.querySelector(".mastered-page .mastered-count b").textContent.trim() === "50"',
      );
      assert.equal(
        await evaluate('window.reportFixture.masteredRemoveRequests[0]'),
        'mastered-archive-0',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await capture('mastered-words-after-remove-1440.png');
      process.stdout.write(
        `Vocabulary archive browser: initial 50-word table render ${firstArchiveRenderMs}ms with intercepted fixture API; both 50-item lists retained first-page entries after an injected next-page failure, retried the identical account-scoped cursor, rendered 51 unique rows, and showed accurate totals; mastered removal updated the loaded total. 390px page-one overflow and load-more bounds stayed within viewport.\n`,
      );
      process.stdout.write(
        `word archive navigation: learning/mastered loading→empty cards stable at ≤1px for 1440/390; each failed request recovered with one retry (3 requests per archive); desktop scroll widths ${learningEmpty1440.scrollWidth}/${learningEmpty1440.viewport}px and ${masteredEmpty1440.scrollWidth}/${masteredEmpty1440.viewport}px\n`,
      );
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
