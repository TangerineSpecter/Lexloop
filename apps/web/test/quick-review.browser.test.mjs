import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'optional due-word practice resumes locally without changing formal review progress',
  { skip: !baseUrl, timeout: 90_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-quick-review-'));
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
    const browserErrors = [];
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
      const initialTargets = await (await fetch(`${debugUrl}/json`)).json();
      const initialTarget = initialTargets.find((target) => target.type === 'page');
      assert.ok(initialTarget, 'Chromium did not expose an initial page target');

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
          if (!message.id) {
            if (message.method === 'Runtime.exceptionThrown') {
              browserErrors.push(
                message.params.exceptionDetails.exception?.description ??
                  message.params.exceptionDetails.text,
              );
            }
            return;
          }
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

      const firstTab = await connect(initialTarget.webSocketDebuggerUrl);
      await firstTab.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await firstTab.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          const sessions = {
            'quick-user-a': { accessToken: 'quick-fixture-a', user: { id: 'quick-user-a', email: 'a@example.invalid', displayName: '练习者 A', role: 'USER' } },
            'quick-user-b': { accessToken: 'quick-fixture-b', user: { id: 'quick-user-b', email: 'b@example.invalid', displayName: '练习者 B', role: 'USER' } },
          };
          if (!localStorage.getItem('lexloop.session')) {
            localStorage.setItem('lexloop.session', JSON.stringify(sessions['quick-user-a']));
          }
          window.quickReviewFixture = { calls: [], planWrites: [], dashboardWordsCalls: 0 };
          const makeDueWords = (userId, changed = false) => {
            const ids = Array.from({ length: userId === 'quick-user-a' ? 12 : 4 }, (_, index) => index + 1);
            if (changed && userId === 'quick-user-a') ids.reverse();
            const missingMode = localStorage.getItem('fixture.quick-review-missing');
            return ids.map((number) => {
              const id = userId === 'quick-user-a' ? 'a-due-' + String(number).padStart(2, '0') : 'b-due-' + String(number).padStart(2, '0');
              const word = number === 1 && userId === 'quick-user-a' ? 'uncharacteristicallylongwordfornarrowlayout' : 'steady' + number;
              const missing = missingMode === 'all' || (missingMode === 'mixed' && [1, 3].includes(number));
              const meaning = missing ? '暂无释义' : ('稳定、持续的；释义示例 ' + number + '。').repeat(number === 1 ? 4 : 1);
              return { id, word, part: 'adj.', meaning, meanings: missing ? [] : [{ part: 'adj.', text: meaning }], ukPhonetic: '/ˈstedi/' };
            });
          };
          const nativeFetch = window.fetch;
          window.fetch = async (input, options = {}) => {
            const path = new URL(String(input), location.href).pathname;
            const method = options.method ?? 'GET';
            if (!path.startsWith('/api/v1/')) return nativeFetch(input, options);
            const session = JSON.parse(localStorage.getItem('lexloop.session') || 'null');
            const userId = session?.user?.id ?? 'missing-user';
            window.quickReviewFixture.calls.push({ method, path, userId });
            if (path.endsWith('/auth/me')) return Response.json({ id: userId });
            if (path.endsWith('/auth/refresh')) return Response.json({ message: 'Fixture session is current' }, { status: 401 });
            if (path.endsWith('/vocabulary/default')) {
              const selectedBook = localStorage.getItem(userId === 'quick-user-a' ? 'fixture.default-book-a' : 'fixture.default-book-b') ?? (userId === 'quick-user-a' ? 'book-a' : 'book-b');
              return Response.json({ id: selectedBook, title: selectedBook === 'book-a' ? '第一词表' : '第二词表', totalWords: 30 });
            }
            if (path.endsWith('/vocabulary/learning')) {
              const selectedBook = localStorage.getItem(userId === 'quick-user-a' ? 'fixture.default-book-a' : 'fixture.default-book-b') ?? (userId === 'quick-user-a' ? 'book-a' : 'book-b');
              return Response.json(['book-a', 'book-b'].map((id) => ({ id, title: id === 'book-a' ? '第一词表' : '第二词表', publisher: '测试出版社', categoryLabel: '测试分类', grade: 'A2', totalWords: 30, learnedWords: 8, isDefault: id === selectedBook })));
            }
            if (path.endsWith('/vocabulary/system')) return Response.json({ categories: [], books: [] });
            const bookAction = path.split('/vocabulary/books/')[1]?.split('/');
            if (
              bookAction?.length === 2 &&
              ['continue', 'start'].includes(bookAction[1]) &&
              method === 'POST'
            ) {
              const bookId = bookAction[0];
              if (userId === 'quick-user-a') localStorage.setItem('fixture.default-book-a', bookId);
              else localStorage.setItem('fixture.default-book-b', bookId);
              return Response.json({ id: bookId, title: bookId === 'book-a' ? '第一词表' : '第二词表', totalWords: 30 });
            }
            if (path.endsWith('/vocabulary/progress-summary')) return Response.json({ totalWords: 30, masteredWords: 4, progress: 13.3 });
            if (path.endsWith('/vocabulary/dashboard-words')) {
              window.quickReviewFixture.dashboardWordsCalls += 1;
              const changed = localStorage.getItem('fixture.quick-review-order-a') === 'changed';
              return Response.json({ defaultNewWordCount: 0, reviewWords: makeDueWords(userId, changed), newWords: [] });
            }
            if (path.endsWith('/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.endsWith('/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.endsWith('/study/plans') && method === 'GET') return Response.json([]);
            if (path.endsWith('/study/plans') && method !== 'GET') window.quickReviewFixture.planWrites.push({ method, path });
            return Response.json({ message: 'unexpected fixture API request: ' + method + ' ' + path }, { status: 404 });
          };
        `,
      });

      const until = async (page, expression, label = expression) => {
        for (let attempt = 0; attempt < 140; attempt += 1) {
          try {
            if (await page.evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A reload can briefly replace a page's JavaScript context.
          }
          await delay(100);
        }
        const state = await page
          .evaluate(`({ path: location.pathname, text: document.body.innerText.slice(-700) })`)
          .catch(() => null);
        assert.fail(`Timed out waiting for ${label}; state=${JSON.stringify(state)}`);
      };
      const key = async (page, value, code, keyCode) => {
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: value,
          code,
          windowsVirtualKeyCode: keyCode,
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: value,
          code,
          windowsVirtualKeyCode: keyCode,
        });
      };
      const openWords = async (page) => {
        await until(page, 'document.querySelector("[role=tab]")', 'dashboard tabs');
        await page.evaluate(`(() => {
          const tab = [...document.querySelectorAll('[role=tab]')].find((item) => item.textContent.includes('单词列表'));
          if (!tab) throw new Error('单词列表标签不存在');
          tab.click();
        })()`);
        await until(
          page,
          'document.querySelector("[data-quick-review-active], [data-quick-review-done], section h2")',
          'word list page',
        );
      };

      await firstTab.send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await openWords(firstTab);
      await until(
        firstTab,
        'document.querySelector(".words-panel") && document.querySelector("#review-session-count")',
        'loaded due words',
      );
      await until(
        firstTab,
        'document.querySelector(".words-panel").innerText.includes("到期 12 · 可回想 12")',
        'due-word practice entry',
      );
      const desktopBounds = await firstTab.evaluate(`(() => {
        const panel = document.querySelector('[data-quick-review]');
        const box = panel?.getBoundingClientRect();
        return { box: box && { left: box.left, right: box.right, width: box.width }, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
      })()`);
      assert.ok(desktopBounds.box, 'quick-practice card is missing on desktop');
      assert.ok(
        desktopBounds.box.left >= 0 && desktopBounds.box.right <= desktopBounds.viewport,
        JSON.stringify(desktopBounds),
      );
      assert.ok(
        desktopBounds.pageWidth <= desktopBounds.clientWidth,
        JSON.stringify(desktopBounds),
      );

      assert.deepEqual(
        await firstTab.evaluate(
          `Array.from(document.querySelectorAll('[data-quick-review] input[type="radio"]')).map((input) => input.value)`,
        ),
        ['1', '3', '5', '10'],
        'the short-practice choices are bounded to at most ten due words',
      );
      await firstTab.evaluate(`(() => {
        const input = document.querySelector('input[type="radio"][value="3"]');
        if (!input) throw new Error('3 题选项不存在');
        input.focus();
      })()`);
      await key(firstTab, 'ArrowRight', 'ArrowRight', 39);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review]")?.innerText.includes("前 5 个")',
        'keyboard count selection',
      );
      await key(firstTab, 'ArrowLeft', 'ArrowLeft', 37);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review]")?.innerText.includes("前 3 个")',
        'restore three-question count',
      );
      await firstTab.evaluate(`(() => {
        const start = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('开始练习（3 题）'));
        if (!start) throw new Error('开始练习按钮不存在');
        start.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active]")',
        'first recall card',
      );
      assert.equal(
        await firstTab.evaluate(
          'document.querySelector("[data-quick-review-active]").innerText.includes("释义示例 1")',
        ),
        false,
        'the first meaning must remain hidden before recall',
      );
      assert.equal(
        await firstTab.evaluate(
          'document.querySelector("[data-quick-review-active] h2").textContent',
        ),
        'uncharacteristicallylongwordfornarrowlayout',
      );

      await firstTab.evaluate(`(() => {
        const pause = [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('暂停'));
        pause.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector(".words-panel").innerText.includes("已回想 0/3 题")',
        'unattempted interruption count',
      );
      await firstTab.evaluate(`(() => {
        const resume = [...document.querySelectorAll('.words-panel button')].find((button) => button.textContent.trim() === '继续练习');
        resume.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active] h2")?.textContent === "uncharacteristicallylongwordfornarrowlayout"',
        'resume before the first recall',
      );

      await firstTab.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileBounds = await firstTab.evaluate(`(() => {
        const panel = document.querySelector('[data-quick-review-active]');
        const box = panel.getBoundingClientRect();
        const word = panel.querySelector('h2').getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, wordRight: word.right, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
      })()`);
      assert.ok(
        mobileBounds.left >= 0 && mobileBounds.right <= mobileBounds.viewport,
        JSON.stringify(mobileBounds),
      );
      assert.ok(mobileBounds.pageWidth <= mobileBounds.clientWidth, JSON.stringify(mobileBounds));
      assert.ok(mobileBounds.wordRight <= mobileBounds.right, JSON.stringify(mobileBounds));

      await firstTab.evaluate(`(() => {
        const reveal = [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('显示释义'));
        reveal.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active]").innerText.includes("释义示例 1")',
        'revealed meaning',
      );
      await firstTab.evaluate(`(() => {
        const next = [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.trim() === '下一题');
        next.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active] h2")?.textContent === "steady2"',
        'second due word in API order',
      );
      await firstTab.evaluate(`(() => {
        const pause = [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('暂停'));
        pause.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector(".words-panel").innerText.includes("已回想 1/3 题")',
        'saved pause state',
      );
      const savedDraft = await firstTab.evaluate(`(() => {
        const key = [...Array(localStorage.length)].map((_, index) => localStorage.key(index)).find((item) => item?.startsWith('lexloop.quick-review.v1.'));
        return key ? { key, value: JSON.parse(localStorage.getItem(key)) } : null;
      })()`);
      assert.deepEqual(savedDraft.value, {
        version: 1,
        userId: 'quick-user-a',
        wordIds: ['a-due-01', 'a-due-02', 'a-due-03'],
        currentIndex: 1,
        revealed: false,
      });
      assert.equal(savedDraft.key, 'lexloop.quick-review.v1.quick-user-a.due');

      await firstTab.evaluate(`document.querySelector('.switch-book')?.click()`);
      await until(
        firstTab,
        'document.querySelector("[role=dialog]")?.innerText.includes("选择词表")',
        'book picker for queue-scope check',
      );
      await until(
        firstTab,
        'document.querySelector("[role=dialog] button[aria-label=\\"切换到词表：第二词表\\"]")',
        'alternate default vocabulary',
      );
      await firstTab.evaluate(
        `document.querySelector('[role="dialog"] button[aria-label="切换到词表：第二词表"]')?.click()`,
      );
      await until(
        firstTab,
        'Array.from(document.querySelectorAll(".book-choice")).some((card) => card.innerText.includes("第二词表") && card.querySelector("button.current"))',
        'alternate vocabulary confirmed as current',
      );
      await firstTab.evaluate(
        `document.querySelector('[role="dialog"] button[aria-label="关闭"]')?.click()`,
      );
      await until(
        firstTab,
        'document.querySelector(".words-panel")?.innerText.includes("有一份尚未看完的练习")',
        'draft restored after selected book changes while the account due queue stays the same',
      );
      assert.equal(
        await firstTab.evaluate(
          `JSON.parse(localStorage.getItem(${JSON.stringify(savedDraft.key)})).wordIds.join(',')`,
        ),
        'a-due-01,a-due-02,a-due-03',
        'a default-book change must not rewrite the user-scoped due-queue draft',
      );

      const popupOpened = await firstTab.evaluate(
        `Boolean(window.open(${JSON.stringify(`${baseUrl}/updates`)}, '_blank'))`,
      );
      assert.equal(popupOpened, true, 'could not open a second same-origin account tab');
      let secondTarget;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const targets = await (await fetch(`${debugUrl}/json`)).json();
        secondTarget = targets.find(
          (target) =>
            target.type === 'page' &&
            target.id !== initialTarget.id &&
            target.url.startsWith(`${baseUrl}/updates`),
        );
        if (secondTarget) break;
        await delay(100);
      }
      assert.ok(secondTarget, 'second same-origin tab did not open');
      const secondTab = await connect(secondTarget.webSocketDebuggerUrl);
      await secondTab.evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'quick-fixture-b',
        user: { id: 'quick-user-b', email: 'b@example.invalid', displayName: '练习者 B', role: 'USER' }
      }))`);
      await until(
        firstTab,
        `document.querySelector('.sidebar-book strong')?.textContent.includes('练习者 B')`,
        'second account after storage change',
      );
      await openWords(firstTab);
      await until(
        firstTab,
        'document.querySelector(".words-panel").innerText.includes("到期 4 · 可回想 4")',
        'second account due words',
      );
      assert.equal(
        await firstTab.evaluate(
          'document.querySelector(".words-panel").innerText.includes("尚未看完的练习")',
        ),
        false,
        'account B must not see account A draft',
      );
      assert.equal(
        await secondTab.evaluate(
          `localStorage.getItem('lexloop.quick-review.v1.quick-user-b.due')`,
        ),
        null,
      );

      await secondTab.evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'quick-fixture-a',
        user: { id: 'quick-user-a', email: 'a@example.invalid', displayName: '练习者 A', role: 'USER' }
      }))`);
      await until(
        firstTab,
        `document.querySelector('.sidebar-book strong')?.textContent.includes('练习者 A')`,
        'return to account A',
      );
      await openWords(firstTab);
      await until(
        firstTab,
        'document.querySelector(".words-panel").innerText.includes("有一份尚未看完的练习")',
        'account A draft restored',
      );
      await firstTab.evaluate(`(() => {
        const resume = [...document.querySelectorAll('.words-panel button')].find((button) => button.textContent.trim() === '继续练习');
        resume.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active] h2")?.textContent === "steady2"',
        'resume at saved card',
      );

      await firstTab.evaluate(`localStorage.setItem('fixture.quick-review-order-a', 'changed')`);
      await firstTab.send('Page.reload');
      await until(
        firstTab,
        `document.querySelector('.sidebar-book strong')?.textContent.includes('练习者 A')`,
        'reloaded account A',
      );
      await openWords(firstTab);
      await until(
        firstTab,
        'document.querySelector(".words-panel").innerText.includes("当前可回想词候选已经变化")',
        'stale draft notice',
      );
      assert.equal(
        await firstTab.evaluate(
          'document.querySelector(".words-panel").innerText.includes("有一份尚未看完的练习")',
        ),
        false,
      );

      const beforeCompletion = await firstTab.evaluate(`({
        dashboardWordsCalls: window.quickReviewFixture.dashboardWordsCalls,
        calls: window.quickReviewFixture.calls,
      })`);

      await firstTab.evaluate(`document.querySelector('input[type="radio"][value="3"]')?.click()`);
      await firstTab.evaluate(`(() => {
        const start = [...document.querySelectorAll('.words-panel button')].find((button) => button.textContent.includes('开始练习（3 题）'));
        start.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active]")',
        'fresh three-word set',
      );
      for (let index = 0; index < 3; index += 1) {
        await firstTab.evaluate(`(() => {
          const reveal = [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('显示释义'));
          if (!reveal) throw new Error('current question must be explicitly recalled before reveal');
          reveal.click();
        })()`);
        await until(
          firstTab,
          'document.querySelector("[data-quick-review-active]").innerText.includes("释义示例")',
          `meaning for card ${index + 1}`,
        );
        const finalCard = index === 2;
        await firstTab.evaluate(`(() => {
          const next = [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.trim() === ${JSON.stringify(finalCard ? '结束本次练习' : '下一题')});
          if (!next) throw new Error('expected next action missing');
          next.click();
        })()`);
        if (!finalCard)
          await until(
            firstTab,
            `document.querySelector('[data-quick-review-active]')?.innerText.includes('第 ${index + 2}/3 题')`,
            `card ${index + 2}`,
          );
      }
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-done]")',
        'session completion',
      );
      assert.match(
        await firstTab.evaluate('document.querySelector("[data-quick-review-done]").innerText'),
        /本次少量练习已看完/,
      );
      assert.match(
        await firstTab.evaluate('document.querySelector("[data-quick-review-done]").innerText'),
        /共有 12 个到期词/,
      );
      assert.match(
        await firstTab.evaluate('document.querySelector("[data-quick-review-done]").innerText'),
        /不代表今日正式复习已完成/,
      );
      assert.equal(
        await firstTab.evaluate('localStorage.getItem(' + JSON.stringify(savedDraft.key) + ')'),
        null,
      );
      const afterCalls = await firstTab.evaluate(
        `({ dashboardWordsCalls: window.quickReviewFixture.dashboardWordsCalls, planWrites: window.quickReviewFixture.planWrites, calls: window.quickReviewFixture.calls })`,
      );
      assert.equal(
        afterCalls.dashboardWordsCalls,
        beforeCompletion.dashboardWordsCalls,
        'local practice must not reload due words',
      );
      assert.deepEqual(
        afterCalls.calls.slice(beforeCompletion.calls.length),
        [],
        'local practice must not make hidden API requests',
      );
      assert.deepEqual(
        afterCalls.planWrites,
        [],
        'quick practice must not create or generate a plan',
      );

      await firstTab.evaluate(`document.querySelector('[data-quick-review-done] button')?.click()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review] input")',
        'return to setup before testing unavailable draft storage',
      );
      await firstTab.evaluate(`(() => {
        window.quickReviewFixture.originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (String(key).startsWith('lexloop.quick-review.v1.')) {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          }
          return window.quickReviewFixture.originalSetItem.call(this, key, value);
        };
        document.querySelector('input[type="radio"][value="1"]')?.click();
        [...document.querySelectorAll('.words-panel button')].find((button) => button.textContent.includes('开始练习（1 题）'))?.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active]")?.innerText.includes("本地进度保存失败")',
        'visible notice when local draft storage fails',
      );
      assert.equal(
        await firstTab.evaluate(`localStorage.getItem('lexloop.quick-review.v1.quick-user-a.due')`),
        null,
        'a quota failure must not leave a partial draft',
      );
      await firstTab.evaluate(`(() => {
        [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('显示释义'))?.click();
        Storage.prototype.setItem = window.quickReviewFixture.originalSetItem;
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active]")?.innerText.includes("释义示例 1")',
        'practice remains usable after draft storage fails',
      );

      await firstTab.evaluate(`(() => {
        localStorage.removeItem('fixture.quick-review-order-a');
        localStorage.setItem('lexloop.quick-review.v1.quick-user-a.due', JSON.stringify({
          version: 1,
          userId: 'quick-user-a',
          wordIds: ['a-due-01'],
          currentIndex: 0,
          revealed: false,
        }));
        localStorage.setItem('fixture.quick-review-missing', 'mixed');
      })()`);
      await firstTab.send('Page.reload');
      await until(
        firstTab,
        `document.querySelector('.sidebar-book strong')?.textContent.includes('练习者 A')`,
        'reload with mixed missing-meaning due words',
      );
      await openWords(firstTab);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review]")?.innerText.includes("到期 12 · 可回想 10")',
        'separate due total and usable recall candidates',
      );
      assert.match(
        await firstTab.evaluate('document.querySelector("[data-quick-review]").innerText'),
        /当前可回想词候选已经变化，上一份练习未结算，已清除旧进度/,
      );
      assert.equal(
        await firstTab.evaluate(`localStorage.getItem('lexloop.quick-review.v1.quick-user-a.due')`),
        null,
        'a saved draft containing newly unavailable due cards is cleared with a visible notice',
      );
      assert.match(
        await firstTab.evaluate('document.querySelector("[data-quick-review]").innerText'),
        /2 个到期词暂无可用释义，未纳入本次候选/,
      );
      const formalReviewControl = await firstTab.evaluate(`(() => {
        const input = document.querySelector('#review-session-count');
        return {
          max: input?.max,
          text: input?.closest('.review-session-control')?.innerText ?? '',
        };
      })()`);
      assert.equal(
        formalReviewControl.max,
        '10',
        'formal review count must exclude two missing-meaning due words',
      );
      assert.match(formalReviewControl.text, /10 个可练；共 12 个到期/);
      assert.match(formalReviewControl.text, /另有 2 个到期词缺少可用释义，不计入本次计划/);
      assert.deepEqual(
        await firstTab.evaluate(
          `Array.from(document.querySelectorAll('[data-quick-review] input[type="radio"]')).map((input) => input.value)`,
        ),
        ['1', '3', '5', '10'],
      );
      await firstTab.evaluate(`(() => {
        document.querySelector('input[type="radio"][value="1"]')?.click();
        [...document.querySelectorAll('.words-panel button')].find((button) => button.textContent.includes('开始练习（1 题）'))?.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active] h2")?.textContent === "steady2"',
        'missing gloss item omitted without changing due order',
      );
      await firstTab.evaluate(`(() => {
        [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('显示释义'))?.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-active]")?.innerText.includes("释义示例 2")',
        'reveal the next usable meaning, not a placeholder',
      );
      await firstTab.evaluate(`(() => {
        [...document.querySelectorAll('[data-quick-review-active] button')].find((button) => button.textContent.includes('结束本次练习'))?.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review-done]")?.innerText.includes("暂无可用释义")',
        'completion explicitly leaves missing meanings due',
      );
      const missingCompletion = await firstTab.evaluate(
        'document.querySelector("[data-quick-review-done]").innerText',
      );
      assert.match(missingCompletion, /本次看完了 1 个有可用释义的词卡/);
      assert.match(missingCompletion, /其中 2 个暂无可用释义，未纳入本次练习，仍保留原排期/);
      assert.doesNotMatch(missingCompletion, /2 个词.*回想|2 个词.*完成/);

      await firstTab.evaluate(`localStorage.setItem('fixture.quick-review-missing', 'all')`);
      await firstTab.send('Page.reload');
      await until(
        firstTab,
        `document.querySelector('.sidebar-book strong')?.textContent.includes('练习者 A')`,
        'reload with no usable due glosses',
      );
      await openWords(firstTab);
      await until(
        firstTab,
        'document.querySelector("[data-quick-review]")?.innerText.includes("当前到期词都缺少可用释义")',
        'empty recall-candidate state',
      );
      const emptyFormalPlanState = await firstTab.evaluate(`(() => {
        const control = document.querySelector('.review-session-control')?.innerText ?? '';
        const createButton = document.querySelector('.words-panel button.create');
        return { control, disabled: createButton?.disabled, text: createButton?.innerText ?? '' };
      })()`);
      assert.match(emptyFormalPlanState.control, /没有带可用释义的到期词候选/);
      assert.match(emptyFormalPlanState.control, /原排期中，不会因缺少释义而被移除或计作已复习/);
      assert.equal(emptyFormalPlanState.disabled, true);
      assert.equal(emptyFormalPlanState.text, '创建学习计划');
      await firstTab.evaluate(`(() => {
        [...document.querySelectorAll('[data-quick-review] button')].find((button) => button.textContent.includes('选择其他词表'))?.click();
      })()`);
      await until(
        firstTab,
        'document.querySelector("[role=dialog][aria-modal=true]")',
        'open the existing wordbook chooser as a recovery path',
      );
      assert.deepEqual(browserErrors, [], 'browser runtime errors occurred');
    } finally {
      for (const socket of sockets) {
        if (socket.readyState < WebSocket.CLOSING) socket.close();
      }
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
