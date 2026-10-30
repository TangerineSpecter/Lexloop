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
  'dashboard keeps streak and progress summaries honest through loading, failure and retries',
  { skip: !baseUrl, timeout: 30_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-streak-test-'));
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
    browser.on('error', (error) => {
      launchError = error;
    });
    let socket;
    const waiting = new Map();
    let sequence = 0;
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
        const result = JSON.parse(event.data);
        if (!result.id) return;
        const pending = waiting.get(result.id);
        if (!pending) return;
        waiting.delete(result.id);
        if (result.error) pending.reject(new Error(result.error.message));
        else pending.resolve(result.result);
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
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A navigation can briefly invalidate the execution context.
          }
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
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
      const untilProgressRequestsSettle = async (expectedUserId) => {
        let previousCount = -1;
        let stableChecks = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          const state = await evaluate(`({
            requestCount: window.progressFixture.requests.length,
            pendingCount: window.progressFixture.resolvers.length,
            allBelongToExpectedUser: window.progressFixture.requests.every(({ userId }) => userId === ${JSON.stringify(expectedUserId)}),
          })`);
          if (
            state.requestCount > 0 &&
            state.requestCount === state.pendingCount &&
            state.allBelongToExpectedUser &&
            state.pendingCount === previousCount
          ) {
            stableChecks++;
            if (stableChecks >= 3) return state;
          } else {
            stableChecks = 0;
          }
          previousCount = state.pendingCount;
          await delay(100);
        }
        assert.fail(
          `Progress requests did not settle: ${JSON.stringify(await evaluate(`({ requests: window.progressFixture.requests, pending: window.progressFixture.resolvers.map(({ index }) => index) })`))}`,
        );
      };
      await send('Page.enable');
      await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'fixture', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
      const query = new URL(location.href).searchParams;
      window.streakFixture = { currentStreak: query.has('streak-empty') ? 0 : 4, todayActive: query.has('today-active'), failed: query.has('streak-error'), loading: query.has('streak-loading'), requests: [] };
      window.progressFixture = {
        failAll: query.has('progress-error'),
        holdInitialRequests: query.has('progress-race'),
        holdUserB: query.has('progress-user-b-loading'),
        requests: [],
        resolvers: [],
        resolve: (index, response) => {
          const request = window.progressFixture.resolvers.find((item) => item.index === index);
          if (!request) throw new Error('No pending progress request at index ' + index);
          window.progressFixture.resolvers = window.progressFixture.resolvers.filter((item) => item !== request);
          request.resolve(response);
        },
      };
      window.defaultBookFixture = {
        fail: query.has('default-book-error'),
        hold: query.has('default-book-loading'),
        requests: [],
        resolvers: [],
        resolve: (index, response) => {
          const request = window.defaultBookFixture.resolvers.find((item) => item.index === index);
          if (!request) throw new Error('No pending default book request at index ' + index);
          window.defaultBookFixture.resolvers = window.defaultBookFixture.resolvers.filter((item) => item !== request);
          request.resolve(response);
        },
      };
      window.bookPickerRequests = [];
      const nativeFetch = window.fetch;
      window.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: JSON.parse(localStorage.getItem('lexloop.session')).user.id });
        if (path.includes('/api/v1/reports/streak')) {
          window.streakFixture.requests.push({ method: options.method ?? 'GET', url: path });
          if (window.streakFixture.failed) throw new Error('Fixture failure');
          if (window.streakFixture.loading) await new Promise(resolve => setTimeout(resolve, 700));
          return Response.json({ currentStreak: window.streakFixture.currentStreak, todayActive: window.streakFixture.todayActive });
        }
        if (path.includes('/api/v1/vocabulary/default')) {
          const index = window.defaultBookFixture.requests.length;
          window.defaultBookFixture.requests.push(index);
          if (window.defaultBookFixture.fail) return Response.json({ message: 'Fixture book unavailable' }, { status: 503 });
          if (window.defaultBookFixture.hold) {
            return new Promise((resolve) => window.defaultBookFixture.resolvers.push({ index, resolve }));
          }
          return Response.json(window.defaultBookFixture.book ?? null);
        }
        if (path.includes('/api/v1/vocabulary/system')) {
          window.bookPickerRequests.push('system');
          return Response.json({
            categories: [{ key: 'general', label: '通用', count: 1 }],
            books: [{ id: 'starter-book', category: 'general', categoryLabel: '通用', title: '入门词表', publisher: null, grade: null, totalWords: 300, learnedWords: 0, isLearning: false, isDefault: false }],
          });
        }
        if (path.endsWith('/api/v1/vocabulary/learning')) {
          window.bookPickerRequests.push('learning');
          return Response.json([]);
        }
        if (path.endsWith('/api/v1/vocabulary/books/starter-book/start') && options.method === 'POST') {
          window.defaultBookFixture.book = { id: 'starter-book', title: '入门词表', totalWords: 300 };
          return Response.json(window.defaultBookFixture.book);
        }
        if (path.includes('/api/v1/vocabulary/progress-summary')) {
          const userId = JSON.parse(localStorage.getItem('lexloop.session')).user.id;
          const index = window.progressFixture.requests.length;
          window.progressFixture.requests.push({ userId, index });
          if (window.progressFixture.failAll) return Response.json({ message: 'Fixture progress unavailable' }, { status: 503 });
          if (
            (window.progressFixture.holdInitialRequests && userId === 'fixture') ||
            (window.progressFixture.holdUserB && userId === 'user-b')
          ) {
            return new Promise((resolve) => window.progressFixture.resolvers.push({ index, resolve }));
          }
          return Response.json(new URL(location.href).searchParams.has('new-user')
            ? { totalWords: 0, masteredWords: 0, progress: 0 }
            : userId === 'user-b'
            ? { totalWords: 10, masteredWords: 7, progress: 70 }
            : { totalWords: 10, masteredWords: 3, progress: 30 });
        }
        if (path.includes('/api/v1/vocabulary/dashboard-words'))
          return Response.json({
            defaultNewWordCount: 5,
            reviewWords: [],
            newWords: window.defaultBookFixture.book
              ? [{ id: 'starter-word', word: 'begin', part: 'v.', meaning: '开始' }]
              : [],
          });
        if (path.includes('/api/v1/study/plans')) return Response.json([]);
        if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
        if (path.includes('/api/v1/')) throw new Error('Unexpected API request: ' + path);
        return nativeFetch(url, options);
      };
    `,
      });

      await send('Page.navigate', { url: new URL('/dashboard?new-user=1', baseUrl).href });
      await until('document.querySelector(".streak-count b")?.textContent === "4"');
      await until('document.body.textContent.includes("今天还没有已完成的学习活动")');
      await until(
        'document.querySelectorAll(".progress-grid .metric-card")[1]?.querySelector(".metric-front b")?.textContent === "0"',
      );
      const bookMetric = 'document.querySelectorAll(".progress-grid .metric-card")[0]';
      await until(
        `${bookMetric}.querySelector(".metric-front small")?.textContent === "请选择一个系统词表"`,
      );
      assert.equal(
        await evaluate(`${bookMetric}.querySelector(".metric-front b")?.textContent`),
        '—',
      );
      assert.equal(
        await evaluate('document.querySelector(".sidebar-book > div > span")?.textContent'),
        '请选择词表',
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".progress-grid .metric-card")[1].querySelector(".metric-front small")?.textContent',
        ),
        '学习进度 0.0%',
      );
      await until('document.querySelector(".book-selection-prompt button")');
      assert.equal(
        await evaluate(
          'document.querySelector(".book-selection-prompt").innerText.replace(/\\s+/g, " ").trim()',
        ),
        '先选一个词表 选好想学的词汇目标后，就能安排今天的新词和到期复习。 选择词表开始',
      );
      assert.equal(await evaluate('document.querySelector(".create").disabled'), true);
      assert.equal(
        await evaluate('document.querySelector(".create").textContent.includes("先选择词表")'),
        true,
      );
      assert.equal(await evaluate('window.bookPickerRequests.length'), 0);
      await capture('new-learner-no-book-desktop.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until(
        '!document.querySelector(".study-sidebar").classList.contains("is-open") && new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".study-sidebar")).transform).m41 <= -219',
      );
      await evaluate(
        'document.querySelector(".book-selection-prompt").scrollIntoView({ block: "center" })',
      );
      const newLearnerPromptMobile = await evaluate(`(() => {
        const prompt = document.querySelector('.book-selection-prompt').getBoundingClientRect();
        const button = document.querySelector('.book-selection-prompt button').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          promptLeft: prompt.left, promptRight: prompt.right, buttonLeft: button.left, buttonRight: button.right,
          buttonVisible: button.width > 0 && button.bottom <= innerHeight };
      })()`);
      assert.ok(
        newLearnerPromptMobile.page <= newLearnerPromptMobile.viewport &&
          newLearnerPromptMobile.promptLeft >= 0 &&
          newLearnerPromptMobile.promptRight <= newLearnerPromptMobile.viewport &&
          newLearnerPromptMobile.buttonLeft >= 0 &&
          newLearnerPromptMobile.buttonRight <= newLearnerPromptMobile.viewport &&
          newLearnerPromptMobile.buttonVisible,
        JSON.stringify(newLearnerPromptMobile),
      );
      await capture('new-learner-no-book-mobile.png');
      await evaluate('document.querySelector(".book-selection-prompt button").click()');
      await until('document.querySelector(".book-drawer")');
      assert.equal(
        await evaluate('document.querySelector(".book-drawer").getAttribute("aria-label")'),
        '选择词表',
      );
      await evaluate(
        '[...document.querySelectorAll(".book-tabs button")].find((button) => button.textContent.includes("系统词表")).click()',
      );
      await until('document.querySelector(".book-choice")?.textContent.includes("入门词表")');
      assert.deepEqual(await evaluate('window.bookPickerRequests'), ['system', 'learning']);
      await evaluate('document.querySelector(".book-choice button").click()');
      await until('window.defaultBookFixture.book?.id === "starter-book"');
      await until('document.querySelector(".book-choice button.current")');
      await evaluate('document.querySelector(".book-drawer header button").click()');
      await until('document.querySelector(".book-drawer") === null');
      await until('document.querySelector(".word-row strong")?.textContent === "begin"');
      assert.equal(
        await evaluate('document.querySelector(".book-selection-prompt") === null'),
        true,
      );
      assert.equal(await evaluate('document.querySelector(".create").disabled'), false);
      assert.deepEqual(await evaluate('window.bookPickerRequests'), [
        'system',
        'learning',
        'system',
      ]);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await evaluate('document.querySelector(".streak-start-link")?.getAttribute("href")'),
        '/dashboard/micro-stories',
      );
      assert.equal(await evaluate('document.body.textContent.includes("立刻打卡")'), false);
      assert.equal(await evaluate('window.streakFixture.requests[0].method'), 'GET');
      assert.equal(
        await evaluate('window.streakFixture.requests[0].url.includes("timeZone=Asia%2FShanghai")'),
        true,
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?default-book-loading=1', baseUrl).href,
      });
      await until(
        'location.search.includes("default-book-loading") && document.readyState === "complete"',
      );
      await send('Page.reload');
      await until('window.defaultBookFixture?.hold');
      await until(
        `${bookMetric}.querySelector(".metric-front small [role=status]")?.textContent === "正在读取词表…"`,
      );
      assert.equal(
        await evaluate(`${bookMetric}.querySelector(".metric-front b")?.textContent`),
        '—',
      );
      const pendingDefaultBook = await evaluate('window.defaultBookFixture.requests.at(-1)');
      await evaluate(
        `window.defaultBookFixture.resolve(${pendingDefaultBook}, Response.json({ id: 'book-zero', title: '空词表测试', totalWords: 0 }))`,
      );
      await until(`${bookMetric}.querySelector(".metric-front b")?.textContent === "0"`);
      assert.equal(
        await evaluate(`${bookMetric}.querySelector(".metric-front small")?.textContent`),
        '空词表测试',
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?default-book-error=1', baseUrl).href,
      });
      await until(
        'location.search.includes("default-book-error") && document.readyState === "complete"',
      );
      await send('Page.reload');
      await until('window.defaultBookFixture?.fail');
      await until(`${bookMetric}.querySelector(".metric-detail-error button")`);
      assert.equal(
        await evaluate(`${bookMetric}.querySelector(".metric-front b")?.textContent`),
        '—',
      );
      assert.equal(
        await evaluate(
          `${bookMetric}.querySelector(".metric-detail-error [role=alert]")?.textContent`,
        ),
        '词表信息暂时无法加载',
      );
      assert.equal(
        await evaluate('document.querySelector(".sidebar-book > div > span")?.textContent'),
        '词表读取失败',
      );
      const failedDefaultBookRequestCount = await evaluate(
        'window.defaultBookFixture.requests.length',
      );
      const desktopFailureLayout = await evaluate(`(() => {
        const metric = ${bookMetric};
        const retry = metric.querySelector('.metric-detail-error button');
        const rect = retry.getBoundingClientRect();
        return {
          viewport: document.documentElement.clientWidth,
          document: document.documentElement.scrollWidth,
          retryLeft: rect.left,
          retryRight: rect.right,
          retryVisible: rect.width > 0 && rect.bottom <= innerHeight,
        };
      })()`);
      assert.equal(
        desktopFailureLayout.document <= desktopFailureLayout.viewport,
        true,
        JSON.stringify(desktopFailureLayout),
      );
      assert.equal(desktopFailureLayout.retryLeft >= 0, true, JSON.stringify(desktopFailureLayout));
      assert.equal(
        desktopFailureLayout.retryRight <= desktopFailureLayout.viewport,
        true,
        JSON.stringify(desktopFailureLayout),
      );
      assert.equal(desktopFailureLayout.retryVisible, true, JSON.stringify(desktopFailureLayout));
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileFailureLayout = await evaluate(`(() => {
        const metric = ${bookMetric};
        const retry = metric.querySelector('.metric-detail-error button');
        const rect = retry.getBoundingClientRect();
        return {
          viewport: document.documentElement.clientWidth,
          document: document.documentElement.scrollWidth,
          retryLeft: rect.left,
          retryRight: rect.right,
          retryVisible: rect.width > 0 && rect.bottom <= innerHeight,
        };
      })()`);
      assert.equal(
        mobileFailureLayout.document <= mobileFailureLayout.viewport,
        true,
        JSON.stringify(mobileFailureLayout),
      );
      assert.equal(mobileFailureLayout.retryLeft >= 0, true, JSON.stringify(mobileFailureLayout));
      assert.equal(
        mobileFailureLayout.retryRight <= mobileFailureLayout.viewport,
        true,
        JSON.stringify(mobileFailureLayout),
      );
      assert.equal(mobileFailureLayout.retryVisible, true, JSON.stringify(mobileFailureLayout));
      await evaluate(`window.defaultBookFixture.fail = false;
        window.defaultBookFixture.book = { id: 'book-retry', title: '恢复后的词表', totalWords: 12 };
        ${bookMetric}.querySelector('.metric-detail-error button').click();`);
      await until(`${bookMetric}.querySelector(".metric-front b")?.textContent === "12"`);
      assert.equal(
        await evaluate('window.defaultBookFixture.requests.length'),
        failedDefaultBookRequestCount + 1,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await evaluate(`${bookMetric}.querySelector(".metric-front small")?.textContent`),
        '恢复后的词表',
      );
      assert.equal(
        await evaluate('document.querySelector(".sidebar-book > div > span")?.textContent'),
        '恢复后的词表',
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?streak-loading=1&streak-empty=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("正在读取真实学习记录")');
      assert.equal(await evaluate('document.querySelector(".streak-count b").textContent'), '—');
      await until('document.querySelector(".streak-count b")?.textContent === "0"');
      assert.equal(
        await evaluate('document.body.textContent.includes("今天还没有已完成的学习活动")'),
        true,
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?today-active=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("今天已有学习记录")');
      assert.equal(await evaluate('document.querySelector(".streak-count b").textContent'), '4');

      await send('Page.navigate', {
        url: new URL('/dashboard?streak-error=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("学习记录暂时无法加载")');
      assert.equal(await evaluate('document.querySelector(".streak-count b").textContent'), '—');
      assert.equal(await evaluate('document.body.textContent.includes("打卡成功")'), false);

      await send('Page.navigate', {
        url: new URL('/dashboard?progress-race=1', baseUrl).href,
      });
      await until(
        'location.search.includes("progress-race") && document.readyState === "complete"',
      );
      await send('Page.reload');
      await until('window.progressFixture?.holdInitialRequests');
      await untilProgressRequestsSettle('fixture');
      const progressCard = 'document.querySelectorAll(".progress-grid .metric-card")[1]';
      await until(`${progressCard}.querySelector(".metric-front b")?.textContent === "—"`);
      assert.equal(
        await evaluate(
          `${progressCard}.querySelector(".metric-front small")?.textContent.includes("正在读取学习统计")`,
        ),
        true,
      );
      const latestProgressIndex = await evaluate('window.progressFixture.requests.at(-1).index');
      await evaluate(
        `window.progressFixture.resolve(${latestProgressIndex}, Response.json({ totalWords: 10, masteredWords: 5, progress: 50 }))`,
      );
      await until(`${progressCard}.querySelector(".metric-front b")?.textContent === "5"`);
      await evaluate(`for (const pending of [...window.progressFixture.resolvers]) {
        window.progressFixture.resolve(pending.index, Response.json({ totalWords: 10, masteredWords: 9, progress: 90 }));
      }`);
      await delay(100);
      assert.equal(
        await evaluate(`${progressCard}.querySelector(".metric-front b")?.textContent`),
        '5',
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?progress-error=1', baseUrl).href,
      });
      await until(
        'location.search.includes("progress-error") && document.readyState === "complete"',
      );
      await send('Page.reload');
      await until('window.progressFixture?.failAll');
      await until(`${progressCard}.querySelector(".metric-detail-error button")`);
      assert.equal(
        await evaluate(`${progressCard}.querySelector(".metric-front b")?.textContent`),
        '—',
      );
      assert.equal(
        await evaluate(
          `${progressCard}.querySelector(".metric-front small")?.textContent.includes("0.0%")`,
        ),
        false,
      );
      assert.equal(
        await evaluate(
          `${progressCard}.querySelector(".metric-detail-error [role=alert]")?.textContent`,
        ),
        '统计暂时无法加载',
      );
      await evaluate(
        'document.querySelector(".metric-detail-error button").focus({ focusVisible: true })',
      );
      assert.equal(
        await evaluate(
          'getComputedStyle(document.querySelector(".metric-detail-error button")).outlineWidth',
        ),
        '3px',
      );
      const retryPoint = await evaluate(`(() => {
        const { x, y, width, height } = document.querySelector('.metric-detail-error button').getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: retryPoint.x,
        y: retryPoint.y,
      });
      await delay(450);
      assert.equal(
        await evaluate(`getComputedStyle(${progressCard}.querySelector('.metric-front')).opacity`),
        '1',
      );
      await evaluate('window.progressFixture.failAll = false');
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        x: retryPoint.x,
        y: retryPoint.y,
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        x: retryPoint.x,
        y: retryPoint.y,
        clickCount: 1,
      });
      await until(`${progressCard}.querySelector(".metric-front b")?.textContent === "3"`);
      assert.equal(
        await evaluate(`${progressCard}.querySelector(".metric-front small")?.textContent`),
        '学习进度 30.0%',
      );

      await evaluate(`const session = JSON.parse(localStorage.getItem('lexloop.session'));
        session.user.id = 'user-b';
        localStorage.setItem('lexloop.session', JSON.stringify(session));`);
      await send('Page.navigate', {
        url: new URL('/dashboard?progress-user-b-loading=1', baseUrl).href,
      });
      await until(
        'location.search.includes("progress-user-b-loading") && document.readyState === "complete"',
      );
      await send('Page.reload');
      await until('window.progressFixture?.holdUserB');
      await untilProgressRequestsSettle('user-b');
      await until(
        `${bookMetric}.querySelector(".metric-front small")?.textContent === "请选择一个系统词表"`,
      );
      assert.equal(
        await evaluate('document.querySelector(".sidebar-book > div > span")?.textContent'),
        '请选择词表',
      );
      assert.equal(
        await evaluate(`${progressCard}.querySelector(".metric-front b")?.textContent`),
        '—',
      );
      const latestUserProgressIndex = await evaluate(
        'window.progressFixture.requests.at(-1).index',
      );
      await evaluate(
        `window.progressFixture.resolve(${latestUserProgressIndex}, Response.json({ totalWords: 10, masteredWords: 7, progress: 70 }))`,
      );
      await until(`${progressCard}.querySelector(".metric-front b")?.textContent === "7"`);
      await evaluate(`for (const pending of [...window.progressFixture.resolvers]) {
        window.progressFixture.resolve(pending.index, Response.json({ totalWords: 10, masteredWords: 9, progress: 90 }));
      }`);
      await delay(100);
      assert.equal(
        await evaluate(`${progressCard}.querySelector(".metric-front b")?.textContent`),
        '7',
      );
      assert.equal(
        await evaluate(`${progressCard}.querySelector(".metric-front small")?.textContent`),
        '学习进度 70.0%',
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
