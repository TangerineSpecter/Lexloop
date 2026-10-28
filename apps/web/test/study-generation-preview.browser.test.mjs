import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'late study generation responses do not reopen or replace the selected preview',
  { skip: !baseUrl, timeout: 120_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-generation-preview-test-'));
    const browser = spawn(
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
      { stdio: 'ignore', detached: true },
    );
    let launchError;
    let closed = false;
    let socket;
    const browserErrors = [];
    const waiting = new Map();
    let sequence = 0;
    browser.on('error', (error) => {
      launchError = error;
    });
    browser.on('close', () => {
      closed = true;
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
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation can briefly replace the page's JavaScript context.
          }
          await delay(100);
        }
        const pageState = await evaluate(
          `({ path: location.pathname, text: document.body.innerText.slice(-900) })`,
        ).catch(() => null);
        assert.fail(
          `Timed out waiting for ${expression}; state=${JSON.stringify({ pageState, browserErrors })}`,
        );
      };
      const clickHistory = async () => {
        await evaluate(
          '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("今日学习历史")).click()',
        );
      };
      const openRetry = async (index) => {
        await evaluate(
          `document.querySelectorAll(".history-grid article")[${index}].querySelector("button").click()`,
        );
        await until('document.querySelector(".plan-preview-layer")');
      };
      const startGeneration = async (expectedCount) => {
        await evaluate('document.querySelector(".plan-preview .start-challenge").click()');
        await until(`window.generationAttempts.length === ${expectedCount}`);
      };
      const resolvePlan = async (id, status, response) => {
        await evaluate(`(() => {
          const plan = window.planLists["study-user"].find((item) => item.id === ${JSON.stringify(id)});
          plan.status = ${JSON.stringify(status)};
          window.resolveGeneration(${JSON.stringify(id)}, ${response});
        })()`);
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
          const makePlan = (id, word, status = 'FAILED') => ({
            id, mode: 'group', purpose: 'normal', status,
            blocksNewPlanCreation: false,
            wordCount: 1, groupCount: 1, completed: 0,
            createdAt: new Date().toISOString(), completedAt: null,
            generationError: status === 'FAILED' ? 'fixture failure' : null,
            words: [{ id: id + '-word', word, part: 'adj.', meaning: '平稳的', source: 'NEW', groupIndex: 0, completed: false, nextReviewAt: null, activeWeaknesses: [] }],
            content: null,
            summary: { totalQuestions: 0, correctQuestions: 0, durationSeconds: 0, typeStats: [] },
          });
          const firstSession = { accessToken: 'first-fixture', user: { id: 'study-user', email: 'first@example.invalid', displayName: '丢失的猫咪', role: 'USER' } };
          const secondSession = { accessToken: 'second-fixture', user: { id: 'second-study-user', email: 'second@example.invalid', displayName: 'Second user · 这是一个非常长的中文账户名称用于验证单行省略', role: 'USER' } };
          const secondActivePlan = makePlan('second-active', 'focused', 'ACTIVE');
          secondActivePlan.blocksNewPlanCreation = true;
          secondActivePlan.wordCount = 2;
          secondActivePlan.words = [
            { ...secondActivePlan.words[0], source: 'REVIEW' },
            { ...secondActivePlan.words[0], id: 'second-active-new', word: 'steady', source: 'NEW' },
          ];
          localStorage.setItem('lexloop.session', JSON.stringify(firstSession));
          window.planLists = {
            'study-user': [
              makePlan('preview-a', 'bright'),
              makePlan('preview-b', 'gentle'),
              makePlan('preview-c', 'calm'),
              makePlan('preview-account', 'useful'),
            ],
            'second-study-user': [secondActivePlan],
          };
          window.generationAttempts = [];
          window.studyPlanCreateBodies = [];
          window.generationResolvers = {};
          window.resolveGeneration = (id, response) => {
            const resolve = window.generationResolvers[id];
            if (!resolve) throw new Error('No pending generation for ' + id);
            delete window.generationResolvers[id];
            resolve(response);
          };
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            const session = JSON.parse(localStorage.getItem('lexloop.session') || 'null');
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: session?.user.id ?? null });
            if (path.endsWith('/api/v1/auth/refresh')) return Response.json({ message: 'No fixture session' }, { status: 401 });
            if (path.endsWith('/api/v1/auth/login') && method === 'POST') return Response.json(secondSession);
            if (path.includes('/api/v1/vocabulary/default')) {
              return Response.json(
                session?.user.id === 'study-user'
                  ? { id: 'book-a', title: 'Book A', totalWords: 10 }
                  : { id: 'book-b', title: 'Second account book', totalWords: 25 },
              );
            }
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 1, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 1, reviewWords: [
              { id: 'review-oldest', word: 'steady', part: 'adj.', meaning: '稳定的' },
              { id: 'review-next', word: 'patient', part: 'adj.', meaning: '耐心的' },
              { id: 'review-latest', word: 'curious', part: 'adj.', meaning: '好奇的' },
            ], newWords: [] });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.endsWith('/api/v1/ai/models')) return Response.json([]);
            const generation = path.match(new RegExp('/api/v1/study/plans/([^/]+)/generate$'));
            if (generation && method === 'POST') {
              const id = generation[1];
              window.generationAttempts.push(id);
              return new Promise((resolve) => { window.generationResolvers[id] = resolve; });
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'GET') {
              return Response.json(window.planLists[session?.user.id] ?? []);
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'POST') {
              window.studyPlanCreateBodies.push(JSON.parse(options.body));
              return Response.json({ message: 'Fixture stopped before plan generation' }, { status: 409 });
            }
            return Response.json({});
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector("[role=tab]")');
      await clickHistory();
      await until('document.querySelectorAll(".history-grid article").length === 4');

      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("单词列表")).click()',
      );
      await until('document.querySelector("#review-session-count")?.value === "3"');
      await evaluate('document.querySelector("#review-session-count").focus()');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
      });
      await until(
        'document.querySelector(".review-session-control output")?.textContent.includes("2 / 3")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".review-session-control p")?.textContent.includes("1 个仍待复习")',
        ),
        true,
      );
      await evaluate('document.querySelector(".toolbar button.create").click()');
      await until('window.studyPlanCreateBodies.length === 1');
      assert.deepEqual(await evaluate('window.studyPlanCreateBodies[0]'), {
        newWordCount: 0,
        reviewWordCount: 2,
        mode: 'group',
      });
      await until(
        'document.querySelector(".book-message")?.textContent.includes("Fixture stopped before plan generation")',
      );
      await evaluate('document.querySelector("#review-session-count").focus()');
      for (let step = 0; step < 2; step++) {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          windowsVirtualKeyCode: 37,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          windowsVirtualKeyCode: 37,
        });
      }
      await until(
        'document.querySelector(".review-session-control output")?.textContent.includes("0 / 3")',
      );
      assert.equal(
        await evaluate('document.querySelector(".toolbar button.create").disabled'),
        true,
      );
      assert.equal(await evaluate('window.studyPlanCreateBodies.length'), 1);
      await clickHistory();
      await until('document.querySelectorAll(".history-grid article").length === 4');

      // Closing the first preview leaves its server request alive. A double
      // click still starts only one client request.
      await openRetry(0);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'bright',
      );
      await evaluate(
        'document.querySelector(".plan-preview .start-challenge").click(); document.querySelector(".plan-preview .start-challenge").click()',
      );
      await until('window.generationAttempts.length === 1');
      assert.deepEqual(await evaluate('window.generationAttempts'), ['preview-a']);
      await evaluate('document.querySelector(".plan-preview header button").click()');
      await until('document.querySelector(".plan-preview-layer") === null');

      // Escape acts like Back/close without cancelling the plan. The previous
      // success and failure must not replace the third plan selected below.
      await openRetry(1);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'gentle',
      );
      await startGeneration(2);
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
      await until('document.querySelector(".plan-preview-layer") === null');

      await openRetry(2);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'calm',
      );
      await startGeneration(3);
      await resolvePlan('preview-a', 'ACTIVE', 'Response.json(window.planLists["study-user"][0])');
      await until('document.querySelector(".preview-word-title strong")?.textContent === "calm"');
      await until('document.querySelector(".history-grid article")?.innerText.includes("学习中")');
      assert.equal(await evaluate('document.querySelector(".plan-preview-layer") !== null'), true);

      await resolvePlan(
        'preview-b',
        'FAILED',
        'Response.json({ message: "fixture generation failed" }, { status: 502 })',
      );
      await until(
        'window.planLists["study-user"][1].status === "FAILED" && window.generationResolvers["preview-b"] === undefined',
      );
      await delay(150);
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'calm',
      );
      assert.equal(
        await evaluate('document.querySelector(".plan-preview .book-message") === null'),
        true,
      );

      await resolvePlan('preview-c', 'ACTIVE', 'Response.json(window.planLists["study-user"][2])');
      await until(
        'document.querySelector(".plan-preview .start-challenge")?.textContent.includes("开始今天的挑战")',
      );
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong").textContent'),
        'calm',
      );
      await evaluate('document.querySelector(".plan-preview-scrim").click()');
      await until('document.querySelector(".plan-preview-layer") === null');

      // A cache miss without a selected model exposes a direct setup action.
      // The same plan remains retryable after the learner configures a model.
      await openRetry(1);
      await startGeneration(4);
      await resolvePlan(
        'preview-b',
        'FAILED',
        'Response.json({ message: "部分学习材料未命中缓存，请先在阅读材料模型设置中选择可用的大模型" }, { status: 400 })',
      );
      await until(
        'document.querySelector(".plan-preview .book-message")?.textContent.includes("未命中缓存")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".plan-preview .start-challenge")?.textContent.includes("设置阅读材料模型")',
        ),
        true,
      );
      await evaluate('document.querySelector(".plan-preview .start-challenge").click()');
      await until('document.querySelector(".study-settings-drawer")');
      await until('document.querySelector(".study-settings-drawer .model-options-empty")');
      await until(`(() => {
        const drawer = document.querySelector('.study-settings-drawer')?.getBoundingClientRect();
        return drawer && drawer.left >= 0 && drawer.right <= innerWidth;
      })()`);
      const desktopModelDrawerBounds = await evaluate(`(() => {
        const drawer = document.querySelector('.study-settings-drawer').getBoundingClientRect();
        return { left: drawer.left, right: drawer.right, viewport: innerWidth, clientWidth: document.documentElement.clientWidth, pageWidth: document.documentElement.scrollWidth };
      })()`);
      assert.ok(
        desktopModelDrawerBounds.left >= 0 && desktopModelDrawerBounds.right <= 1440,
        JSON.stringify(desktopModelDrawerBounds),
      );
      assert.ok(
        desktopModelDrawerBounds.pageWidth <= desktopModelDrawerBounds.clientWidth,
        JSON.stringify(desktopModelDrawerBounds),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until(`(() => {
        const drawer = document.querySelector('.study-settings-drawer')?.getBoundingClientRect();
        return drawer && drawer.left >= 0 && drawer.right <= innerWidth;
      })()`);
      const modelDrawerBounds = await evaluate(`(() => {
        const drawer = document.querySelector('.study-settings-drawer').getBoundingClientRect();
        return { left: drawer.left, right: drawer.right, width: drawer.width, viewport: innerWidth, clientWidth: document.documentElement.clientWidth, pageWidth: document.documentElement.scrollWidth, text: document.querySelector('.study-settings-drawer').innerText };
      })()`);
      assert.ok(
        modelDrawerBounds.left >= 0 && modelDrawerBounds.right <= 390,
        JSON.stringify(modelDrawerBounds),
      );
      assert.ok(
        modelDrawerBounds.pageWidth <= modelDrawerBounds.clientWidth,
        JSON.stringify(modelDrawerBounds),
      );
      assert.ok(
        modelDrawerBounds.text.includes('暂时没有可用模型'),
        JSON.stringify(modelDrawerBounds),
      );
      await evaluate('document.querySelector(".study-settings-drawer header button").click()');
      await until('document.querySelector(".study-settings-drawer") === null');

      // An outstanding response from the prior account cannot populate the
      // next account's dashboard after logout and login.
      await openRetry(3);
      await startGeneration(5);
      await evaluate('document.querySelector(".plan-preview header button").click()');
      await until('document.querySelector(".plan-preview-layer") === null');

      // The account card opens on mouse hover, and the pointer can move from
      // the trigger into its attached menu without crossing a closing gap.
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 500 });
      await until('document.querySelector(".account-menu") === null');
      await evaluate(`(() => {
        const counts = (window.accountMenuPositionListeners = { added: 0, removed: 0 });
        const add = window.addEventListener;
        const remove = window.removeEventListener;
        window.addEventListener = function (type, listener, options) {
          if (type === 'resize' || type === 'scroll') counts.added += 1;
          return add.call(this, type, listener, options);
        };
        window.removeEventListener = function (type, listener, options) {
          if (type === 'resize' || type === 'scroll') counts.removed += 1;
          return remove.call(this, type, listener, options);
        };
      })()`);
      await evaluate('document.querySelector(".sidebar-book").click()');
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      const clickOnlyMenu = await evaluate(`(() => {
        const button = document.querySelector('.sidebar-book');
        const menu = document.querySelector('.account-menu');
        const item = menu.querySelector('button');
        const rect = menu.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const hit = document.elementFromPoint(itemRect.left + itemRect.width / 2, itemRect.top + itemRect.height / 2);
        const style = getComputedStyle(menu);
        return {
          expanded: button.getAttribute('aria-expanded'),
          visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.opacity === '1',
          withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          itemHit: menu.contains(hit),
          itemLabel: item.textContent.trim(),
          accountName: menu.querySelector('.account-menu-user strong').textContent.trim(),
          accountNameHeight: menu.querySelector('.account-menu-user strong').getBoundingClientRect().height,
          accountNameLineHeight: parseFloat(getComputedStyle(menu.querySelector('.account-menu-user strong')).lineHeight),
          accountNameTitle: menu.querySelector('.account-menu-user strong').title,
        };
      })()`);
      assert.equal(clickOnlyMenu.expanded, 'true', JSON.stringify(clickOnlyMenu));
      assert.equal(clickOnlyMenu.visible, true, JSON.stringify(clickOnlyMenu));
      assert.equal(clickOnlyMenu.withinViewport, true, JSON.stringify(clickOnlyMenu));
      assert.equal(clickOnlyMenu.itemHit, true, JSON.stringify(clickOnlyMenu));
      assert.equal(clickOnlyMenu.accountName, '丢失的猫咪', JSON.stringify(clickOnlyMenu));
      assert.equal(
        clickOnlyMenu.accountNameHeight <= clickOnlyMenu.accountNameLineHeight + 1,
        true,
        JSON.stringify(clickOnlyMenu),
      );
      assert.equal(clickOnlyMenu.accountNameTitle, '丢失的猫咪');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
      assert.deepEqual(await evaluate('window.accountMenuPositionListeners'), {
        added: 2,
        removed: 2,
      });
      await evaluate('document.querySelector(".sidebar-book").focus()');
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
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      assert.equal(
        await evaluate('document.querySelector(".sidebar-book").getAttribute("aria-expanded")'),
        'true',
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
      assert.deepEqual(await evaluate('window.accountMenuPositionListeners'), {
        added: 4,
        removed: 4,
      });

      // A physical mouse click at the control must leave the menu visible.
      const physicalClickPoint = await evaluate(`(() => {
        const rect = document.querySelector('.sidebar-book').getBoundingClientRect();
        window.accountCardPointerTrace = [];
        const wrapper = document.querySelector('.sidebar-account-wrap');
        const button = document.querySelector('.sidebar-book');
        wrapper.addEventListener('pointerenter', (event) => window.accountCardPointerTrace.push('wrap-enter:' + event.pointerType), { once: true });
        wrapper.addEventListener('pointerleave', (event) => window.accountCardPointerTrace.push('wrap-leave:' + (event.relatedTarget?.className ?? 'none')), { once: true });
        button.addEventListener('pointerenter', (event) => window.accountCardPointerTrace.push('enter:' + event.pointerType), { once: true });
        button.addEventListener('click', (event) => window.accountCardPointerTrace.push('click:' + event.detail + ':pointer=' + (event.pointerType ?? 'none') + ':hover=' + window.matchMedia('(hover: hover) and (pointer: fine)').matches), { once: true });
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: physicalClickPoint.x,
        y: physicalClickPoint.y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: physicalClickPoint.x,
        y: physicalClickPoint.y,
        button: 'left',
        clickCount: 1,
      });
      await delay(150);
      const physicalClickState = await evaluate(`(() => ({
        trace: window.accountCardPointerTrace,
        hoverMedia: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
        expanded: document.querySelector('.sidebar-book').getAttribute('aria-expanded'),
        menuRect: document.querySelector('.account-menu')?.getBoundingClientRect().toJSON() ?? null,
        hit: document.elementFromPoint(${physicalClickPoint.x}, ${physicalClickPoint.y})?.outerHTML?.slice(0, 180) ?? null,
      }))()`);
      assert.equal(physicalClickState.expanded, 'true', JSON.stringify(physicalClickState));
      assert.ok(physicalClickState.menuRect?.height > 0, JSON.stringify(physicalClickState));
      const mouseEnterIndex = physicalClickState.trace.findIndex((item) => item === 'enter:mouse');
      const mouseClickIndex = physicalClickState.trace.findIndex((item) =>
        item.startsWith('click:1:'),
      );
      assert.ok(
        mouseEnterIndex >= 0 && mouseClickIndex > mouseEnterIndex,
        JSON.stringify(physicalClickState),
      );
      assert.ok(physicalClickState.trace.some((item) => item.startsWith('click:')));
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 500 });
      const desktopCard = await evaluate(`(() => {
        const rect = document.querySelector('.sidebar-book').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: desktopCard.x,
        y: desktopCard.y,
      });
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      const desktopMenuBounds = await evaluate(`(() => {
        const menu = document.querySelector('.account-menu').getBoundingClientRect();
        const sidebar = document.querySelector('.study-sidebar').getBoundingClientRect();
        const trigger = document.querySelector('.sidebar-book').getBoundingClientRect();
        return { left: menu.left, right: menu.right, top: menu.top, triggerBottom: trigger.bottom, sidebarRight: sidebar.right, viewportWidth: innerWidth };
      })()`);
      assert.ok(desktopMenuBounds.left >= 0);
      assert.ok(desktopMenuBounds.left >= desktopMenuBounds.sidebarRight);
      assert.ok(desktopMenuBounds.right <= desktopMenuBounds.viewportWidth);
      assert.ok(desktopMenuBounds.top >= 0);
      const gapPoint = {
        x: desktopMenuBounds.sidebarRight + 4,
        y: desktopMenuBounds.top + 35,
      };
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: gapPoint.x,
        y: gapPoint.y,
      });
      await delay(100);
      assert.equal(
        await evaluate('Boolean(document.querySelector(".account-menu[data-positioned=true]"))'),
        true,
        'The menu should stay open while the pointer crosses the gap from the account card',
      );
      const menuHeaderPoint = await evaluate(`(() => {
        const rect = document.querySelector('.account-menu-user').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, color: getComputedStyle(document.querySelector('.account-menu-user')).backgroundColor };
      })()`);
      assert.equal(menuHeaderPoint.color, 'rgb(49, 94, 182)');
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: menuHeaderPoint.x,
        y: menuHeaderPoint.y,
      });
      assert.equal(await evaluate('Boolean(document.querySelector(".account-menu"))'), true);

      // Moving away closes the menu; Escape also closes it and restores focus.
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 500 });
      await until('document.querySelector(".account-menu") === null');
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: desktopCard.x,
        y: desktopCard.y,
      });
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
      assert.equal(
        await evaluate('document.activeElement === document.querySelector(".sidebar-book")'),
        true,
      );

      // At a narrow viewport the drawer still opens the same menu by click.
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 500 });
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await evaluate('document.querySelector(".topbar-account").click()');
      await until(
        'document.querySelector(".study-sidebar.is-open") && document.querySelector(".account-menu[data-positioned=true]")',
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
        'document.querySelector(".account-menu") === null && !document.querySelector(".study-sidebar").classList.contains("is-open")',
      );
      assert.equal(
        await evaluate('document.activeElement === document.querySelector(".topbar-account")'),
        true,
      );
      await evaluate('document.querySelector(".menu-trigger").click()');
      await until('document.querySelector(".study-sidebar.is-open")');
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const touchPoint = await evaluate(`(() => {
        const rect = document.querySelector('.sidebar-book').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: touchPoint.x, y: touchPoint.y, radiusX: 2, radiusY: 2, force: 1, id: 1 },
        ],
      });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      const mobileMenuBounds = await evaluate(`(() => {
        const menuElement = document.querySelector('.account-menu');
        const menu = menuElement.getBoundingClientRect();
        const sidebar = document.querySelector('.study-sidebar').getBoundingClientRect();
        const item = menuElement.querySelector('button');
        const itemRect = item.getBoundingClientRect();
        const hit = document.elementFromPoint(itemRect.left + itemRect.width / 2, itemRect.top + itemRect.height / 2);
        const name = menuElement.querySelector('.account-menu-user strong');
        return { expanded: document.querySelector('.sidebar-book').getAttribute('aria-expanded'), left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom, viewportWidth: innerWidth, sidebarRight: sidebar.right, itemHit: menuElement.contains(hit), name: name.textContent.trim(), nameHeight: name.getBoundingClientRect().height, nameLineHeight: parseFloat(getComputedStyle(name).lineHeight), nameTitle: name.title };
      })()`);
      assert.equal(mobileMenuBounds.expanded, 'true');
      assert.ok(mobileMenuBounds.left >= 0);
      assert.ok(mobileMenuBounds.right <= mobileMenuBounds.viewportWidth);
      assert.ok(mobileMenuBounds.bottom <= 844);
      assert.equal(mobileMenuBounds.itemHit, true, JSON.stringify(mobileMenuBounds));
      assert.equal(mobileMenuBounds.name, '丢失的猫咪', JSON.stringify(mobileMenuBounds));
      assert.ok(mobileMenuBounds.nameHeight <= mobileMenuBounds.nameLineHeight + 1);
      assert.equal(mobileMenuBounds.nameTitle, '丢失的猫咪');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 700,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const resizedMenuBounds = await evaluate(`(() => {
        const menu = document.querySelector('.account-menu').getBoundingClientRect();
        return { left: menu.left, right: menu.right, bottom: menu.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
      })()`);
      assert.ok(resizedMenuBounds.left >= 8, JSON.stringify(resizedMenuBounds));
      assert.ok(resizedMenuBounds.right <= 320, JSON.stringify(resizedMenuBounds));
      assert.ok(resizedMenuBounds.bottom <= 700, JSON.stringify(resizedMenuBounds));
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
      assert.equal(
        await evaluate('document.activeElement === document.querySelector(".sidebar-book")'),
        true,
      );
      await evaluate('document.querySelector(".sidebar-book").click()');
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      const logoutButton = await evaluate(`(() => {
        const rect = [...document.querySelectorAll('.account-menu button')]
          .find((button) => button.textContent.includes('退出登录')).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: logoutButton.x,
        y: logoutButton.y,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: logoutButton.x,
        y: logoutButton.y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: logoutButton.x,
        y: logoutButton.y,
        button: 'left',
        clickCount: 1,
      });
      await until('document.querySelector(".welcome-page")');
      await evaluate(`document.querySelector('a[href="/login"]').click()`);
      await until('document.querySelector("input[name=email]")');
      await evaluate(`(() => {
        const setValue = (selector, value) => {
          const input = document.querySelector(selector);
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setValue('input[name=email]', 'second@example.invalid');
        setValue('input[name=password]', 'fixture-password');
        document.querySelector('form').requestSubmit();
      })()`);
      await until(
        'document.querySelector(".study-app .sidebar-book")?.innerText.includes("Second user")',
      );
      await until(
        'document.querySelector(".study-app .sidebar-book > div > span")?.textContent === "Second account book"',
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".progress-grid .metric-card")[0].querySelector(".metric-front b").textContent',
        ),
        '25',
      );
      await evaluate('document.querySelector(".topbar-account").click()');
      await until('document.querySelector(".account-menu[data-positioned=true]")');
      const longAccountName = await evaluate(`(() => {
        const name = document.querySelector('.account-menu-user strong');
        return {
          text: name.textContent.trim(),
          ariaLabel: name.getAttribute('aria-label'),
          title: name.title,
          whiteSpace: getComputedStyle(name).whiteSpace,
          height: name.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(name).lineHeight),
          textOverflow: getComputedStyle(name).textOverflow,
        };
      })()`);
      assert.equal(
        longAccountName.text,
        'Second user · 这是一个非常长的中文账户名称用于验证单行省略',
      );
      assert.equal(longAccountName.ariaLabel, longAccountName.text);
      assert.equal(longAccountName.title, longAccountName.text);
      assert.equal(longAccountName.whiteSpace, 'nowrap');
      assert.ok(longAccountName.height <= longAccountName.lineHeight + 1);
      assert.equal(longAccountName.textOverflow, 'ellipsis');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
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
        'document.querySelector(".account-menu") === null && !document.querySelector(".study-sidebar").classList.contains("is-open")',
      );
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("单词列表")).click()',
      );
      await until(
        'document.querySelector(".review-session-control strong")?.textContent.includes("先完成当前学习计划")',
      );
      assert.equal(
        await evaluate('document.querySelector("#review-session-count") === null'),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".review-session-control p")?.textContent.includes("1 个复习词和 1 个新词")',
        ),
        true,
      );
      await evaluate('document.querySelector(".toolbar button.create").click()');
      await until('document.querySelector(".plan-preview-layer")');
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong")?.textContent'),
        'focused',
      );
      assert.equal(await evaluate('window.studyPlanCreateBodies.length'), 1);
      await evaluate('document.querySelector(".plan-preview-scrim").click()');
      await until('document.querySelector(".plan-preview-layer") === null');
      await clickHistory();
      await until('document.querySelectorAll(".history-grid article").length === 1');
      await resolvePlan(
        'preview-account',
        'ACTIVE',
        'Response.json(window.planLists["study-user"][3])',
      );
      await delay(200);
      assert.equal(await evaluate('document.querySelector(".plan-preview-layer") === null'), true);
      assert.equal(await evaluate('document.querySelectorAll(".history-grid article").length'), 1);
      assert.deepEqual(browserErrors, []);
    } finally {
      socket?.close();
      try {
        if (browser.pid) process.kill(-browser.pid, 'SIGTERM');
      } catch {
        browser.kill('SIGTERM');
      }
      if (!closed) await new Promise((resolve) => browser.once('close', resolve));
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
