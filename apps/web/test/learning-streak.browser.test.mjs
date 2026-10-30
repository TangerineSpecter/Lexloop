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
  'dashboard summaries and the vocabulary picker recover accurately from loading, failure and retries',
  { skip: !baseUrl, timeout: 60_000 },
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
    const runtimeErrors = [];
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
        if (result.method === 'Runtime.exceptionThrown') {
          runtimeErrors.push(
            result.params.exceptionDetails?.exception?.description ??
              result.params.exceptionDetails?.text ??
              'Runtime exception',
          );
        }
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
        const pageState = await evaluate(`({ href: location.href, title: document.title,
          body: document.body?.innerText?.slice(0, 600), readyState: document.readyState,
          session: localStorage.getItem('lexloop.session'), fixture: typeof window.bookPickerFixture,
          streak: window.streakFixture,
          search: document.querySelector('#book-catalog-search')?.value,
          summary: document.querySelector('.book-search-summary')?.textContent,
          choices: document.querySelectorAll('.book-choice').length })`).catch(() => null);
        assert.fail(
          `Timed out waiting for ${expression}; page=${JSON.stringify(pageState)}; runtimeErrors=${JSON.stringify(runtimeErrors)}`,
        );
      };
      const pressKey = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code,
          windowsVirtualKeyCode,
          ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
          ...(modifiers ? { modifiers } : {}),
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode,
          ...(modifiers ? { modifiers } : {}),
        });
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
      await send('Runtime.enable');
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
      window.bookPickerFixture = {
        hold: new URL(location.href).searchParams.has('book-picker-loading'),
        holdNextSystem: 0,
        failNextSystem: 0,
        failLearning: false,
        bookTitle: '2026 年新课标初中英语日常交流与主题阅读综合词汇训练词表',
        learningBooks: [],
        categories: [{ key: 'general', label: '通用', count: 1 }],
        catalogBooks: [{ id: 'starter-book', category: 'general', categoryLabel: '初中英语与日常交流综合学习', title: '2026 年新课标初中英语日常交流与主题阅读综合词汇训练词表', publisher: null, grade: null, totalWords: 300, learnedWords: 0, isLearning: false, isDefault: false }],
        systemQueries: [],
        resolvers: [],
        releaseAll() {
          this.hold = false;
          this.holdNextSystem = 0;
          for (const item of this.resolvers.splice(0)) item.resolve(Response.json(item.body));
        },
      };
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
          const category = new URL(path, location.href).searchParams.get('category');
          window.bookPickerFixture.systemQueries.push(category);
          const body = {
            categories: window.bookPickerFixture.categories,
            books: window.bookPickerFixture.catalogBooks.filter((book) => !category || book.category === category),
          };
          if (window.bookPickerFixture.failNextSystem > 0) {
            window.bookPickerFixture.failNextSystem -= 1;
            return Response.json({ message: '系统词表暂时不可用' }, { status: 503 });
          }
          if (window.bookPickerFixture.hold || window.bookPickerFixture.holdNextSystem > 0) {
            if (!window.bookPickerFixture.hold) window.bookPickerFixture.holdNextSystem -= 1;
            return new Promise((resolve) => window.bookPickerFixture.resolvers.push({ resolve, body }));
          }
          return Response.json(body);
        }
        if (path.endsWith('/api/v1/vocabulary/learning')) {
          window.bookPickerRequests.push('learning');
          if (window.bookPickerFixture.hold) {
            return new Promise((resolve) => window.bookPickerFixture.resolvers.push({ resolve, body: [] }));
          }
          if (window.bookPickerFixture.failLearning) return Response.json({ message: '学习词表暂时不可用' }, { status: 503 });
          return Response.json(window.bookPickerFixture.learningBooks);
        }
        const startPrefix = '/api/v1/vocabulary/books/';
        const startBookId = path.includes(startPrefix) && path.endsWith('/start')
          ? path.slice(path.lastIndexOf(startPrefix) + startPrefix.length, -'/start'.length)
          : null;
        if (startBookId && options.method === 'POST') {
          const selected = window.bookPickerFixture.catalogBooks.find((book) => book.id === startBookId);
          if (!selected) return Response.json({ message: '词表不存在' }, { status: 404 });
          window.defaultBookFixture.book = { id: selected.id, title: selected.title, totalWords: selected.totalWords };
          window.bookPickerFixture.learningBooks = [{ ...selected, learnedWords: 0, isLearning: true, isDefault: true }];
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

      await send('Page.navigate', {
        url: new URL('/dashboard?new-user=1&book-picker-loading=1', baseUrl).href,
      });
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
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await evaluate('document.querySelector(".book-selection-prompt button").focus()');
      const bookPickerScrollBeforeOpen = await evaluate('window.scrollY');
      await pressKey('Enter', 'Enter', 13);
      await until('document.querySelector(".book-drawer")');
      assert.equal(
        await evaluate('document.querySelector(".book-drawer").getAttribute("aria-labelledby")'),
        'book-picker-title',
      );
      await until('window.bookPickerFixture.resolvers.length === 2');
      assert.deepEqual(
        await evaluate(`({
          focusedHeading: document.activeElement === document.querySelector('#book-picker-title'),
          loading: document.querySelector('.book-drawer [role=status]')?.textContent.trim(),
          hasEmpty: Boolean(document.querySelector('.book-drawer .book-empty:not(.book-load-state)')),
          learningCount: [...document.querySelectorAll('.book-tabs button')][0]?.textContent.trim(),
          systemCount: [...document.querySelectorAll('.book-tabs button')][2]?.textContent.replace(/\\s+/g, ' ').trim(),
          animation: getComputedStyle(document.querySelector('.book-drawer')).animationName,
          runningAnimations: document.querySelector('.book-drawer').getAnimations().filter(item => item.playState !== 'finished').length,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          closeTransition: getComputedStyle(document.querySelector('.book-drawer header > button')).transitionDuration,
        })`),
        {
          focusedHeading: true,
          loading: '正在加载词表…',
          hasEmpty: false,
          learningCount: '学习中（…）',
          systemCount: '系统词表（…）',
          animation: 'none',
          runningAnimations: 0,
          reducedMotion: true,
          closeTransition: '0s',
        },
      );
      assert.equal(await evaluate('window.scrollY'), bookPickerScrollBeforeOpen);
      await pressKey('Tab', 'Tab', 9, 8);
      assert.equal(
        await evaluate('document.activeElement.textContent.includes("系统词表")'),
        true,
        'Shift+Tab from the dialog heading wraps to the last available control',
      );
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        '关闭',
        'Tab from the final tab stays inside the dialog',
      );
      await pressKey('Tab', 'Tab', 9);
      assert.equal(await evaluate('document.activeElement.textContent.includes("学习中")'), true);
      await evaluate('window.bookPickerFixture.releaseAll()');
      await until(
        'document.querySelector(".book-empty")?.textContent.includes("还没有可展示的词表")',
      );
      assert.equal(
        await evaluate('document.querySelector(".book-drawer [role=status]") === null'),
        true,
      );
      await pressKey('Tab', 'Tab', 9);
      await pressKey('Tab', 'Tab', 9);
      await pressKey('Enter', 'Enter', 13);
      await until('document.querySelector(".book-choice")');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const bookChoiceDesktopLayout = await evaluate(`(() => {
        const drawer = document.querySelector('.book-drawer').getBoundingClientRect();
        const card = document.querySelector('.book-choice').getBoundingClientRect();
        const action = document.querySelector('.book-choice button').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          drawerLeft: drawer.left, drawerRight: drawer.right,
          cardLeft: card.left, cardRight: card.right, actionRight: action.right };
      })()`);
      assert.ok(
        bookChoiceDesktopLayout.viewport === 1440 &&
          bookChoiceDesktopLayout.page <= 1440 &&
          bookChoiceDesktopLayout.drawerLeft >= 0 &&
          bookChoiceDesktopLayout.drawerRight <= 1440 &&
          bookChoiceDesktopLayout.cardLeft >= 0 &&
          bookChoiceDesktopLayout.cardRight <= 1440 &&
          bookChoiceDesktopLayout.actionRight <= bookChoiceDesktopLayout.cardRight,
        JSON.stringify(bookChoiceDesktopLayout),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('innerWidth === 390');
      assert.equal(await evaluate('document.activeElement.textContent.includes("系统词表")'), true);
      await pressKey('Enter', 'Enter', 13);
      await until(
        'document.querySelector(".book-choice")?.textContent.includes(window.bookPickerFixture.bookTitle)',
      );
      const bookChoiceLayout = await evaluate(`(() => {
        const drawer = document.querySelector('.book-drawer').getBoundingClientRect();
        const card = document.querySelector('.book-choice').getBoundingClientRect();
        const title = document.querySelector('.book-choice strong');
        const action = document.querySelector('.book-choice button');
        const chips = [...document.querySelectorAll('.book-choice-tags span')];
        return {
          viewport: innerWidth,
          page: document.documentElement.scrollWidth,
          drawerLeft: drawer.left,
          drawerRight: drawer.right,
          cardLeft: card.left,
          cardRight: card.right,
          actionRight: action.getBoundingClientRect().right,
          titleIsEllipsized: title.scrollWidth > title.clientWidth,
          titleTooltip: title.title,
          actionName: action.getAttribute('aria-label'),
          chipsFit: chips.every((chip) => chip.getBoundingClientRect().right <= card.right),
        };
      })()`);
      assert.ok(
        bookChoiceLayout.viewport === 390 &&
          bookChoiceLayout.page <= 390 &&
          bookChoiceLayout.drawerLeft >= 0 &&
          bookChoiceLayout.drawerRight <= 390 &&
          bookChoiceLayout.cardLeft >= 0 &&
          bookChoiceLayout.cardRight <= 390 &&
          bookChoiceLayout.actionRight <= bookChoiceLayout.cardRight &&
          bookChoiceLayout.titleIsEllipsized &&
          bookChoiceLayout.titleTooltip ===
            (await evaluate('window.bookPickerFixture.bookTitle')) &&
          bookChoiceLayout.actionName ===
            `开始学习：${await evaluate('window.bookPickerFixture.bookTitle')}` &&
          bookChoiceLayout.chipsFit,
        JSON.stringify(bookChoiceLayout),
      );
      assert.equal(await evaluate('document.activeElement.textContent.includes("系统词表")'), true);
      await pressKey('Tab', 'Tab', 9);
      assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'tab');
      assert.equal(await evaluate('document.activeElement.textContent.includes("通用")'), true);
      await pressKey('Tab', 'Tab', 9);
      assert.equal(await evaluate('document.activeElement.id'), 'book-catalog-search');
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        `开始学习：${await evaluate('window.bookPickerFixture.bookTitle')}`,
      );
      await pressKey('Tab', 'Tab', 9, 8);
      assert.equal(await evaluate('document.activeElement.id'), 'book-catalog-search');
      await pressKey('Tab', 'Tab', 9, 8);
      assert.equal(await evaluate('document.activeElement.textContent.includes("通用")'), true);
      await pressKey('Tab', 'Tab', 9);
      await pressKey('Tab', 'Tab', 9);
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        '关闭',
        'Tab from the final card action wraps back to the first dialog control',
      );
      await pressKey('Tab', 'Tab', 9, 8);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        `开始学习：${await evaluate('window.bookPickerFixture.bookTitle')}`,
      );
      await pressKey('Enter', 'Enter', 13);
      await until('window.defaultBookFixture.book?.id === "starter-book"');
      await until('document.querySelector(".book-choice button.current")');
      await until('document.querySelector(".book-selection-prompt") === null');
      await pressKey('Escape', 'Escape', 27);
      await until('document.querySelector(".book-drawer") === null');
      await until('document.querySelector(".word-row strong")?.textContent === "begin"');
      const focusAfterBookSelection = await evaluate(`(() => ({
        tag: document.activeElement?.tagName,
        className: document.activeElement?.className,
        text: document.activeElement?.textContent?.trim(),
        selectedTab: document.querySelector('.learning-tabs [role=tab][aria-selected=true]')?.textContent.trim(),
        promptExists: Boolean(document.querySelector('.book-selection-prompt')),
      }))()`);
      assert.ok(
        await evaluate(
          'document.activeElement.matches(".learning-tabs [role=tab][aria-selected=true]")',
        ),
        `when the new-user trigger disappears, focus returns to the selected learning tab: ${JSON.stringify(focusAfterBookSelection)}`,
      );
      assert.equal(await evaluate('window.scrollY'), bookPickerScrollBeforeOpen);
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
      await evaluate(`window.bookPickerFixture.failLearning = true;
        document.querySelector('.switch-book').focus();`);
      await pressKey('Enter', 'Enter', 13);
      await until('document.querySelector(".book-drawer [role=alert]")');
      assert.deepEqual(
        await evaluate(`({
          error: document.querySelector('.book-drawer [role=alert]').textContent.includes('学习词表暂时不可用'),
          empty: Boolean(document.querySelector('.book-drawer .book-empty:not([role=alert])')),
          retry: document.querySelector('.book-drawer [role=alert] button')?.textContent.trim(),
        })`),
        { error: true, empty: false, retry: '重试' },
      );
      await evaluate(`window.bookPickerFixture.failLearning = false;
        document.querySelector('.book-drawer [role=alert] button').click();`);
      await until(
        'document.querySelector(".book-choice")?.textContent.includes(window.bookPickerFixture.bookTitle)',
      );
      assert.equal(
        await evaluate('document.querySelector(".book-drawer [role=alert]") === null'),
        true,
      );
      await pressKey('Escape', 'Escape', 27);
      await until('document.querySelector(".book-drawer") === null');
      assert.equal(
        await evaluate('document.activeElement.matches(".switch-book")'),
        true,
        'the switch-book trigger receives focus after closing',
      );
      await send('Emulation.setEmulatedMedia', { features: [] });
      assert.deepEqual(await evaluate('window.bookPickerRequests'), [
        'system',
        'learning',
        'system',
        'system',
        'learning',
        'system',
        'learning',
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

      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.navigate', { url: new URL('/dashboard?new-user=1', baseUrl).href });
      await until('document.querySelector(".book-selection-prompt button")');
      await evaluate(`window.bookPickerFixture.categories = [
        { key: 'general', label: '通用', count: 300 },
        { key: 'exam', label: '应试词汇', count: 300 },
      ];
      window.bookPickerFixture.catalogBooks = Array.from({ length: 600 }, (_, index) => {
        const isTarget = index === 599;
        const category = index < 300 ? 'general' : 'exam';
        return {
          id: isTarget ? 'search-target' : 'fixture-book-' + index,
          category,
          categoryLabel: category === 'general' ? '通用交流' : '应试词汇',
          title: isTarget ? 'CET-4 高频词汇训练' : '词汇练习 ' + (index + 1),
          publisher: isTarget ? 'Lexloop Press' : '示例教材 ' + (index % 12 + 1),
          grade: isTarget ? '大学英语四级' : '初中 ' + (index % 3 + 1) + ' 年级',
          totalWords: 120,
          learnedWords: 0,
          isLearning: false,
          isDefault: false,
        };
      });`);
      await evaluate('document.querySelector(".book-selection-prompt button").focus()');
      await pressKey('Enter', 'Enter', 13);
      await until('document.querySelector(".book-drawer")');
      await evaluate(
        '[...document.querySelectorAll(".book-tabs button")].find(button => button.textContent.includes("系统词表")).click()',
      );
      await until('document.querySelector("#book-catalog-search")');
      await until(
        'document.querySelectorAll(".book-category-tabs [role=tab]").length === 2 && document.querySelectorAll(".book-choice").length === 600',
      );
      assert.equal(await evaluate('document.querySelector("#book-catalog-search").value'), '');
      const searchLayoutDesktop = await evaluate(`(() => {
        const drawer = document.querySelector('.book-drawer').getBoundingClientRect();
        const input = document.querySelector('#book-catalog-search').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          drawerLeft: drawer.left, drawerRight: drawer.right, inputLeft: input.left, inputRight: input.right };
      })()`);
      assert.ok(
        searchLayoutDesktop.viewport === 1440 &&
          searchLayoutDesktop.page <= 1440 &&
          searchLayoutDesktop.drawerLeft >= 0 &&
          searchLayoutDesktop.drawerRight <= 1440 &&
          searchLayoutDesktop.inputLeft >= 0 &&
          searchLayoutDesktop.inputRight <= 1440,
        JSON.stringify(searchLayoutDesktop),
      );

      const setCatalogQuery = async (query) => {
        await evaluate(`(() => {
          const input = document.querySelector('#book-catalog-search');
          if (input.value) {
            const clear = document.querySelector('[aria-label="清除词表搜索"]');
            if (!clear) throw new Error('A non-empty search has no clear control');
            clear.click();
          }
          input.focus();
          return input.value;
        })()`);
        await send('Input.insertText', { text: query });
        await until(
          `document.querySelector("#book-catalog-search")?.value === ${JSON.stringify(query)}`,
        );
      };
      const requestsBeforeSearch = await evaluate('window.bookPickerRequests.length');
      const searchStartedAt = await evaluate('performance.now()');
      await setCatalogQuery('  ＣＥＴ－４   高频词汇  ');
      await until(
        'document.querySelectorAll(".book-choice").length === 1 && document.querySelector(".book-choice strong")?.textContent === "CET-4 高频词汇训练"',
      );
      await evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      const localSearchElapsedMs = await evaluate(`performance.now() - ${searchStartedAt}`);
      assert.ok(
        localSearchElapsedMs < 1000,
        `600-book local search took ${localSearchElapsedMs.toFixed(1)}ms`,
      );
      assert.equal(
        await evaluate('window.bookPickerRequests.length'),
        requestsBeforeSearch,
        'typing a search only filters the already loaded catalog',
      );
      console.log(
        `600-book local filter: ${localSearchElapsedMs.toFixed(1)} ms to filtered paint in this browser run`,
      );
      assert.equal(
        await evaluate('document.querySelector(".book-choice button").getAttribute("aria-label")'),
        '开始学习：CET-4 高频词汇训练',
      );

      for (const { query, expectedCount } of [
        { query: 'lexloop press', expectedCount: 1 },
        { query: '大学英语四级', expectedCount: 1 },
        { query: '应试词汇', expectedCount: 300 },
      ]) {
        await setCatalogQuery(query);
        await until(`document.querySelectorAll(".book-choice").length === ${expectedCount}`);
        assert.equal(
          await evaluate(
            '[...document.querySelectorAll(".book-choice")].some(card => card.querySelector("strong")?.textContent === "CET-4 高频词汇训练")',
          ),
          true,
          `search should include publisher, grade and category fields (${query})`,
        );
      }
      await setCatalogQuery('不存在的词表 xyz');
      await until('document.querySelector(".book-search-empty")');
      assert.equal(await evaluate('document.querySelectorAll(".book-choice").length'), 0);
      assert.equal(
        await evaluate('document.querySelector(".book-search-empty [role=alert]")'),
        null,
      );
      assert.equal(await evaluate('window.bookPickerRequests.length'), requestsBeforeSearch);
      await evaluate('document.querySelector(".book-search-empty button").click()');
      await until('document.querySelectorAll(".book-choice").length === 600');

      await setCatalogQuery('CET-4');
      await until('document.querySelectorAll(".book-choice").length === 1');
      await evaluate(`window.bookPickerFixture.failNextSystem = 1;
        [...document.querySelectorAll('.book-category-tabs [role=tab]')].find(button => button.textContent.includes('通用')).click();`);
      await until('document.querySelector(".book-drawer [role=alert]")');
      assert.equal(
        await evaluate('document.querySelector(".book-search-empty")'),
        null,
        'a catalog error must not be presented as an authoritative no-match result',
      );
      assert.equal(await evaluate('document.querySelector("#book-catalog-search").value'), 'CET-4');
      await evaluate('document.querySelector(".book-drawer [role=alert] button").click()');
      await until('document.querySelector(".book-search-empty")');
      assert.equal(await evaluate('window.bookPickerFixture.systemQueries.at(-1)'), 'general');
      assert.equal(await evaluate('document.querySelector("#book-catalog-search").value'), 'CET-4');
      assert.equal(
        await evaluate(
          'document.querySelector("#book-catalog-search-scope").textContent.includes("当前分类「通用」")',
        ),
        true,
      );
      await evaluate(
        'document.querySelector(".book-search-control button[aria-label=清除词表搜索]").click()',
      );
      await until('document.querySelectorAll(".book-choice").length === 300');
      assert.equal(
        await evaluate(
          'document.querySelector(".book-search-summary").textContent.includes("分类「通用」")',
        ),
        true,
      );

      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('innerWidth === 390');
      await setCatalogQuery('CET-4');
      await until('document.querySelector(".book-search-empty")');
      const searchLayoutMobile = await evaluate(`(() => {
        const drawer = document.querySelector('.book-drawer').getBoundingClientRect();
        const search = document.querySelector('.book-search').getBoundingClientRect();
        const input = document.querySelector('#book-catalog-search').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          drawerLeft: drawer.left, drawerRight: drawer.right, searchLeft: search.left,
          searchRight: search.right, inputLeft: input.left, inputRight: input.right,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          animation: getComputedStyle(document.querySelector('.book-drawer')).animationName };
      })()`);
      assert.ok(
        searchLayoutMobile.viewport === 390 &&
          searchLayoutMobile.page <= 390 &&
          searchLayoutMobile.drawerLeft >= 0 &&
          searchLayoutMobile.drawerRight <= 390 &&
          searchLayoutMobile.searchLeft >= 0 &&
          searchLayoutMobile.searchRight <= 390 &&
          searchLayoutMobile.inputLeft >= 0 &&
          searchLayoutMobile.inputRight <= 390 &&
          searchLayoutMobile.reducedMotion &&
          searchLayoutMobile.animation === 'none',
        JSON.stringify(searchLayoutMobile),
      );
      await capture('vocabulary-search-mobile.png');
      await evaluate(
        'document.querySelector(".book-search-control button[aria-label=清除词表搜索]").click()',
      );
      await until('document.querySelectorAll(".book-choice").length === 300');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const requestsBeforeAllCategories = await evaluate('window.bookPickerRequests.length');
      await evaluate(
        'document.querySelector(".book-category-tabs [role=tab][aria-selected=true]").click()',
      );
      await until('document.querySelectorAll(".book-choice").length === 600');
      assert.equal(
        await evaluate('window.bookPickerRequests.length'),
        requestsBeforeAllCategories + 1,
      );
      assert.equal(await evaluate('document.querySelector("#book-catalog-search").value'), '');
      await evaluate('document.querySelector("#book-catalog-search").focus()');
      await setCatalogQuery('CET-4');
      await until('document.querySelectorAll(".book-choice").length === 1');
      await capture('vocabulary-search-desktop.png');
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        '清除词表搜索',
      );
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        '开始学习：CET-4 高频词汇训练',
      );
      const requestsBeforeActivation = await evaluate('window.bookPickerRequests.length');
      await pressKey('Enter', 'Enter', 13);
      await until('window.defaultBookFixture.book?.id === "search-target"');
      await until('document.querySelector(".book-choice button.current")');
      assert.equal(
        await evaluate('window.bookPickerRequests.length'),
        requestsBeforeActivation + 1,
        'only the existing explicit activation flow refreshes the system catalog',
      );
      await pressKey('Escape', 'Escape', 27);
      await until('document.querySelector(".book-drawer") === null');
      const focusAfterSearchActivation = await evaluate(`(() => ({
        tag: document.activeElement?.tagName,
        className: document.activeElement?.className,
        label: document.activeElement?.getAttribute('aria-label'),
        text: document.activeElement?.textContent?.trim(),
        visible: Boolean(document.activeElement?.getClientRects().length),
        selectedTab: document.querySelector('.learning-tabs [role=tab][aria-selected=true]')?.textContent.trim(),
        promptExists: Boolean(document.querySelector('.book-selection-prompt button')),
        selectedTabFocused: document.activeElement.matches('.learning-tabs [role=tab][aria-selected=true]'),
      }))()`);
      assert.ok(
        focusAfterSearchActivation.visible && focusAfterSearchActivation.selectedTabFocused,
        `after activation removes the original opener, closing returns focus to the selected learning tab: ${JSON.stringify(focusAfterSearchActivation)}`,
      );
      await evaluate('document.querySelector(".switch-book").click()');
      await until('document.querySelector(".book-drawer")');
      await evaluate(
        '[...document.querySelectorAll(".book-tabs button")].find(button => button.textContent.includes("系统词表")).click()',
      );
      await until('document.querySelector("#book-catalog-search")');
      await until(
        'document.querySelectorAll(".book-category-tabs [role=tab]").length === 2 && document.querySelectorAll(".book-choice").length === 600',
      );
      assert.equal(
        await evaluate('document.querySelector("#book-catalog-search").value'),
        '',
        'closing and reopening resets local search state',
      );

      await evaluate(`window.bookPickerFixture.holdNextSystem = 1;
        [...document.querySelectorAll('.book-category-tabs [role=tab]')].find(button => button.textContent.includes('通用')).click();`);
      await until('window.bookPickerFixture.resolvers.length === 1');
      await pressKey('Escape', 'Escape', 27);
      await until('document.querySelector(".book-drawer") === null');
      await evaluate('document.querySelector(".switch-book").click()');
      await until('document.querySelector(".book-drawer")');
      await evaluate(
        '[...document.querySelectorAll(".book-tabs button")].find(button => button.textContent.includes("系统词表")).click()',
      );
      await until('document.querySelector("#book-catalog-search")');
      await until(
        'document.querySelectorAll(".book-category-tabs [role=tab]").length === 2 && document.querySelectorAll(".book-choice").length === 600',
      );
      await evaluate('window.bookPickerFixture.releaseAll()');
      await delay(100);
      assert.equal(
        await evaluate('document.querySelectorAll(".book-choice").length'),
        600,
        'a category response that finishes after close cannot replace the reopened catalog',
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".book-category-tabs [role=tab][aria-selected=true]").length',
        ),
        0,
      );
      assert.equal(await evaluate('document.querySelector("#book-catalog-search").value'), '');
      await pressKey('Escape', 'Escape', 27);
      await until('document.querySelector(".book-drawer") === null');
      await send('Emulation.setEmulatedMedia', { features: [] });
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
