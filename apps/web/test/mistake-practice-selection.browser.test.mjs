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

      const clickVisible = async (selector) => {
        const point = await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return null;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, visible: rect.width > 0 && rect.height > 0,
            hit: hit === element || element.contains(hit),
            hitDescription: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().replace(/\\s+/g, '.') : '') : null };
        })()`);
        assert.ok(point?.visible, `Expected visible control: ${selector}`);
        assert.equal(
          point.hit,
          true,
          `Expected unobstructed control: ${selector}; hit=${point.hitDescription}`,
        );
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
        });
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

      const selectQuestionType = async (value, label) => {
        const trigger = 'button[aria-label="按题型筛选"]';
        await clickVisible(trigger);
        await until(
          `document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-expanded') === 'true'`,
        );
        await clickVisible(`[role="option"][data-option-value="${value}"]`);
        await until(
          `document.querySelector(${JSON.stringify(trigger)})?.textContent.trim() === ${JSON.stringify(label)}`,
        );
      };
      const fillSearchInput = async (value) => {
        await clickVisible('#mistakes-search-input');
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Control',
          code: 'ControlLeft',
          modifiers: 2,
          windowsVirtualKeyCode: 17,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 2,
          windowsVirtualKeyCode: 65,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers: 2,
          windowsVirtualKeyCode: 65,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Control',
          code: 'ControlLeft',
          windowsVirtualKeyCode: 17,
        });
        await send('Input.insertText', { text: value });
        const state = JSON.parse(
          await evaluate(
            'JSON.stringify({ focused: document.activeElement?.id, value: document.querySelector("#mistakes-search-input")?.value })',
          ),
        );
        assert.equal(
          state.focused,
          'mistakes-search-input',
          'keyboard entry should focus the search input',
        );
        assert.equal(
          state.value,
          value,
          'keyboard entry should update the controlled search input',
        );
      };
      const pressEnter = async () => {
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
      };

      const weaknesses = (id, questionType, wrongCount = 2) => ({
        id,
        questionType,
        status: 'active',
        wrongCount,
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
          weaknesses: [
            weaknesses('standard-signal', 'READING_COMPREHENSION', 14),
            weaknesses('legacy-other-signal', 'OTHER', 1),
          ],
        },
        {
          bookWordId: 'output-word',
          word: 'journey',
          part: 'n.',
          meaning: '旅程',
          bookTitle: 'Test book',
          severity: 56,
          lastWrongAt: '2026-10-26T10:00:00.000Z',
          weaknesses: [weaknesses('output-signal', 'OUTPUT', 1)],
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
      const paginatedItems = Array.from({ length: 40 }, (_, index) => ({
        bookWordId: `page-word-${index + 1}`,
        word: `page-word-${index + 1}`,
        part: 'n.',
        meaning: '示例释义',
        bookTitle: 'Pagination fixture',
        severity: 56,
        lastWrongAt: '2026-10-26T10:00:00.000Z',
        weaknesses: [weaknesses(`page-signal-${index + 1}`, 'READING_COMPREHENSION', 2)],
      }));
      paginatedItems[34] = {
        ...paginatedItems[34],
        word: 'pencil box',
        meaning: '文具盒',
        bookTitle: 'Everyday Stationery',
      };
      const mistakeJourneyItem = {
        ...paginatedItems[34],
        bookWordId: 'journey-word',
        weaknesses: [weaknesses('journey-signal', 'READING_COMPREHENSION', 3)],
      };
      const mistakeJourneyQuestion = {
        bookWordId: 'journey-word',
        type: 'READING_COMPREHENSION',
        prompt: 'What did Mina put in the box?',
        options: ['Her pencils', 'Her lunch'],
        correctAnswers: ['Her pencils'],
        explanation: 'The passage says that Mina put her pencils in the box.',
      };
      const mistakeJourneyPlan = {
        id: 'mistake-practice-journey',
        mode: 'group',
        purpose: 'weakness',
        wordCount: 1,
        words: [
          {
            id: 'journey-word',
            word: 'pencil box',
            part: 'n.',
            meaning: '文具盒',
            source: 'REVIEW',
            groupIndex: 0,
            completed: false,
            nextReviewAt: '2026-11-04T09:00:00.000Z',
            activeWeaknesses: [
              {
                questionType: 'READING_COMPREHENSION',
                wrongCount: 3,
                consecutiveCorrect: 0,
                remainingCorrect: 2,
              },
            ],
            question: mistakeJourneyQuestion,
          },
        ],
        completed: 0,
        groupCount: 1,
        content: {
          groups: [
            {
              index: 0,
              title: 'A missing pencil',
              wordOccurrences: { 'pencil box': 1 },
              sentences: [
                {
                  english: 'Mina put her pencils into the pencil box.',
                  chinese: '米娜把铅笔放进了文具盒。',
                  simplified: '米娜把铅笔放进了盒子。',
                },
              ],
              questions: [mistakeJourneyQuestion],
            },
          ],
        },
        status: 'ACTIVE',
        blocksNewPlanCreation: true,
        createdAt: '2026-11-02T10:00:00.000Z',
        summary: { totalQuestions: 0, correctQuestions: 0, durationSeconds: 0, typeStats: [] },
      };

      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'mistake-user', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
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
          window.mistakeJourneyEnabled = false;
          window.mistakeJourneyPlan = ${JSON.stringify(mistakeJourneyPlan)};
          window.mistakeJourneySelections = [];
          window.mistakeJourneyCompletionWrites = [];
          window.mistakeListRequests = [];
          window.mistakeDetailRequests = [];
          window.addEventListener('beforeunload', () => {
            if (typeof window.releaseDeferredMistakeDetail === 'function') {
              localStorage.setItem('fixture.pending-mistake-detail-unloaded', 'yes');
            }
          });
          window.failOutputFilterOnce = true;
          window.failMistakeSearchOnce = true;
          window.failOlderCursorOnce = true;
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            const session = JSON.parse(localStorage.getItem('lexloop.session') || 'null');
            const sessionUserId = session?.user?.id ?? 'mistake-user';
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: sessionUserId });
            if (path.includes('/api/v1/mistakes?')) {
              const query = new URL(path, location.origin).searchParams;
              const status = query.get('status');
              const questionType = query.get('questionType') || '';
              const page = Number(query.get('page') || 1);
              const search = query.get('search') || '';
              const normalizedSearch = search.toLocaleLowerCase();
              const activeRace = new URL(location.href).searchParams.has('activeRace');
              window.mistakeListRequests.push({ status, questionType, activeRace, page, search });
              if (window.mistakeJourneyEnabled) {
                if (normalizedSearch === 'many') {
                  return Response.json({ items: ${JSON.stringify(paginatedItems)}.slice((page - 1) * 20, page * 20), page, total: 40, hasMore: page * 20 < 40 });
                }
                return Response.json({ items: [${JSON.stringify(mistakeJourneyItem)}], page: 1, total: 1, hasMore: false });
              }
              if (sessionUserId === 'mistake-user-b') {
                return Response.json({ items: [{ ...${JSON.stringify(items[0])}, bookWordId: 'account-b-word', word: 'B-only' }], page: 1, total: 1, hasMore: false });
              }
              if (new URL(location.href).searchParams.has('searchRace')) {
                if (search === 'slow') {
                  await new Promise(resolve => setTimeout(resolve, 700));
                  return Response.json({ items: [{ ...${JSON.stringify(items[0])}, bookWordId: 'slow-match', word: 'slow match' }], page: 1, total: 1, hasMore: false });
                }
                if (search === 'fast') return Response.json({ items: [{ ...${JSON.stringify(items[1])}, bookWordId: 'fast-match', word: 'fast match' }], page: 1, total: 1, hasMore: false });
              }
              if (new URL(location.href).searchParams.has('searchFixture')) {
                if (normalizedSearch === 'retry-me' && window.failMistakeSearchOnce) {
                  window.failMistakeSearchOnce = false;
                  return Response.json({ message: '模拟错题搜索失败' }, { status: 503 });
                }
                if (normalizedSearch === 'retry-me') return Response.json({ items: [{ ...${JSON.stringify(paginatedItems[34])}, bookWordId: 'page-word-35' }], page, total: 1, hasMore: false });
                if (normalizedSearch === 'empty') return Response.json({ items: [], page, total: 0, hasMore: false });
                if (normalizedSearch === 'pencil box' || normalizedSearch === '文具盒' || normalizedSearch === 'everyday stationery') return Response.json({ items: [{ ...${JSON.stringify(paginatedItems[34])}, bookWordId: 'page-word-35' }], page, total: 1, hasMore: false });
                if (normalizedSearch === 'many') return Response.json({ items: ${JSON.stringify(paginatedItems)}.slice((page - 1) * 20, page * 20), page, total: 40, hasMore: page * 20 < 40 });
                if (search) return Response.json({ items: [], page, total: 0, hasMore: false });
                return Response.json({ items: ${JSON.stringify(paginatedItems)}.slice((page - 1) * 20, page * 20), page, total: 40, hasMore: page * 20 < 40 });
              }
              if (normalizedSearch === 'retry-me') return Response.json({ items: [{ ...${JSON.stringify(paginatedItems[34])}, bookWordId: 'page-word-35' }], page, total: 1, hasMore: false });
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
              if (new URL(location.href).searchParams.has('pagination')) {
                return Response.json({ items: ${JSON.stringify(paginatedItems)}.slice((page - 1) * 20, page * 20), page, total: 40, hasMore: page * 20 < 40 });
              }
              if (questionType === 'OUTPUT') return Response.json({ items: [${JSON.stringify(items[1])}], page: 1, total: 1, hasMore: false });
              return Response.json({ items: ${JSON.stringify(items)}, page: 1, total: 3, hasMore: false });
            }
            if (path.includes('/api/v1/mistakes/') && method === 'GET') {
              const query = new URL(path, location.origin).searchParams;
              const signalId = new URL(path, location.origin).pathname.split('/').pop();
              const attemptCursor = query.get('attemptCursor');
              const attemptDirection = query.get('attemptDirection');
              const newerPage = attemptDirection === 'newer';
              const secondPage = Boolean(attemptCursor && !newerPage);
              window.mistakeDetailRequests.push({ signalId, attemptCursor, attemptDirection });
              const isOutput = signalId === 'output-signal';
              const isConfusion = signalId === 'confusion-signal';
              const isOther = signalId === 'legacy-other-signal';
              const attempts = isOutput
                ? [{ id: 'output-saved', isCorrect: false, selectedAnswer: 'a travel', createdAt: '2026-10-28T10:00:00.000Z', question: { prompt: 'Saved output prompt', correctAnswers: ['a journey'] } }]
                : !secondPage
                  ? Array.from({ length: 20 }, (_, index) => ({ id: 'saved-' + String(41 - index).padStart(2, '0'), isCorrect: index % 3 === 0, selectedAnswer: 'saved answer ' + index, createdAt: '2026-10-28T10:00:00.000Z', question: { prompt: 'Saved source question ' + index, options: ['A', 'B'], correctAnswers: ['A'], explanation: 'Saved explanation' } }))
                  : [{ id: 'saved-old-without-question', isCorrect: false, selectedAnswer: null, createdAt: '2026-10-20T10:00:00.000Z', question: null }, { id: 'saved-correct-without-question', isCorrect: true, selectedAnswer: 'saved correct answer without a snapshot', createdAt: '2026-10-19T10:30:00.000Z', question: null }, { id: 'saved-old-with-snapshot', isCorrect: true, selectedAnswer: 'B', createdAt: '2026-10-19T10:00:00.000Z', question: { prompt: 'Older saved source question', correctAnswers: ['B'] } }];
              const body = isOutput
                ? { ...${JSON.stringify(weaknesses('output-signal', 'OUTPUT', 1))}, bookWordId: 'output-word', word: 'journey', part: 'n.', meaning: '旅程', bookTitle: 'Test book', attempts, attemptPageSize: 20, attemptHasOlder: false, attemptHasNewer: false, olderAttemptCursor: null, newerAttemptCursor: null }
                : isConfusion
                  ? { ...${JSON.stringify(weaknesses('confusion-signal', 'CONFUSION'))}, bookWordId: 'confusion-word', word: 'borrow', part: 'v.', meaning: '借入', bookTitle: 'Test book', attempts: [attempts[0]], attemptPageSize: 20, attemptHasOlder: false, attemptHasNewer: false, olderAttemptCursor: null, newerAttemptCursor: null }
                  : isOther
                    ? { ...${JSON.stringify(weaknesses('legacy-other-signal', 'OTHER', 1))}, bookWordId: 'standard-word', word: 'careful', part: 'adj.', meaning: '仔细的', bookTitle: 'Test book', attempts: [], attemptPageSize: 20, attemptHasOlder: false, attemptHasNewer: false, olderAttemptCursor: null, newerAttemptCursor: null }
                    : { ...${JSON.stringify(weaknesses('standard-signal', 'READING_COMPREHENSION', 14))}, bookWordId: 'standard-word', word: 'careful', part: 'adj.', meaning: '仔细的', bookTitle: 'Test book', attempts, attemptPageSize: 20, attemptHasOlder: !secondPage, attemptHasNewer: secondPage, olderAttemptCursor: !secondPage ? 'older-cursor' : null, newerAttemptCursor: secondPage ? 'newer-cursor' : null };
              if (secondPage && window.failOlderCursorOnce) {
                window.failOlderCursorOnce = false;
                return Response.json({ message: '模拟关联作答分页失败' }, { status: 503 });
              }
              if (window.deferNextMistakeDetail) {
                window.deferNextMistakeDetail = false;
                return new Promise(resolve => { window.releaseDeferredMistakeDetail = () => resolve(Response.json(body)); });
              }
              return Response.json(body);
            }
            if (path.includes('/api/v1/ai/tutor/history')) return Response.json({ messages: [], remaining: 30, limit: 30, hasMore: false });
            if (path.endsWith('/api/v1/mistakes/practice-plans') && method === 'POST') {
              const selection = JSON.parse(options.body);
              window.mistakePlanWrites.push(selection);
              if (window.mistakeJourneyEnabled) {
                window.mistakeJourneySelections.push(selection);
                return Response.json(window.mistakeJourneyPlan);
              }
              const message = selection.bookWordIds.includes('current-standard')
                ? '已有薄弱项专项包含其他选择，本次选择未应用。请先处理现有专项，再重新选择。'
                : 'Fixture stopped before model generation';
              return Response.json({ message }, { status: 409 });
            }
            if (path.endsWith('/api/v1/study/plans/mistake-practice-journey/groups/0/complete') && method === 'POST') {
              window.mistakeJourneyCompletionWrites.push(JSON.parse(options.body));
              window.mistakeJourneyPlan = {
                ...window.mistakeJourneyPlan,
                status: 'COMPLETED',
                completed: 1,
                completedAt: '2026-11-02T10:01:00.000Z',
                words: window.mistakeJourneyPlan.words.map((word) => ({ ...word, completed: true, result: true })),
                summary: { totalQuestions: 1, correctQuestions: 1, durationSeconds: 12, typeStats: [{ type: 'READING_COMPREHENSION', total: 1, correct: 1 }] },
              };
              return Response.json(window.mistakeJourneyPlan);
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'GET') {
              return Response.json(window.mistakeJourneyEnabled ? [window.mistakeJourneyPlan] : []);
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
      assert.match(
        await evaluate('document.querySelector(".mistakes-order-note").textContent'),
        /较低的连对次数.*累计错答次数和最近错答时间/,
      );
      assert.equal(await evaluate('document.querySelector(".mistake-score")'), null);
      assert.match(
        await evaluate('document.querySelector(".mistake-signals button").textContent'),
        /累计错答 14 次 · 连对 0\/2/,
      );
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

      await selectQuestionType('OUTPUT', '每日输出');
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
      await selectQuestionType('OUTPUT', '每日输出');
      await until(
        'window.mistakeListRequests.some((item) => item.activeRace && item.questionType === "OUTPUT")',
      );
      assert.equal(await evaluate('document.querySelector(".mistakes-list")'), null);
      assert.equal(await evaluate('document.querySelector(".mistakes-create").disabled'), true);
      await selectQuestionType('WORD_MATCHING', '单词匹配');
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
        await evaluate('document.querySelector(".mistake-detail > header span").textContent'),
        /此题型累计错答 14 次 · 连对 0\/2/,
      );
      assert.equal(
        await evaluate('document.querySelector(".mistake-current-meaning-label").textContent'),
        '当前词库释义',
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-current-meaning-note").textContent'),
        /可能已更新.*作答时保存的快照/,
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-attempt-heading").textContent'),
        /当前题型.*最新记录在前.*时间按设备时区显示/,
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-learning-direction").textContent'),
        /这类题练什么.*按原题题干.*可从哪里再练.*同题型变式/s,
      );
      assert.match(
        await evaluate(
          'document.querySelector(".mistake-learning-direction").getAttribute("aria-label")',
        ),
        /阅读理解练习方向/,
      );
      assert.match(
        await evaluate('document.querySelectorAll(".mistake-attempt")[0].textContent'),
        /回答正确/,
      );
      assert.match(
        await evaluate('document.querySelectorAll(".mistake-attempt")[1].textContent'),
        /回答错误/,
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-attempt").textContent'),
        /Saved source question 0/,
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[0])')),
        {
          signalId: 'standard-signal',
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
      const directionDesktopBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const card = document.querySelector(".mistake-learning-direction").getBoundingClientRect(); const detail = document.querySelector(".mistake-detail").getBoundingClientRect(); return { left:card.left, right:card.right, detailLeft:detail.left, detailRight:detail.right, scrollWidth:document.documentElement.scrollWidth, viewport:innerWidth }; })())',
        ),
      );
      assert.ok(directionDesktopBounds.left >= directionDesktopBounds.detailLeft);
      assert.ok(directionDesktopBounds.right <= directionDesktopBounds.detailRight);
      assert.ok(directionDesktopBounds.scrollWidth <= directionDesktopBounds.viewport);
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await evaluate(`(() => {
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function(options) {
          window.lastMistakeHistoryScroll = options;
          return original.call(this, options);
        };
        document.querySelector('.mistake-learning-direction-actions button').click();
      })()`);
      assert.equal(
        await evaluate('document.activeElement?.id'),
        'mistake-attempt-history',
        'the direction action should move keyboard focus to saved attempts',
      );
      assert.equal(
        await evaluate('window.lastMistakeHistoryScroll?.behavior'),
        'auto',
        'the history jump should respect reduced-motion preference',
      );
      assert.equal(await evaluate('window.mistakeDetailRequests.length'), 1);
      assert.equal(await evaluate('window.mistakePlanWrites.length'), 0);
      await send('Emulation.setEmulatedMedia', { features: [] });
      await evaluate(
        '[...document.querySelectorAll(".mistake-attempt-pagination button")].find((button) => button.textContent.includes("更早")).click()',
      );
      await until('window.mistakeDetailRequests.length === 2');
      await until('document.querySelector(".mistake-detail-message[role=alert]")');
      assert.equal(
        await evaluate('document.querySelectorAll(".mistake-attempt").length'),
        20,
        'a failed page load should retain the current history page',
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-attempt-pagination span").textContent'),
        /第 1 页/,
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[1])')),
        {
          signalId: 'standard-signal',
          attemptCursor: 'older-cursor',
          attemptDirection: 'older',
        },
      );
      await evaluate(
        '[...document.querySelectorAll(".mistake-attempt-pagination button")].find((button) => button.textContent.includes("更早")).click()',
      );
      await until('window.mistakeDetailRequests.length === 3');
      await until(
        'document.querySelector(".mistake-attempt-pagination span")?.textContent.includes("第 2 页")',
      );
      await until('document.querySelectorAll(".mistake-attempt").length === 3');
      assert.match(
        await evaluate('document.querySelectorAll(".mistake-attempt")[0].textContent'),
        /题目内容不可用/,
      );
      assert.match(
        await evaluate('document.querySelectorAll(".mistake-attempt")[0].textContent'),
        /未记录/,
      );
      assert.match(
        await evaluate('document.querySelectorAll(".mistake-attempt")[0].textContent'),
        /回答错误/,
      );
      assert.match(
        await evaluate('document.querySelectorAll(".mistake-attempt")[1].textContent'),
        /回答正确.*题目内容不可用.*saved correct answer without a snapshot/s,
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[2])')),
        {
          signalId: 'standard-signal',
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
        JSON.parse(await evaluate('JSON.stringify(window.mistakeDetailRequests[3])')),
        {
          signalId: 'standard-signal',
          attemptCursor: 'newer-cursor',
          attemptDirection: 'newer',
        },
      );
      assert.equal(await evaluate('window.mistakePlanWrites.length'), 0);

      await evaluate('window.deferNextMistakeDetail = true');
      await evaluate(
        '[...document.querySelectorAll(".mistake-attempt-pagination button")].find((button) => button.textContent.includes("更早")).click()',
      );
      await until('typeof window.releaseDeferredMistakeDetail === "function"');
      await evaluate(
        'document.querySelector(".mistake-detail header button[aria-label=关闭]").click()',
      );
      await until('!document.querySelector(".mistake-detail-layer[role=dialog]")');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("每日输出")).click()',
      );
      await until(
        'document.querySelector(".mistake-detail-layer[role=dialog]")?.textContent.includes("journey")',
      );
      await evaluate('window.releaseDeferredMistakeDetail()');
      await delay(100);
      assert.match(
        await evaluate('document.querySelector(".mistake-detail-layer[role=dialog]").textContent'),
        /journey/,
      );
      assert.doesNotMatch(
        await evaluate('document.querySelector(".mistake-detail-layer[role=dialog]").textContent'),
        /Older saved source question/,
      );
      assert.match(
        await evaluate('document.querySelector(".mistake-learning-direction").textContent'),
        /每日输出.*不会自动带入/,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".mistake-learning-direction-actions button:last-child").textContent.trim()',
        ),
        '打开每日输出',
      );
      await evaluate(
        'document.querySelector(".mistake-learning-direction-actions button:last-child").click()',
      );
      await until(
        'location.pathname === "/dashboard/practice" && new URL(location.href).searchParams.get("tab") === "output"',
      );
      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("易混词辨析")).click()',
      );
      await until('document.querySelector(".mistake-detail-layer[role=dialog]")');
      await until('document.querySelector(".mistake-learning-direction")');
      assert.match(
        await evaluate('document.querySelector(".mistake-learning-direction").textContent'),
        /易混词.*不会自动带入/,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".mistake-learning-direction-actions button:last-child").textContent.trim()',
        ),
        '打开易混词训练',
      );
      await evaluate(
        'document.querySelector(".mistake-learning-direction-actions button:last-child").click()',
      );
      await until(
        'location.pathname === "/dashboard/practice" && new URL(location.href).searchParams.get("tab") === "confusion"',
      );
      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("OTHER")).click()',
      );
      await until('document.querySelector(".mistake-detail-layer[role=dialog]")');
      await until('document.querySelector(".mistake-attempt-empty")');
      assert.equal(
        await evaluate('document.querySelector(".mistake-learning-direction")'),
        null,
        'an unknown legacy type must not receive an inferred learning direction',
      );
      await evaluate(
        'document.querySelector(".mistake-detail header button[aria-label=关闭]").click()',
      );
      await until('!document.querySelector(".mistake-detail-layer[role=dialog]")');

      await evaluate('window.deferNextMistakeDetail = true');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("阅读理解")).click()',
      );
      await until('typeof window.releaseDeferredMistakeDetail === "function"');
      await selectQuestionType('OUTPUT', '每日输出');
      await until('document.querySelector(".mistakes-list")?.textContent.includes("journey")');
      await evaluate('window.releaseDeferredMistakeDetail()');
      await delay(100);
      assert.equal(
        await evaluate('document.querySelector(".mistake-detail-layer[role=dialog]")'),
        null,
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-list").textContent'),
        /journey/,
      );

      await selectQuestionType('', '全部题型');
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("阅读理解")).click()',
      );
      await until('document.querySelector(".mistake-detail-layer[role=dialog]")');
      await until('document.querySelectorAll(".mistake-attempt").length === 20');
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
      const directionMobileBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const card = document.querySelector(".mistake-learning-direction").getBoundingClientRect(); const detail = document.querySelector(".mistake-detail").getBoundingClientRect(); return { left:card.left, right:card.right, detailLeft:detail.left, detailRight:detail.right, scrollWidth:document.documentElement.scrollWidth, viewport:innerWidth }; })())',
        ),
      );
      assert.ok(directionMobileBounds.left >= directionMobileBounds.detailLeft);
      assert.ok(directionMobileBounds.right <= directionMobileBounds.detailRight);
      assert.ok(directionMobileBounds.scrollWidth <= directionMobileBounds.viewport);
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

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      await evaluate('document.querySelector(".sidebar-scrim")?.click()');
      await until('!document.querySelector(".sidebar-scrim")');
      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes&pagination=1', baseUrl).href,
      });
      await until('document.querySelectorAll(".mistakes-list > article").length === 20');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-selection-note").getBoundingClientRect().right <= innerWidth',
        ),
        true,
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（10）/,
      );
      await clickVisible('button[aria-label="选择 page-word-11"]');
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（11）/,
      );
      await clickVisible('.mistakes-pagination button:last-child');
      await until(
        'document.querySelectorAll(".mistakes-list > article").length === 20 && document.querySelector(".mistakes-pagination span")?.textContent.includes("第 2 页")',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（11）/,
      );
      for (let word = 21; word <= 29; word++) {
        await clickVisible(`button[aria-label="选择 page-word-${word}"]`);
      }
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（20）/,
      );
      await clickVisible('button[aria-label="选择 page-word-30"]');
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（20）/,
      );
      await clickVisible('.mistakes-pagination button:first-child');
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 1 页")',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（20）/,
      );
      await clickVisible('.mistakes-pagination button:last-child');
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 2 页")',
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistake-check")].find((button) => button.getAttribute("aria-label") === "取消选择 page-word-21") !== undefined',
        ),
        true,
        'selected words from both pages should remain checked when returning to the page',
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistake-check")].find((button) => button.getAttribute("aria-label") === "选择 page-word-30") !== undefined',
        ),
        true,
        'the 20-word cap should prevent selecting an additional word',
      );
      await clickVisible('.mistakes-create');
      await until('window.mistakePlanWrites.length === 1');
      assert.deepEqual(
        await evaluate('window.mistakePlanWrites[0].bookWordIds'),
        [
          ...Array.from({ length: 10 }, (_, index) => `page-word-${index + 1}`),
          'page-word-11',
          ...Array.from({ length: 9 }, (_, index) => `page-word-${index + 21}`),
        ],
        'the practice request should include selected words from both pages exactly once',
      );
      await selectQuestionType('WORD_MATCHING', '单词匹配');
      await until(
        'document.querySelectorAll(".mistakes-list > article").length === 20 && document.querySelector(".mistakes-pagination span")?.textContent.includes("第 1 页")',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（10）/,
        'changing the question-type filter should start a new selection scope',
      );
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);

      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes&searchFixture=1', baseUrl).href,
      });
      await until('document.querySelectorAll(".mistakes-list > article").length === 20');
      await fillSearchInput('many');
      const requestsBeforeKeyboardSubmit = await evaluate('window.mistakeListRequests.length');
      await pressEnter();
      await delay(100);
      assert.equal(
        await evaluate('window.mistakeListRequests.length'),
        requestsBeforeKeyboardSubmit + 1,
        'pressing Enter in the search input should submit the search form',
      );
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 1 页") && document.querySelector(".mistakes-search-summary")?.textContent.includes("40 个词")',
      );
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await clickVisible('.mistakes-pagination button:last-child');
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 2 页")',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（10）/,
      );
      await clickVisible('button[aria-label="选择 page-word-21"]');
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（11）/,
      );
      await clickVisible('.mistakes-pagination button:first-child');
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 1 页")',
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistake-check")].some(button => button.getAttribute("aria-label") === "取消选择 page-word-1")',
        ),
        true,
        'a search-scoped selection remains selected when paging within the same query',
      );
      await clickVisible('.mistakes-pagination button:last-child');
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 2 页")',
      );

      await fillSearchInput('  PENCIL   BOX  ');
      await pressEnter();
      await until(
        'document.querySelector(".mistakes-list")?.textContent.includes("pencil box") && document.querySelector(".mistakes-pagination") === null',
      );
      assert.equal(
        await evaluate('document.querySelector("#mistakes-search-input")?.value'),
        'PENCIL BOX',
      );
      assert.equal(await evaluate('document.querySelector(".mistakes-pagination span")'), null);
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（1）/,
      );
      assert.equal(
        await evaluate('window.mistakeListRequests.at(-1)?.search'),
        'PENCIL BOX',
        'the search should be normalized before the server-side request',
      );
      const narrowSearchBounds = JSON.parse(
        await evaluate(`JSON.stringify((() => {
        const form = document.querySelector('.mistakes-search').getBoundingClientRect();
        const input = document.querySelector('#mistakes-search-input').getBoundingClientRect();
        return { formLeft: form.left, formRight: form.right, inputRight: input.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
      })())`),
      );
      assert.ok(
        narrowSearchBounds.formLeft >= 0 &&
          narrowSearchBounds.formRight <= narrowSearchBounds.viewport,
      );
      assert.ok(narrowSearchBounds.inputRight <= narrowSearchBounds.formRight);
      assert.ok(narrowSearchBounds.scrollWidth <= narrowSearchBounds.viewport);

      await fillSearchInput('文具盒');
      await clickVisible('.mistakes-search button[type="submit"]');
      await until(
        'window.mistakeListRequests.at(-1)?.search === "文具盒" && document.querySelector(".mistakes-list")?.textContent.includes("pencil box")',
      );
      await fillSearchInput('everyday stationery');
      await clickVisible('.mistakes-search button[type="submit"]');
      await until(
        'window.mistakeListRequests.at(-1)?.search === "everyday stationery" && document.querySelector(".mistakes-list")?.textContent.includes("pencil box")',
      );
      await selectQuestionType('READING_COMPREHENSION', '阅读理解');
      await until(
        'window.mistakeListRequests.at(-1)?.search === "everyday stationery" && window.mistakeListRequests.at(-1)?.questionType === "READING_COMPREHENSION" && document.querySelector(".mistakes-list")?.textContent.includes("pencil box")',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（1）/,
      );
      await evaluate('document.querySelector(".mistakes-search-clear")?.click()');
      await until(
        'document.querySelector("#mistakes-search-input")?.value === "" && document.querySelector(".mistakes-pagination span")?.textContent.includes("第 1 页") && document.querySelectorAll(".mistakes-list > article").length === 20',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（10）/,
      );

      await fillSearchInput('empty');
      await clickVisible('.mistakes-search button[type="submit"]');
      await until('document.querySelector(".mistakes-empty")?.textContent.includes("没有找到与")');
      assert.ok(
        await evaluate(
          'document.querySelector(".mistakes-empty button")?.textContent.includes("清空搜索")',
        ),
      );
      await fillSearchInput('retry-me');
      await clickVisible('.mistakes-search button[type="submit"]');
      await until(
        'document.querySelector(".mistakes-empty[role=alert]")?.textContent.includes("模拟错题搜索失败")',
      );
      await clickVisible('.mistakes-empty[role=alert] button');
      await until('document.querySelector(".mistakes-list")?.textContent.includes("pencil box")');

      await clickVisible('.mistake-check[aria-label="取消选择 pencil box"]');
      await until(
        'document.querySelector(".mistakes-create")?.textContent.includes("生成专项（0）")',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav button")].find((button) => button.textContent.includes("词环")).click()',
      );
      await until(
        '!document.querySelector(".mistakes-page") && document.querySelector(".study-content")',
      );
      await evaluate(
        '[...document.querySelectorAll(".sidebar-nav .nav-children button")].find((button) => button.textContent.includes("待巩固")).click()',
      );
      await until(
        'document.querySelector("#mistakes-search-input")?.value === "retry-me" && document.querySelector(".mistakes-list")?.textContent.includes("pencil box")',
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeListRequests.at(-1))')),
        {
          status: 'active',
          questionType: 'READING_COMPREHENSION',
          activeRace: false,
          page: 1,
          search: 'retry-me',
        },
        'leaving and returning should restore the applied status, type and search filters',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（1）/,
        'the remounted list should use its normal fresh selection defaults',
      );
      await evaluate(`(() => {
        const frame = document.createElement('iframe');
        frame.hidden = true;
        document.body.append(frame);
        const nextSession = { accessToken: 'fixture-b', user: { id: 'mistake-user-b', email: 'b@example.invalid', displayName: '学习者 B', role: 'USER' } };
        frame.contentWindow.localStorage.setItem('lexloop.session', JSON.stringify(nextSession));
      })()`);
      await until('document.querySelector(".mistakes-list")?.textContent.includes("B-only")');
      assert.equal(
        await evaluate('document.querySelector("#mistakes-search-input")?.value'),
        '',
        'a different account must not inherit the previous learner’s mistake search',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-toolbar [role=tab][aria-selected=true]")?.textContent.trim()',
        ),
        '待巩固',
        'a different account must start with its default mistake status',
      );
      await evaluate(
        `localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'mistake-user', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }))`,
      );

      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes&searchRace=1', baseUrl).href,
      });
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');
      const submitRaceSearch = async (value) => {
        await fillSearchInput(value);
        await clickVisible('.mistakes-search button[type="submit"]');
      };
      await submitRaceSearch('slow');
      await until('window.mistakeListRequests.at(-1)?.search === "slow"');
      await submitRaceSearch('fast');
      await until(
        'window.mistakeListRequests.at(-1)?.search === "fast" && document.querySelector(".mistakes-list")?.textContent.includes("fast match")',
      );
      await delay(850);
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-list")?.textContent.includes("slow match")',
        ),
        false,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".mistakes-list")?.textContent.includes("fast match")',
        ),
        true,
      );
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelectorAll(".mistakes-list > article").length === 3');

      await evaluate('window.deferNextMistakeDetail = true');
      await evaluate(
        '[...document.querySelectorAll(".mistake-signals button")].find((button) => button.textContent.includes("每日输出")).click()',
      );
      await until('typeof window.releaseDeferredMistakeDetail === "function"');
      const previousSession = JSON.parse(await evaluate('localStorage.getItem("lexloop.session")'));
      await evaluate(`(() => {
        const frame = document.createElement('iframe');
        frame.hidden = true;
        document.body.append(frame);
        const nextSession = { accessToken: 'fixture-b', user: { id: 'mistake-user-b', email: 'b@example.invalid', displayName: '学习者 B', role: 'USER' } };
        frame.contentWindow.localStorage.setItem('lexloop.session', JSON.stringify(nextSession));
      })()`);
      await until('document.querySelector(".mistakes-list")?.textContent.includes("B-only")');
      assert.equal(
        await evaluate('localStorage.getItem("fixture.pending-mistake-detail-unloaded")'),
        'yes',
        'account navigation should discard the pending detail request with the old page context',
      );
      assert.equal(
        await evaluate('document.querySelector(".mistake-detail-layer[role=dialog]")'),
        null,
      );
      assert.doesNotMatch(
        await evaluate('document.querySelector(".mistakes-page").textContent'),
        /Saved source question/,
      );
      assert.equal(previousSession.user.id, 'mistake-user');

      await evaluate(
        `localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'mistake-user', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }))`,
      );
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'window.mistakeJourneyEnabled = true;',
      });
      await send('Page.navigate', {
        url: new URL('/dashboard?view=mistakes', baseUrl).href,
      });
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 1');
      await selectQuestionType('READING_COMPREHENSION', '阅读理解');
      await fillSearchInput('many');
      await clickVisible('.mistakes-search button[type="submit"]');
      await until(
        'document.querySelector(".mistakes-search-summary")?.textContent.includes("40 个词")',
      );
      await clickVisible('.mistakes-pagination button:last-child');
      await until(
        'document.querySelector(".mistakes-pagination span")?.textContent.includes("第 2 页")',
      );
      await clickVisible('button[aria-label="选择 pencil box"]');
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（11）/,
      );
      assert.ok(
        await evaluate(
          '[...document.querySelectorAll(".mistakes-list article")].some((card) => card.textContent.includes("pencil box") && card.classList.contains("is-selected"))',
        ),
        'the page-two selection should be kept while selecting from the complete cross-page result set',
      );

      await fillSearchInput('pencil box');
      await clickVisible('.mistakes-search button[type="submit"]');
      await until(
        'document.querySelector(".mistakes-search-summary")?.textContent.includes("1 个词")',
      );
      await until(
        'document.querySelector(".mistakes-create")?.textContent.includes("生成专项（1）")',
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistakes-toolbar button")].find((button) => button.getAttribute("aria-label") === "按题型筛选")?.textContent.trim()',
        ),
        '阅读理解',
      );
      await clickVisible('.mistakes-create');
      await until('window.mistakeJourneySelections.length === 1');
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeJourneySelections[0])')),
        { bookWordIds: ['journey-word'] },
      );
      await until(
        'document.querySelector(".plan-preview-layer")?.textContent.includes("薄弱词专项生成完毕")',
      );
      await clickVisible('.plan-preview .start-challenge');
      await until('document.querySelector(".lesson-page .generated-question")');
      await clickVisible('.lesson-page .generated-question .answer-options button');
      await until(
        'document.querySelector(".lesson-page .question-answer")?.textContent.includes("答案已记录")',
      );
      await clickVisible('.lesson-draft-actions .check-matches');
      await until('window.mistakeJourneyCompletionWrites.length === 1');
      const completedAnswers = JSON.parse(
        await evaluate('JSON.stringify(window.mistakeJourneyCompletionWrites[0].answers)'),
      );
      assert.equal(completedAnswers.length, 1);
      assert.equal(completedAnswers[0].bookWordId, 'journey-word');
      assert.deepEqual(completedAnswers[0].selectedAnswer, ['Her pencils']);
      assert.ok(Number.isFinite(completedAnswers[0].responseTimeMs));
      assert.ok(completedAnswers[0].responseTimeMs >= 0);
      await until(
        'document.querySelector(".lesson-draft-actions .check-matches")?.textContent.includes("查看今日总结")',
      );
      await clickVisible('.lesson-draft-actions .check-matches');
      await until('document.querySelector("#settlement-title")');
      await clickVisible('.settlement-mistakes-link');
      await until('document.querySelector("#mistakes-title")');
      await until('document.querySelectorAll(".mistakes-list > article").length === 1');
      assert.equal(
        await evaluate('document.querySelector("#mistakes-search-input").value'),
        'pencil box',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-search-summary").textContent'),
        /pencil box.*1 个词/,
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".mistakes-toolbar button")].find((button) => button.getAttribute("aria-label") === "按题型筛选")?.textContent.trim()',
        ),
        '阅读理解',
      );
      assert.match(
        await evaluate('document.querySelector(".mistakes-create").textContent'),
        /生成专项（1）/,
      );
      assert.deepEqual(
        JSON.parse(await evaluate('JSON.stringify(window.mistakeListRequests.at(-1))')),
        {
          status: 'active',
          questionType: 'READING_COMPREHENSION',
          activeRace: false,
          page: 1,
          search: 'pencil box',
        },
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
