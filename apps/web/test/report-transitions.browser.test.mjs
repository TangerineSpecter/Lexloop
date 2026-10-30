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
    const loadableManifest = JSON.parse(
      await readFile(new URL('../.next/react-loadable-manifest.json', import.meta.url), 'utf8'),
    );
    const appBuildManifest = JSON.parse(
      await readFile(new URL('../.next/app-build-manifest.json', import.meta.url), 'utf8'),
    );
    const dashboardInitialFiles = new Set([
      ...(appBuildManifest.pages['/layout'] ?? []),
      ...(appBuildManifest.pages['/dashboard/page'] ?? []),
    ]);
    const dynamicChunkPaths = (key, initialFiles = dashboardInitialFiles) => {
      const entry = loadableManifest[key];
      assert.ok(entry?.files, `Missing production dynamic import entry: ${key}`);
      return entry.files
        .filter((file) => file.endsWith('.js') && !initialFiles.has(file))
        .map((file) => `/_next/${file}`);
    };
    const rootInitialFiles = new Set([
      ...(appBuildManifest.pages['/layout'] ?? []),
      ...(appBuildManifest.pages['/page'] ?? []),
    ]);
    const rootDashboardChunkPaths = dynamicChunkPaths(
      'app/page.tsx -> ../components/dashboard',
      rootInitialFiles,
    );
    const dashboardChunkPaths = dynamicChunkPaths('components/dashboard-route.tsx -> ./dashboard');
    const historyChunkPaths = dynamicChunkPaths(
      'components/dashboard.tsx -> ./learning-history-page',
    );
    const statisticsChunkPaths = dynamicChunkPaths('components/dashboard.tsx -> ./statistics-page');
    const travelChunkPaths = dynamicChunkPaths(
      'components/dashboard.tsx -> ./travel-scenario-page',
    );
    const systemSettingsChunkPaths = dynamicChunkPaths(
      'components/dashboard.tsx -> ./system-settings',
    );
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
    const protocolEvents = [];
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
        if (!message.id) {
          protocolEvents.push(message);
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
      const waitForProtocolEvent = async (method, predicate = () => true, timeoutMs = 12_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const index = protocolEvents.findIndex(
            (event) => event.method === method && predicate(event.params),
          );
          if (index >= 0) return protocolEvents.splice(index, 1)[0].params;
          await delay(20);
        }
        assert.fail(`Timed out waiting for DevTools event ${method}`);
      };
      const capture = async (name) => {
        if (!screenshotDir) return;
        await until(
          `Array.from(document.getAnimations()).every(animation => animation.playState !== 'running' && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)`,
          5000,
        );
        await mkdir(screenshotDir, { recursive: true });
        const { data } = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        await writeFile(join(screenshotDir, name), Buffer.from(data, 'base64'));
      };
      const clickAt = async (x, y) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      };
      const clickElement = async (selector) => {
        const point = await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return resolve(null);
          element.scrollIntoView({ block: 'center', inline: 'nearest' });
          requestAnimationFrame(() => {
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            resolve({ x, y, visible: rect.width > 0 && rect.height > 0 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight, hit: hit === element || element.contains(hit) });
          });
        }))`);
        assert.ok(point, `Expected visible element to click: ${selector}`);
        assert.equal(point.visible, true, `Expected in-viewport element: ${selector}`);
        assert.equal(point.hit, true, `Expected unobstructed element: ${selector}`);
        await clickAt(point.x, point.y);
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
          const holdAuthMe = sessionStorage.getItem('lexloop.test.hold-auth-me') === 'true';
          sessionStorage.removeItem('lexloop.test.hold-auth-me');
          window.reportFixture = {
            authMeRequests: 0,
            holdAuthMe,
            pendingAuthMe: [],
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
              const page = document.querySelector('.learning-history-page, .statistics-page, .dashboard-chunk-loading');
              if (page) {
                const heading = page.querySelector('h1');
                const moduleLoading = page.classList.contains('dashboard-chunk-loading');
                const card = moduleLoading
                  ? page.querySelector('.dashboard-chunk-loading-card')
                  : page.querySelector('.history-loading-card, .learning-history-empty-card, .statistics-loading-card, .statistics-empty-card');
                const headingRect = heading?.getBoundingClientRect();
                const cardRect = card?.getBoundingClientRect();
                const title = heading?.textContent?.trim() ?? '';
                window.reportTimeline.push({
                  at: performance.now(),
                  page: page.classList.contains('learning-history-page') || title === '学习历史' ? 'history' : 'statistics',
                  title,
                  activeNav: document.querySelector('.sidebar-nav .nav-item.nav-button.active span')?.textContent?.trim() ?? '',
                  viewport: innerWidth,
                  loading: moduleLoading || Boolean(page.querySelector('.history-loading-card, .statistics-loading-card')),
                  empty: !moduleLoading && Boolean(page.querySelector('.learning-history-empty-card:not(.history-loading-card), .statistics-empty-card:not(.statistics-loading-card)')),
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
            if (path.includes('/api/v1/auth/me')) {
              window.reportFixture.authMeRequests += 1;
              if (window.reportFixture.holdAuthMe) {
                return new Promise((resolve) => window.reportFixture.pendingAuthMe.push(resolve));
              }
              return Response.json({ id: JSON.parse(localStorage.getItem('lexloop.session')).user.id });
            }
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
            if (path.includes('/api/v1/micro-stories/current')) return Response.json({ completed: 0, total: 21, lesson: null, review: null });
            if (path.includes('/api/v1/learning-lab/lessons')) return Response.json({ items: [], page: 1, pageSize: 10, total: 0, hasMore: false });
            if (path.includes('/api/v1/learning-lab/grammar-evidence')) return Response.json([]);
            if (path.includes('/api/v1/practice/output/today')) return Response.json(null);
            if (path.startsWith('/api/v1/')) return Response.json({ message: 'unexpected fixture API request: ' + path }, { status: 404 });
            return nativeFetch(url, options);
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/', baseUrl).href });
      await until('document.querySelector(".welcome-page")');
      const publicHomeChunks = await evaluate(
        'performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname)',
      );
      assert.ok(
        !rootDashboardChunkPaths.some((file) => publicHomeChunks.includes(file)),
        'Visitors should not download the authenticated dashboard before a session exists',
      );
      await evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-token',
        user: { id: 'report-user-a', email: 'report@example.invalid', displayName: 'Report learner', role: 'ADMIN' }
      }))`);
      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector(".progress-grid .metric-card")');
      await until('document.querySelector(".sidebar-nav .nav-item.nav-button")');
      const initiallyLoadedChunks = await evaluate(
        'performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname)',
      );
      assert.ok(
        dashboardChunkPaths.some((file) => initiallyLoadedChunks.includes(file)),
        'The dashboard should download its split code after confirming the saved session',
      );
      assert.ok(
        !historyChunkPaths.some((file) => initiallyLoadedChunks.includes(file)) &&
          !statisticsChunkPaths.some((file) => initiallyLoadedChunks.includes(file)) &&
          !travelChunkPaths.some((file) => initiallyLoadedChunks.includes(file)) &&
          !systemSettingsChunkPaths.some((file) => initiallyLoadedChunks.includes(file)),
        'History, statistics, travel and system-settings code should wait until the learner opens those pages',
      );

      await send('Network.enable');
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      await send('Fetch.enable', {
        patterns: historyChunkPaths.map((path) => ({
          urlPattern: `${baseUrl}${path}`,
          requestStage: 'Request',
        })),
      });
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习历史")).click()',
      );
      const delayedHistoryChunk = await waitForProtocolEvent('Fetch.requestPaused', ({ request }) =>
        historyChunkPaths.some((path) => new URL(request.url).pathname === path),
      );
      await until(
        'document.querySelector(".dashboard-chunk-loading h1")?.textContent.trim() === "学习历史"',
      );
      assert.equal(await evaluate('window.reportFixture.historyRequests.length'), 0);
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '学习历史',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("词环")).click()',
      );
      await until('document.querySelector(".progress-grid .metric-card")');
      await send('Fetch.continueRequest', { requestId: delayedHistoryChunk.requestId });
      await send('Fetch.disable');
      await until(
        `performance.getEntriesByType("resource").some(entry => new URL(entry.name).pathname === ${JSON.stringify(historyChunkPaths[0])})`,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '词环',
        'a late learning-history chunk must not replace the page selected while it loaded',
      );
      assert.equal(
        await evaluate('window.reportFixture.historyRequests.length'),
        0,
        'a page left before its chunk finished must not start page data requests',
      );
      process.stdout.write(
        'deferred chunks: held history code showed the selected loading page; leaving before release kept the study page selected and started no history request.\n',
      );

      await evaluate('window.startReportTimeline()');
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("学习历史")).click()',
      );
      await until(
        'window.reportFixture.pendingHistory.length === 1 && document.querySelector(".history-loading-card")',
      );
      const historyLoadedChunks = await evaluate(
        'performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname)',
      );
      assert.ok(
        historyChunkPaths.some((file) => historyLoadedChunks.includes(file)),
        'Opening history should fetch its deferred page chunk',
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
      const statisticsLoadedChunks = await evaluate(
        'performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname)',
      );
      assert.ok(
        statisticsChunkPaths.some((file) => statisticsLoadedChunks.includes(file)),
        'Opening statistics should fetch its deferred page chunk',
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
      await send('Fetch.enable', {
        patterns: systemSettingsChunkPaths.map((path) => ({
          urlPattern: `${baseUrl}${path}`,
          requestStage: 'Request',
        })),
      });
      await clickElement('.settings-layout nav button:last-child');
      const delayedSystemSettingsChunk = await waitForProtocolEvent(
        'Fetch.requestPaused',
        ({ request }) =>
          systemSettingsChunkPaths.some((path) => new URL(request.url).pathname === path),
      );
      await until(
        'document.querySelector(".settings-layout .dashboard-chunk-loading-card[role=status]")',
      );
      const settingsLoadingLayout = await evaluate(`(() => {
        const card = document.querySelector('.settings-layout .dashboard-chunk-loading-card');
        const rect = card?.getBoundingClientRect();
        return {
          label: card?.querySelector('p')?.textContent.trim() ?? null,
          hasMark: Boolean(card?.querySelector('.learning-loading-mark')),
          skeletons: card?.querySelectorAll('.dashboard-chunk-skeleton i').length ?? 0,
          heading: document.querySelector('.settings-page h1')?.textContent.trim() ?? null,
          selected: document.querySelector('.sidebar-nav .nav-item.nav-button.active span')?.textContent.trim() ?? null,
          left: rect?.left ?? null,
          right: rect?.right ?? null,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        };
      })()`);
      assert.deepEqual(
        {
          label: settingsLoadingLayout.label,
          hasMark: settingsLoadingLayout.hasMark,
          skeletons: settingsLoadingLayout.skeletons,
          heading: settingsLoadingLayout.heading,
          selected: settingsLoadingLayout.selected,
        },
        {
          label: '正在加载系统设置…',
          hasMark: true,
          skeletons: 3,
          heading: '设置',
          selected: '账户设置',
        },
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileSettingsLoading = await evaluate(`(() => {
        const rect = document.querySelector('.settings-layout .dashboard-chunk-loading-card')?.getBoundingClientRect();
        return { left: rect?.left ?? null, right: rect?.right ?? null, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
      })()`);
      assert.ok(
        mobileSettingsLoading.left >= 0 &&
          mobileSettingsLoading.right <= 390 &&
          mobileSettingsLoading.scrollWidth <= 390,
        JSON.stringify(mobileSettingsLoading),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Fetch.continueRequest', { requestId: delayedSystemSettingsChunk.requestId });
      await send('Fetch.disable');
      await until('document.querySelector(".system-settings")');
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

      const savedDraftKey = 'lexloop.study.draft.report-user-a.retry-plan.0';
      const savedDraftValue = JSON.stringify({
        version: 1,
        answers: { wordA: { selected: ['meaning-a'], confirmed: false } },
      });
      await evaluate(
        `localStorage.setItem(${JSON.stringify(savedDraftKey)}, ${JSON.stringify(savedDraftValue)})`,
      );
      await send('Fetch.enable', {
        patterns: travelChunkPaths.map((path) => ({
          urlPattern: `${baseUrl}${path}`,
          requestStage: 'Request',
        })),
      });
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-item.nav-button")].find(button => button.textContent.includes("场景口语")).click()',
      );
      const failedTravelChunk = await waitForProtocolEvent('Fetch.requestPaused', ({ request }) =>
        travelChunkPaths.some((path) => new URL(request.url).pathname === path),
      );
      await send('Fetch.failRequest', {
        requestId: failedTravelChunk.requestId,
        errorReason: 'Failed',
      });
      await until('document.querySelector(".dashboard-chunk-error")');
      const chunkErrorState = await evaluate(`(() => {
        const error = document.querySelector('.dashboard-chunk-error');
        const retry = error?.querySelector('button');
        const rect = retry?.getBoundingClientRect();
        return {
          title: error?.querySelector('h1')?.textContent.trim() ?? null,
          selected: document.querySelector('.sidebar-nav .nav-item.nav-button.active span')?.textContent.trim() ?? null,
          message: error?.innerText ?? '',
          retryVisible: Boolean(retry && rect.width > 0 && rect.height > 0),
          retryLabel: retry?.textContent.trim() ?? null,
          viewport: innerWidth,
          scrollWidth: document.documentElement.scrollWidth
        };
      })()`);
      assert.equal(chunkErrorState.title, '场景口语');
      assert.equal(chunkErrorState.selected, '场景口语');
      assert.match(chunkErrorState.message, /本机草稿不会被清除/);
      assert.equal(chunkErrorState.retryVisible, true);
      assert.equal(chunkErrorState.retryLabel, '重新加载栏目');
      assert.ok(chunkErrorState.scrollWidth <= chunkErrorState.viewport);
      await send('Fetch.disable');
      await evaluate('document.querySelector(".dashboard-chunk-error button").click()');
      await until(
        'document.querySelector(".travel-page h1")?.textContent.trim() === "把英语，带到真正要说的地方。"',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sidebar-nav .nav-item.nav-button.active span")?.textContent.trim()',
        ),
        '场景口语',
        'retry should reopen the selected page instead of resetting the dashboard to study',
      );
      assert.equal(
        await evaluate(`localStorage.getItem(${JSON.stringify(savedDraftKey)})`),
        savedDraftValue,
        'chunk retry must not clear local study drafts',
      );
      await capture('dashboard-travel-1440.png');

      await evaluate(
        'window.dashboardSidebarReference = document.querySelector(".study-sidebar"); true',
      );
      const readingTriggerSelector = '[aria-label="阅读难度"]';
      const readingListboxSelector = '[role="listbox"][aria-label="阅读难度"]';
      const grammarNavSelector = '.sidebar-nav a[href="/dashboard/notebook?tab=grammar"].active';
      const outputNavSelector = '.sidebar-nav a[href="/dashboard/practice?tab=output"].active';
      const readingNavSelector = '.sidebar-nav a[href="/dashboard/notebook?tab=reading"]';
      const mistakeTriggerSelector = '.mistakes-toolbar [aria-label="按题型筛选"]';
      const mistakeListboxSelector = '[role="listbox"][aria-label="按题型筛选"]';
      const inShellAuthRequests = await evaluate('window.reportFixture.authMeRequests');
      const clickRoute = async (selector, expectedPath, expectedHeading) => {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await until(`location.pathname + location.search === ${JSON.stringify(expectedPath)}`);
        await until(
          `Boolean(document.querySelector(".study-sidebar") && [...document.querySelectorAll("h1, h2")].some(node => node.textContent.trim() === ${JSON.stringify(expectedHeading)}))`,
        );
        const state = await evaluate(`(() => ({
          shell: Boolean(document.querySelector('.study-shell')),
          sidebar: Boolean(document.querySelector('.study-sidebar')),
          page: document.querySelector('[data-dashboard-route]')?.dataset.dashboardRoute ?? null,
          titleText: [...document.querySelectorAll('h1, h2')].find(node => node.textContent.trim() === ${JSON.stringify(expectedHeading)})?.textContent.trim() ?? null,
          titleLines: (() => { const heading = [...document.querySelectorAll('h1, h2')].find(node => node.textContent.trim() === ${JSON.stringify(expectedHeading)}); if (!heading) return null; const range = document.createRange(); range.selectNodeContents(heading); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size; })(),
          returnButton: document.querySelector('.dashboard-return-button')?.getBoundingClientRect().toJSON() ?? null,
          titleRect: [...document.querySelectorAll('h1, h2')].find(node => node.textContent.trim() === ${JSON.stringify(expectedHeading)})?.getBoundingClientRect().toJSON() ?? null,
          contentLeft: document.querySelector('.study-shell')?.getBoundingClientRect().left ?? null,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth
        }))()`);
        assert.equal(state.shell, true, 'section changes should retain the shared dashboard shell');
        assert.equal(state.sidebar, true);
        assert.equal(
          state.page,
          expectedPath.includes('/notebook')
            ? 'notebook'
            : expectedPath.includes('/micro-stories')
              ? 'micro-stories'
              : expectedPath.includes('/practice')
                ? 'practice'
                : state.page,
        );
        assert.equal(state.titleText, expectedHeading);
        assert.ok(
          state.scrollWidth <= state.viewport,
          `horizontal overflow: ${state.scrollWidth}/${state.viewport}`,
        );
        assert.ok(state.returnButton, 'page should have the shared left return button');
        assert.ok(
          state.returnButton.left - state.contentLeft >= (state.viewport <= 680 ? 12 : 20),
          `return button should have a responsive content gutter: ${state.returnButton.left - state.contentLeft}px at ${state.viewport}px`,
        );
        if (state.viewport <= 680) {
          assert.ok(
            state.titleLines <= 1,
            `embedded page title should avoid an orphan line at ${state.viewport}px: ${state.titleLines} lines`,
          );
        }
        assert.ok(
          Math.abs(state.returnButton.left - state.titleRect.left) <= 2,
          `return and title should share the content left edge: ${state.returnButton.left} vs ${state.titleRect.left}`,
        );
        assert.equal(
          await evaluate(
            'document.querySelector(".study-sidebar") === window.dashboardSidebarReference',
          ),
          true,
          'dashboard shell should remain mounted while the right pane changes',
        );
        return state;
      };

      const notebookState = await clickRoute(
        '.sidebar-nav a[href="/dashboard/notebook"]',
        '/dashboard/notebook',
        '让收藏，接上下一次学习。',
      );
      await capture('dashboard-notebook-1440.png');
      await clickRoute(
        '.sidebar-nav a[href="/dashboard/micro-stories"]',
        '/dashboard/micro-stories',
        '生活缝隙里的英语故事',
      );
      await capture('dashboard-micro-stories-1440.png');
      await clickRoute(
        '.sidebar-nav a[href="/dashboard/notebook?tab=reading"]',
        '/dashboard/notebook?tab=reading',
        '在短文里，再遇见生词',
      );
      await capture('dashboard-reading-1440.png');
      const readingControl = await evaluate(`(() => {
        const button = document.querySelector('.styled-select-trigger, [class*="styled-select_trigger"]');
        return button ? { label: button.getAttribute('aria-label'), rect: button.getBoundingClientRect().toJSON(), text: button.textContent.trim() } : null;
      })()`);
      assert.equal(readingControl?.label, '阅读难度');
      assert.ok(
        readingControl.rect.height < 60,
        `reading difficulty control is unexpectedly tall: ${readingControl.rect.height}`,
      );
      await clickElement('[aria-label="阅读难度"]');
      await until(
        `document.querySelector(${JSON.stringify('[role="listbox"][aria-label="阅读难度"]')})`,
      );
      const readingMenuBounds = await evaluate(`(() => {
        const menu = document.querySelector('[role="listbox"][aria-label="阅读难度"]');
        const rect = menu.getBoundingClientRect();
        const first = menu.querySelector('[role="option"]');
        const firstRect = first.getBoundingClientRect();
        const hit = document.elementFromPoint(firstRect.left + 8, firstRect.top + 8);
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, hit: Boolean(hit && first.contains(hit)), firstText: first.textContent.trim() };
      })()`);
      assert.ok(readingMenuBounds.hit, 'visible reading option must receive pointer hits');
      const readingOptionPoint = await evaluate(`(() => {
        const option = [...document.querySelectorAll('[role="listbox"][aria-label="阅读难度"] [role="option"]')].find((item) => item.textContent.includes('A2'));
        const rect = option?.getBoundingClientRect();
        return rect ? { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 } : null;
      })()`);
      assert.ok(readingOptionPoint, 'A2 reading level should be visible in the styled menu');
      await clickAt(readingOptionPoint.x, readingOptionPoint.y);
      await until(
        `document.querySelector(${JSON.stringify(readingTriggerSelector)}).textContent.includes("A2") && !document.querySelector("[role=listbox]")`,
      );
      await clickElement('[aria-label="阅读难度"]');
      await until(`document.querySelector(${JSON.stringify(readingListboxSelector)})`);
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
      await until(`!document.querySelector(${JSON.stringify(readingListboxSelector)})`);
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '阅读难度');
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'ArrowDown',
        code: 'ArrowDown',
        windowsVirtualKeyCode: 40,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowDown',
        code: 'ArrowDown',
        windowsVirtualKeyCode: 40,
      });
      await until(
        `document.querySelector(${JSON.stringify(readingListboxSelector)}) && document.activeElement.getAttribute("role") === "option"`,
      );
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'ArrowDown',
        code: 'ArrowDown',
        windowsVirtualKeyCode: 40,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowDown',
        code: 'ArrowDown',
        windowsVirtualKeyCode: 40,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await until(
        `document.querySelector(${JSON.stringify(readingTriggerSelector)}).textContent.includes("B1")`,
      );

      await clickRoute(
        '.sidebar-nav a[href="/dashboard/notebook?tab=grammar"]',
        '/dashboard/notebook?tab=grammar',
        '从表达中的问题，练起',
      );
      await clickRoute(
        '.sidebar-nav a[href="/dashboard/practice?tab=output"]',
        '/dashboard/practice?tab=output',
        '让学过的词，用起来。',
      );
      await capture('dashboard-practice-1440.png');

      await evaluate('window.history.back()');
      await until('location.pathname + location.search === "/dashboard/notebook?tab=grammar"');
      await until(
        `document.querySelector(".study-shell") && document.querySelector(${JSON.stringify(grammarNavSelector)})`,
      );
      await evaluate('window.history.forward()');
      await until('location.pathname + location.search === "/dashboard/practice?tab=output"');
      await until(`document.querySelector(${JSON.stringify(outputNavSelector)})`);

      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await evaluate(`document.querySelector(${JSON.stringify(readingNavSelector)}).click()`);
      await until('location.pathname + location.search === "/dashboard/notebook?tab=reading"');
      await clickElement('[aria-label="阅读难度"]');
      await until(`document.querySelector(${JSON.stringify(readingListboxSelector)})`);
      const reducedMotion = await evaluate(`({
        routeAnimation: getComputedStyle(document.querySelector('.dashboard-route-content')).animationName,
        localAnimation: getComputedStyle(document.querySelector('.dashboard-local-transition')).animationName,
        menuAnimation: getComputedStyle(document.querySelector('[role="listbox"][aria-label="阅读难度"]')).animationName
      })`);
      assert.deepEqual(reducedMotion, {
        routeAnimation: 'none',
        localAnimation: 'none',
        menuAnimation: 'none',
      });
      await evaluate(`document.querySelector(${JSON.stringify(readingTriggerSelector)}).click()`);

      await clickElement('.sidebar-book');
      await until('document.querySelector(".account-menu")?.dataset.positioned === "true"');
      const reducedAccountMenu = await evaluate(
        'getComputedStyle(document.querySelector(".account-menu")).animationName',
      );
      assert.equal(reducedAccountMenu, 'none');
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
      await until(
        'document.querySelector(".sidebar-book")?.getAttribute("aria-expanded") === "false" && document.activeElement === document.querySelector(".sidebar-book")',
      );
      assert.equal(
        await evaluate(
          '!document.querySelector(".account-menu") || document.querySelector(".account-menu").getAttribute("aria-hidden") === "true"',
        ),
        true,
        'Escape should close the account menu and return focus to its trigger',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await clickElement('.menu-trigger');
      await until(
        'document.querySelector(".study-sidebar.is-open") && document.querySelector(".sidebar-scrim")',
      );
      const reducedMobileNavigation = await evaluate(`({
        sidebar: getComputedStyle(document.querySelector('.study-sidebar')).transitionDuration,
        scrim: getComputedStyle(document.querySelector('.sidebar-scrim')).animationName
      })`);
      assert.deepEqual(reducedMobileNavigation, { sidebar: '0s', scrim: 'none' });
      const scrimPoint = await evaluate(`(() => {
        const scrim = document.querySelector('.sidebar-scrim');
        const sidebar = document.querySelector('.study-sidebar');
        const x = Math.min(innerWidth - 12, sidebar.getBoundingClientRect().right + 20);
        const y = innerHeight / 2;
        return { x, y, hit: document.elementFromPoint(x, y) === scrim };
      })()`);
      assert.equal(scrimPoint.hit, true, 'the scrim must be clickable outside the open sidebar');
      await clickAt(scrimPoint.x, scrimPoint.y);
      await until('!document.querySelector(".sidebar-scrim")');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Emulation.setEmulatedMedia', { features: [] });

      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-children button")].find(button => button.textContent.includes("待巩固")).click()',
      );
      await until(
        'location.search === "?view=mistakes" && document.querySelector(".mistakes-order-note")',
      );
      const mistakesDesktop = await evaluate(`(() => {
        const page = document.querySelector('.mistakes-page');
        const button = page.querySelector('.dashboard-return-button').getBoundingClientRect();
        const title = page.querySelector('h1').getBoundingClientRect();
        const note = page.querySelector('.mistakes-order-note').getBoundingClientRect();
        const toolbar = page.querySelector('.mistakes-toolbar').getBoundingClientRect();
        return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, buttonLeft: button.left, titleLeft: title.left, noteTop: note.top, toolbarBottom: toolbar.bottom };
      })()`);
      assert.ok(mistakesDesktop.scrollWidth <= mistakesDesktop.viewport);
      assert.ok(Math.abs(mistakesDesktop.buttonLeft - mistakesDesktop.titleLeft) <= 2);
      assert.ok(mistakesDesktop.noteTop >= mistakesDesktop.toolbarBottom + 8);
      await capture('dashboard-mistakes-1440.png');
      await evaluate('document.querySelector(".dashboard-return-button").click()');
      await until('location.pathname === "/dashboard" && document.querySelector(".progress-grid")');
      assert.equal(
        await evaluate('window.reportFixture.authMeRequests'),
        inShellAuthRequests,
        'right-pane navigation must not repeat dashboard authentication checks',
      );
      await evaluate(`document.querySelector(${JSON.stringify(readingNavSelector)}).click()`);
      await until(
        `location.pathname === "/dashboard/notebook" && document.querySelector(${JSON.stringify(readingTriggerSelector)})`,
      );

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await clickRoute(
        '.sidebar-nav a[href="/dashboard/notebook?tab=reading"]',
        '/dashboard/notebook?tab=reading',
        '在短文里，再遇见生词',
      );
      await evaluate(`document.querySelector(${JSON.stringify(readingTriggerSelector)}).click()`);
      await until(`document.querySelector(${JSON.stringify(readingListboxSelector)})`);
      const narrowMenu = await evaluate(
        `(() => { const rect = document.querySelector('[role="listbox"][aria-label="阅读难度"]').getBoundingClientRect(); return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}; })()`,
      );
      assert.ok(narrowMenu.left >= 0 && narrowMenu.right <= narrowMenu.viewport);
      assert.ok(narrowMenu.bottom <= 844 && narrowMenu.scrollWidth <= narrowMenu.viewport);
      await capture('dashboard-reading-390.png');
      await evaluate(`document.querySelector(${JSON.stringify(readingTriggerSelector)}).click()`);
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-children button")].find(button => button.textContent.includes("待巩固")).click()',
      );
      await until(
        `location.search === "?view=mistakes" && document.querySelector(${JSON.stringify(mistakeTriggerSelector)})`,
      );
      const mistakesLayout = await evaluate(`(() => {
        const page = document.querySelector('.mistakes-page');
        const button = page.querySelector('.dashboard-return-button');
        const title = page.querySelector('h1');
        const note = page.querySelector('.mistakes-order-note');
        const toolbar = page.querySelector('.mistakes-toolbar');
        return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, buttonLeft: button.getBoundingClientRect().left, titleLeft: title.getBoundingClientRect().left, noteTop: note.getBoundingClientRect().top, toolbarBottom: toolbar.getBoundingClientRect().bottom, hasNativeSelect: Boolean(toolbar.querySelector('select')) };
      })()`);
      assert.ok(mistakesLayout.scrollWidth <= mistakesLayout.viewport);
      assert.ok(Math.abs(mistakesLayout.buttonLeft - mistakesLayout.titleLeft) <= 2);
      assert.ok(
        mistakesLayout.noteTop >= mistakesLayout.toolbarBottom + 8,
        'sort explanation should have a distinct gap below the toolbar',
      );
      assert.equal(mistakesLayout.hasNativeSelect, false);
      await clickElement('.mistakes-toolbar [aria-label="按题型筛选"]');
      await until(`document.querySelector(${JSON.stringify(mistakeListboxSelector)})`);
      const mistakeMenu = await evaluate(
        `(() => { const rect = document.querySelector('[role="listbox"][aria-label="按题型筛选"]').getBoundingClientRect(); return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}; })()`,
      );
      assert.ok(mistakeMenu.left >= 0 && mistakeMenu.right <= mistakeMenu.viewport);
      assert.ok(mistakeMenu.bottom <= 844 && mistakeMenu.scrollWidth <= mistakeMenu.viewport);
      await capture('dashboard-mistakes-390.png');
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
      await until(`!document.querySelector(${JSON.stringify(mistakeListboxSelector)})`);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        '按题型筛选',
      );
      await evaluate('document.querySelector(".dashboard-return-button").click()');
      await until('location.pathname === "/dashboard" && document.querySelector(".progress-grid")');

      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.uiRouteFrames = []; let uiFrame = 0; const sampleUiRoute = () => { const route = document.querySelector('[data-dashboard-route]')?.dataset.dashboardRoute ?? (document.querySelector('[data-dashboard-bootstrap-loading]') ? 'bootstrap' : null); const title = document.querySelector('.study-shell[data-dashboard-route] .study-content h1, .study-shell[data-dashboard-route] h1, .study-shell[data-dashboard-route] h2')?.textContent.trim() ?? ''; window.uiRouteFrames.push({ route, title }); if (uiFrame++ < 220) requestAnimationFrame(sampleUiRoute); }; requestAnimationFrame(sampleUiRoute);`,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard/notebook?tab=reading', baseUrl).href,
      });
      await until(
        'document.querySelector(".study-shell") && location.pathname === "/dashboard/notebook" && [...document.querySelectorAll("h1, h2")].some(node => node.textContent.trim() === "在短文里，再遇见生词")',
      );
      const deepLinkState = await evaluate(`({
        page: document.querySelector('[data-dashboard-route]')?.dataset.dashboardRoute ?? null,
        tab: document.querySelector('nav[aria-label="生词与学习笔记"] button[aria-current]')?.textContent.trim() ?? null,
        sidebar: Boolean(document.querySelector('.study-sidebar')),
        frames: window.uiRouteFrames ?? []
      })`);
      assert.equal(deepLinkState.page, 'notebook');
      assert.equal(deepLinkState.tab, '生词短文精读');
      assert.equal(deepLinkState.sidebar, true);
      assert.ok(
        !deepLinkState.frames.some(
          (frame) => frame.route === 'study' && frame.title === '学习进度',
        ),
        'deep-link entry must not flash the dashboard study page before rendering the selected section',
      );
      assert.equal(
        await evaluate('window.reportFixture.authMeRequests'),
        1,
        'a direct deep link authenticates once after the full document navigation',
      );
      await capture('dashboard-deep-link-reading-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await evaluate(`sessionStorage.setItem('lexloop.test.hold-auth-me', 'true')`);
      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector("[data-dashboard-bootstrap-loading]")');
      const bootstrapBounds = await evaluate(`(() => {
        const root = document.querySelector('.dashboard-bootstrap');
        return { width: root.scrollWidth, viewport: innerWidth, status: root.querySelector('[role="status"]')?.textContent.trim() ?? '', skeletons: root.querySelectorAll('.dashboard-bootstrap-line, .dashboard-bootstrap-block').length, lineAnimation: getComputedStyle(root.querySelector('.dashboard-bootstrap-line')).animationName, blockAnimation: getComputedStyle(root.querySelector('.dashboard-bootstrap-block')).animationName };
      })()`);
      assert.equal(bootstrapBounds.status, '正在展开你的词环…');
      assert.ok(bootstrapBounds.skeletons >= 4);
      assert.ok(bootstrapBounds.width <= bootstrapBounds.viewport);
      assert.equal(bootstrapBounds.lineAnimation, 'none');
      assert.equal(bootstrapBounds.blockAnimation, 'none');
      await capture('dashboard-bootstrap-loading-1440.png');
      await until('window.reportFixture.pendingAuthMe.length === 1');
      await evaluate(
        `window.reportFixture.pendingAuthMe.shift()?.(Response.json({ id: JSON.parse(localStorage.getItem('lexloop.session')).user.id }))`,
      );
      await until('document.querySelector(".study-shell .progress-grid")');
      await send('Emulation.setEmulatedMedia', { features: [] });
      process.stdout.write(
        `deferred chunks: failed travel chunk showed a selected-page retry; reload restored the page and preserved the local draft. Shared-shell routes retained the dashboard for five learning entries; URL/back-forward and deep-link selection were preserved. Return/title aligned within 2px at desktop; reading selector ${readingControl.rect.width.toFixed(0)}x${readingControl.rect.height.toFixed(0)}px and menu bounds checked. 390px reading/mistake layouts ${narrowMenu.scrollWidth}/${narrowMenu.viewport}px and ${mistakesLayout.scrollWidth}/${mistakesLayout.viewport}px; reduced-motion route/local/menu/account/sidebar/scrim ${reducedMotion.routeAnimation}/${reducedMotion.localAnimation}/${reducedMotion.menuAnimation}/${reducedAccountMenu}/${reducedMobileNavigation.sidebar}/${reducedMobileNavigation.scrim}. Bootstrap retained ${bootstrapBounds.skeletons} layout skeletons at ${bootstrapBounds.width}/${bootstrapBounds.viewport}px with line/block animations ${bootstrapBounds.lineAnimation}/${bootstrapBounds.blockAnimation}.\n`,
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
