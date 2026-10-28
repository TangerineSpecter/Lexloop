import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'daily study holds back answer feedback until the server accepts the group',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-study-feedback-test-'));
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
    const browserErrors = [];
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
            // A navigation can briefly replace the page's JavaScript context.
          }
          await delay(100);
        }
        const pageState = await evaluate(
          `({ path: location.pathname, text: document.body.innerText.slice(-900),
            hasFixtureSession: Boolean(localStorage.getItem('lexloop.session')),
            fixtureUser: JSON.parse(localStorage.getItem('lexloop.session') ?? 'null')?.user?.id ?? null,
            speechMock: typeof window.studySpeech,
            planReads: window.studyPlansReadCount ?? null })`,
        ).catch(() => null);
        assert.fail(
          `Timed out waiting for ${expression}; state=${JSON.stringify({ pageState, browserErrors })}`,
        );
      };
      const openCurrentPlan = async () => {
        await until('document.querySelector("[role=tab]")');
        await evaluate(
          '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("当前学习序列")).click()',
        );
        await until(
          '[...document.querySelectorAll("button")].some((button) => button.textContent.includes("继续学习"))',
        );
        await evaluate(
          '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("继续学习")).click()',
        );
        await until('document.querySelector(".answer-options button")');
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
          window.studySpeech = {
            voices: [
              { lang: 'zh-CN', name: 'Fixture Chinese' },
              { lang: 'en-US', name: 'Fixture English' },
            ],
            cancelCount: 0,
            spoken: [],
            queue: [],
            active: null,
          };
          window.StudyUtteranceFixture = class {
            constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; }
          };
          Object.defineProperty(window, 'SpeechSynthesisUtterance', {
            configurable: true,
            writable: true,
            value: window.StudyUtteranceFixture,
          });
          Object.defineProperty(window, 'speechSynthesis', {
            configurable: true,
            value: {
              getVoices: () => window.studySpeech.voices,
              cancel: () => {
                window.studySpeech.cancelCount += 1;
                window.studySpeech.queue = [];
                window.studySpeech.active = null;
              },
              speak: utterance => {
                window.studySpeech.active = utterance;
                window.studySpeech.queue.push(utterance);
                window.studySpeech.spoken.push({ text: utterance.text, lang: utterance.lang, voice: utterance.voice?.lang });
              },
            },
          });
          const questionBeforeSubmit = {
            bookWordId: 'word-1', type: 'MEANING_RECOGNITION', prompt: 'Choose the meaning of bright.',
            options: ['暗的', '明亮的'],
          };
          const questionAfterSubmit = {
            ...questionBeforeSubmit, correctAnswers: ['明亮的'], explanation: 'bright 描述光线充足或颜色鲜明。',
          };
          const matchingPairs = [
            { left: 'help people', right: '服务大众', tip: '强调服务对象。' },
            { left: 'help oneself', right: '自助', tip: '强调行动由谁完成。' },
            { left: 'help to improve', right: '促进改善', tip: '强调结果变好。' },
            { left: "can't help doing", right: '情不自禁', tip: '强调难以克制。' },
          ];
          const matchingBeforeSubmit = {
            bookWordId: 'word-2', type: 'WORD_MATCHING', prompt: 'Match each phrase with its meaning.', options: [],
            pairs: matchingPairs.map((pair, index) => ({ ...pair, right: matchingPairs[(index + 1) % 4].right, tip: matchingPairs[(index + 1) % 4].tip })),
          };
          const matchingAfterSubmit = {
            ...matchingBeforeSubmit, pairs: matchingPairs, correctAnswers: [], explanation: '比较每个短语在真实语境中的功能。',
          };
          window.matchingOriginalPairs = matchingPairs;
          const makePlan = (completedGroups) => {
            const firstSubmitted = completedGroups >= 1;
            const secondSubmitted = completedGroups >= 2;
            const nextReviewAt = [
              new Date(Date.now() - 2 * 86_400_000).toISOString(),
              new Date(Date.now() + 6 * 86_400_000).toISOString(),
            ];
            return {
              id: 'plan-1', mode: 'group', purpose: 'normal', status: secondSubmitted ? 'COMPLETED' : 'ACTIVE',
              wordCount: 2, groupCount: 2, completed: completedGroups, createdAt: '2026-10-27T00:00:00.000Z',
              words: [
                { id: 'word-1', word: 'bright', part: 'adj.', meaning: '明亮的', source: 'REVIEW', groupIndex: 0,
                  question: firstSubmitted ? questionAfterSubmit : questionBeforeSubmit, completed: firstSubmitted, result: firstSubmitted ? false : undefined,
                  ...(firstSubmitted ? { savedContext: { scenario: '微故事 · 上班路上 · 第 1 段', example: 'Maya missed the bus, so she called a taxi.' } } : {}),
                  nextReviewAt: firstSubmitted ? nextReviewAt[0] : null,
                  activeWeaknesses: firstSubmitted ? [{ questionType: 'MEANING_RECOGNITION', wrongCount: 1, consecutiveCorrect: 0, remainingCorrect: 2 }] : [] },
                { id: 'word-2', word: 'help', part: 'vt.', meaning: '帮助', source: 'NEW', groupIndex: 1,
                  question: secondSubmitted ? matchingAfterSubmit : matchingBeforeSubmit, completed: secondSubmitted, result: secondSubmitted ? false : undefined,
                  nextReviewAt: secondSubmitted ? nextReviewAt[1] : null,
                  activeWeaknesses: secondSubmitted ? [
                    { questionType: 'MEANING_RECOGNITION', wrongCount: 2, consecutiveCorrect: 1, remainingCorrect: 1 },
                    { questionType: 'WORD_MATCHING', wrongCount: 1, consecutiveCorrect: 0, remainingCorrect: 2 },
                  ] : [] },
              ],
              content: { groups: [
                { index: 0, title: 'A bright morning', wordOccurrences: { bright: 1 },
                  sentences: [{ english: 'Bright rooms are bright; brightness matters when rooms are brightly lit.', chinese: '明亮的房间里，明亮程度很重要。', simplified: '房间越明亮，越让人在意光线。', grammar: 'bright 修饰 rooms；brightness 是名词，brightly 是副词。' }],
                  questions: [firstSubmitted ? questionAfterSubmit : questionBeforeSubmit] },
                { index: 1, title: 'A helping hand', wordOccurrences: { help: 1 },
                  sentences: [{ english: 'They help people learn.', chinese: '他们帮助人们学习。', simplified: '他们帮助人们学习。', grammar: 'help 作谓语动词。' }],
                  questions: [secondSubmitted ? matchingAfterSubmit : matchingBeforeSubmit] },
              ] },
              summary: { totalQuestions: completedGroups, correctQuestions: 0, durationSeconds: 4,
                typeStats: [
                  ...(firstSubmitted ? [{ type: 'MEANING_RECOGNITION', total: 1, correct: 0 }] : []),
                  ...(secondSubmitted ? [{ type: 'WORD_MATCHING', total: 1, correct: 0 }] : []),
                ] },
            };
          };
          window.studyPlanResponse = makePlan(0);
          window.planCreateResponse = {
            ...makePlan(0),
            id: 'plan-book-b',
            wordCount: 2,
            words: [
              { id: 'book-b-word-1', word: 'adapt', part: 'vt.', meaning: '适应', source: 'NEW', groupIndex: 0, completed: false, nextReviewAt: null, activeWeaknesses: [] },
              { id: 'book-b-word-2', word: 'consider', part: 'vt.', meaning: '考虑', source: 'NEW', groupIndex: 0, completed: false, nextReviewAt: null, activeWeaknesses: [] },
            ],
          };
          window.defaultBook = { id: 'book-a', title: 'Book A', totalWords: 10 };
          window.learningBooks = [
            { id: 'book-a', title: 'Book A', totalWords: 10, learnedWords: 0, isLearning: true, isDefault: true, categoryLabel: '通用' },
            { id: 'book-b', title: 'Book B', totalWords: 20, learnedWords: 0, isLearning: true, isDefault: false, categoryLabel: '通用' },
          ];
          window.dashboardWordReads = [];
          window.dashboardWordResolvers = [];
          window.delayNextDashboardWords = false;
          window.failBookBWordReads = 1;
          window.resolveDashboardWordRead = (bookId, response) => {
            const index = window.dashboardWordResolvers.findIndex((item) => item.bookId === bookId);
            if (index < 0) throw new Error('No pending word-list request for ' + bookId);
            window.dashboardWordResolvers.splice(index, 1)[0].resolve(response);
          };
          window.studyPlansReadCount = 0;
          window.failStudyPlansReads = localStorage.getItem('lexloop.test.plan-read-failed') ? 0 : 1;
          window.studyPlanCreateAttempts = [];
          window.studyPlanCreateResolvers = [];
          window.studyPlanCreations = [];
          window.saveNextStudyPlanCreateBeforeLostResponse = false;
          window.resolveStudyPlanCreate = (response) => {
            const resolve = window.studyPlanCreateResolvers.shift();
            if (!resolve) throw new Error('No pending plan creation request');
            resolve(response);
          };
          window.studyPlanWrites = [];
          window.studySubmissionAttempts = [];
          window.studyAlerts = [];
          window.mistakeRequests = [];
          window.apiFetchLog = [];
          window.alert = (message) => window.studyAlerts.push(String(message));
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'study-user', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            window.apiFetchLog.push({ path, method });
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: JSON.parse(localStorage.getItem('lexloop.session')).user.id });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(window.defaultBook);
            if (path.endsWith('/api/v1/vocabulary/learning')) return Response.json(window.learningBooks);
            if (path.endsWith('/api/v1/vocabulary/system')) return Response.json({ categories: [], books: [] });
            const bookActivation = path.split('/api/v1/vocabulary/books/')[1]?.split('/');
            if (bookActivation?.length === 2 && ['start', 'continue'].includes(bookActivation[1]) && method === 'POST') {
              window.defaultBook = bookActivation[0] === 'book-b'
                ? { id: 'book-b', title: 'Book B', totalWords: 20 }
                : { id: 'book-a', title: 'Book A', totalWords: 10 };
              return Response.json(window.defaultBook);
            }
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 1, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) {
              const bookId = window.defaultBook?.id ?? null;
              const newWordCount = new URL(path, location.href).searchParams.get('newWordCount');
              window.dashboardWordReads.push({ bookId, newWordCount });
              if (window.delayNextDashboardWords) {
                window.delayNextDashboardWords = false;
                return new Promise((resolve) => window.dashboardWordResolvers.push({ bookId, resolve }));
              }
              if (bookId === 'book-b' && window.failBookBWordReads > 0) {
                window.failBookBWordReads--;
                return Response.json({ message: '切换词表后单词加载失败' }, { status: 503 });
              }
              return Response.json(bookId === 'book-b'
                ? { defaultNewWordCount: 2, reviewWords: [], newWords: [{ id: 'book-b-word-1', word: 'adapt', part: 'vt.', meaning: '适应' }, { id: 'book-b-word-2', word: 'consider', part: 'vt.', meaning: '考虑' }] }
                : { defaultNewWordCount: 1, reviewWords: [], newWords: [{ id: 'word-new', word: 'take', part: 'vt.', meaning: '拿；取' }] });
            }
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/ai/tutor/history')) return Response.json({ messages: [], hasMore: false });
            if (path.includes('/api/v1/mistakes?')) {
              window.mistakeRequests.push({ method, url: path });
              return Response.json({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false });
            }
            if (path.includes('/api/v1/study/plans/plan-1/groups/') && path.endsWith('/complete') && method === 'POST') {
              const groupIndex = Number(path.split('/groups/')[1].split('/')[0]);
              const body = JSON.parse(options.body);
              window.studySubmissionAttempts.push(body);
              const groupAlreadyCompleted = window.studyPlanResponse.words
                .filter((word) => word.groupIndex === groupIndex)
                .every((word) => word.completed);
              if (groupAlreadyCompleted) return Response.json(window.studyPlanResponse);
              if (window.studySubmissionAttempts.length === 1) return Response.json({ message: 'Fixture submission failed' }, { status: 503 });
              window.studyPlanWrites.push(body);
              window.studyPlanResponse = makePlan(groupIndex + 1);
              if (window.studySubmissionAttempts.length === 2) {
                throw new TypeError('Failed to fetch after the server saved the group');
              }
              return Response.json(window.studyPlanResponse);
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'POST') {
              window.studyPlanCreateAttempts.push(JSON.parse(options.body));
              if (window.studyPlanCreations.length) {
                return Response.json(window.studyPlanCreations[0]);
              }
              if (window.saveNextStudyPlanCreateBeforeLostResponse) {
                window.saveNextStudyPlanCreateBeforeLostResponse = false;
                window.studyPlanCreations.push(window.planCreateResponse);
              }
              if (window.delayStudyPlanCreate) {
                return new Promise((resolve) => window.studyPlanCreateResolvers.push(resolve));
              }
              window.studyPlanCreations.push(window.planCreateResponse);
              return Response.json(window.planCreateResponse);
            }
            if (path.endsWith('/api/v1/study/plans') && method === 'GET') {
              window.studyPlansReadCount++;
              if (window.failStudyPlansReads > 0) {
                window.failStudyPlansReads--;
                localStorage.setItem('lexloop.test.plan-read-failed', 'yes');
                await new Promise((resolve) => setTimeout(resolve, 200));
                return Response.json({ message: 'Fixture plan list unavailable' }, { status: 503 });
              }
              return Response.json(localStorage.getItem('lexloop.test.empty-study-plans') ? [] : [window.studyPlanResponse]);
            }
            if (path.includes('/api/v1/study/plans')) return Response.json([window.studyPlanResponse]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            return Response.json({});
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until(
        'document.querySelector(".study-plan-load-notice strong")?.textContent === "正在读取已保存的学习计划"',
      );
      await until('document.querySelector(".study-plan-load-notice.is-error")');
      await until("document.querySelector('.word-row strong')?.textContent === 'take'");
      assert.equal(await evaluate('window.studyPlansReadCount'), 1);
      assert.equal(await evaluate('document.querySelector(".create").disabled'), true);
      assert.equal(
        await evaluate(
          'document.querySelector(".study-plan-load-notice").innerText.includes("不会把它显示为空记录")',
        ),
        true,
      );
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("当前学习序列")).click()',
      );
      assert.equal(await evaluate('document.querySelector(".plan-empty") === null'), true);
      await evaluate('document.querySelector(".study-plan-load-notice button").click()');
      await until('document.querySelector(".study-plan-load-notice") === null');
      assert.equal(await evaluate('window.studyPlansReadCount'), 2);
      assert.equal(await evaluate('document.querySelector(".sequence-panel") !== null'), true);
      assert.equal(await evaluate('document.querySelector(".plan-empty") === null'), true);
      assert.equal(
        await evaluate(
          'document.querySelector(".sequence-head > div > span:last-child")?.textContent',
        ),
        '第 1/2 组',
      );
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".sequence-words article > b")].map((badge) => badge.classList.contains("done"))',
        ),
        [false, false],
        'an unsubmitted first group must not look completed',
      );
      const sequenceDesktopLayout = await evaluate(`(() => {
        const panel = document.querySelector('.sequence-panel').getBoundingClientRect();
        const header = document.querySelector('.sequence-head').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          panelLeft: panel.left, panelRight: panel.right, headerLeft: header.left, headerRight: header.right };
      })()`);
      assert.ok(
        sequenceDesktopLayout.page <= sequenceDesktopLayout.viewport &&
          sequenceDesktopLayout.panelLeft >= 0 &&
          sequenceDesktopLayout.panelRight <= sequenceDesktopLayout.viewport &&
          sequenceDesktopLayout.headerLeft >= sequenceDesktopLayout.panelLeft &&
          sequenceDesktopLayout.headerRight <= sequenceDesktopLayout.panelRight,
        JSON.stringify(sequenceDesktopLayout),
      );
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("单词列表")).click()',
      );
      await until(
        'document.querySelector(".create") && !document.querySelector(".create").disabled',
      );
      assert.equal(await evaluate('window.studyPlanCreateAttempts.length'), 0);
      await evaluate(`window.delayNextDashboardWords = true;
        document.querySelector('.add-three-words').click();`);
      await until('window.dashboardWordResolvers.some((item) => item.bookId === "book-a")');
      await evaluate('document.querySelector(".switch-book").click()');
      await until('document.querySelector(".book-drawer")');
      await until(
        '[...document.querySelectorAll(".book-choice")].some((card) => card.textContent.includes("Book B"))',
      );
      await evaluate(
        '[...document.querySelectorAll(".book-choice")].find((card) => card.textContent.includes("Book B")).querySelector("button").click()',
      );
      await until(
        'window.dashboardWordReads.some((item) => item.bookId === "book-b") && document.querySelector(".words-load-error")',
      );
      assert.equal(await evaluate('document.querySelector(".create").disabled'), true);
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".word-row strong")].map((node) => node.textContent)',
        ),
        [],
      );
      await evaluate('document.querySelector(".book-drawer header button").click()');
      await until('document.querySelector(".book-drawer") === null');
      await evaluate('document.querySelector(".words-load-error button").click()');
      await until(
        'document.querySelectorAll(".word-row strong").length === 2 && document.querySelector(".word-row strong")?.textContent === "adapt"',
      );
      assert.equal(await evaluate('document.querySelector(".create").disabled'), false);
      await evaluate(`window.resolveDashboardWordRead("book-a", Response.json({
        defaultNewWordCount: 1,
        reviewWords: [],
        newWords: [{ id: 'stale-word', word: 'stale-a-word', part: 'adj.', meaning: '过期内容' }],
      }))`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".word-row strong")].map((node) => node.textContent)',
        ),
        ['adapt', 'consider'],
      );
      assert.equal(await evaluate('document.querySelector(".create").disabled'), false);
      await evaluate(`window.delayStudyPlanCreate = true;
        document.querySelector('.create').click();
        document.querySelector('.create').click();`);
      await until('window.studyPlanCreateAttempts.length === 1');
      assert.equal(await evaluate('document.querySelector(".create").disabled'), true);
      assert.equal(
        await evaluate(
          'document.querySelector(".create").textContent.includes("正在创建学习计划")',
        ),
        true,
      );
      await evaluate(
        'window.resolveStudyPlanCreate(Response.json({ message: "创建计划测试失败" }, { status: 503 }))',
      );
      await until('!document.querySelector(".create").disabled');
      await until(
        'document.querySelector(".book-message")?.textContent.includes("创建计划测试失败")',
      );
      await evaluate('window.saveNextStudyPlanCreateBeforeLostResponse = true');
      await evaluate(`document.querySelector('.create').click();
        document.querySelector('.create').click();`);
      await until('window.studyPlanCreateAttempts.length === 2');
      assert.equal(await evaluate('window.studyPlanCreateAttempts[1].newWordCount'), 2);
      assert.equal(await evaluate('document.querySelector(".create").disabled'), true);
      await evaluate(
        'window.resolveStudyPlanCreate(Promise.reject(new TypeError("Failed to fetch after the server created the plan")))',
      );
      await until('!document.querySelector(".create").disabled');
      await until('document.querySelector(".book-message")?.textContent.includes("请求未能完成")');
      assert.equal(await evaluate('document.querySelector(".plan-preview-layer") === null'), true);
      assert.equal(await evaluate('window.studyPlanCreations.length'), 1);
      assert.equal(await evaluate('window.studyPlanCreations[0].id'), 'plan-book-b');
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".word-row strong")].map((node) => node.textContent)',
        ),
        ['adapt', 'consider'],
        'the selected words remain available after the create response is lost',
      );
      await evaluate(`document.querySelector('.create').click();
        document.querySelector('.create').click();`);
      await until('window.studyPlanCreateAttempts.length === 3');
      await until('document.querySelector(".plan-preview-layer")');
      assert.equal(await evaluate('window.studyPlanCreations.length'), 1);
      assert.deepEqual(
        await evaluate('window.studyPlanCreateAttempts[1]'),
        await evaluate('window.studyPlanCreateAttempts[2]'),
      );
      assert.equal(await evaluate('window.studyPlanCreations[0].id'), 'plan-book-b');
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong")?.textContent'),
        'adapt',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".plan-preview .start-challenge")?.textContent.includes("开始今天的挑战")',
        ),
        true,
      );
      await evaluate('document.querySelector(".plan-preview header button").click()');
      await until('document.querySelector(".plan-preview-layer") === null');
      assert.equal(await evaluate('window.generationAttempts?.length ?? 0'), 0);
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("当前学习序列")).click()',
      );
      await openCurrentPlan();
      const choiceState = await evaluate(`({
        buttonCount: document.querySelectorAll('.answer-options button').length,
        hasCard: Boolean(document.querySelector('.generated-question')),
        path: location.pathname,
        excerpt: document.body.innerText.slice(-700),
      })`);
      assert.ok(choiceState.buttonCount > 0, JSON.stringify({ ...choiceState, browserErrors }));
      assert.equal(
        await evaluate(
          'document.body.innerText.includes("Maya missed the bus, so she called a taxi.")',
        ),
        false,
        'the saved source sentence stays hidden before the answer is accepted',
      );
      assert.deepEqual(
        await evaluate(
          `Array.from(document.querySelectorAll('.generated-passage mark')).map((node) => node.textContent)`,
        ),
        ['Bright', 'bright'],
        'the reading highlights exact target words without highlighting brightness or brightly',
      );
      const desktopLayout = await evaluate(`(() => {
        const card = document.querySelector('.reading-card').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, cardLeft: card.left, cardRight: card.right };
      })()`);
      assert.ok(desktopLayout.page <= desktopLayout.viewport, JSON.stringify(desktopLayout));
      assert.ok(
        desktopLayout.cardLeft >= 0 && desktopLayout.cardRight <= desktopLayout.viewport,
        JSON.stringify(desktopLayout),
      );
      const apiCallsBeforeSpeech = await evaluate('window.apiFetchLog.length');
      await evaluate('document.querySelector(\'button[aria-label="朗读全文"]\').click()');
      await evaluate('document.querySelector(\'button[aria-label="朗读全文"]\').click()');
      assert.equal(await evaluate('window.studySpeech.spoken.length'), 2);
      assert.equal(await evaluate('window.studySpeech.spoken.at(-1).lang'), 'en-US');
      assert.equal(await evaluate('window.studySpeech.spoken.at(-1).voice'), 'en-US');
      assert.ok(await evaluate('window.studySpeech.cancelCount >= 2'));
      assert.equal(await evaluate('window.studySpeech.active.text.length > 0'), true);
      assert.equal(await evaluate('window.studySpeech.queue.length'), 1);
      await evaluate(`window.studySpeech.voices = [];
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until(
        'document.querySelector(".reading-speech-status")?.textContent.includes("没有可用的英语语音")',
      );
      assert.equal(await evaluate('window.studySpeech.spoken.length'), 2);
      assert.equal(await evaluate('window.studySpeech.active === null'), true);
      assert.ok(
        await evaluate('document.querySelector(".generated-passage")?.innerText.length > 0'),
      );
      await evaluate(`window.SpeechSynthesisUtterance = undefined;
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until(
        'document.querySelector(".reading-speech-status")?.textContent.includes("不支持语音播放")',
      );
      assert.ok(
        await evaluate('document.querySelector(".generated-passage")?.innerText.length > 0'),
      );
      await evaluate(`window.SpeechSynthesisUtterance = window.StudyUtteranceFixture;
        window.studySpeech.voices = [{ lang: 'en-US', name: 'Fixture English' }];
        document.querySelector('button[aria-label="展开分句阅读"]').click()`);
      await until('document.querySelector(".sentence-tools button[aria-label=朗读]")');
      await evaluate('document.querySelector(".sentence-tools button[aria-label=朗读]").click()');
      assert.equal(await evaluate('window.studySpeech.spoken.length'), 3);
      assert.equal(
        await evaluate('window.studySpeech.active.text'),
        'Bright rooms are bright; brightness matters when rooms are brightly lit.',
      );
      assert.equal(await evaluate('window.studySpeech.queue.length'), 1);
      await evaluate('document.querySelector(\'button[aria-label="收起分句阅读"]\').click()');
      assert.equal(await evaluate('window.studySpeech.active === null'), true);
      assert.equal(await evaluate('window.studySpeech.queue.length'), 0);
      assert.equal(await evaluate('document.querySelector(".generated-passage") !== null'), true);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await evaluate(`window.studySpeech.voices = [];
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until(
        'document.querySelector(".reading-speech-status")?.textContent.includes("没有可用的英语语音")',
      );
      const mobileSpeechStatus = await evaluate(`(() => {
        const card = document.querySelector('.reading-card').getBoundingClientRect();
        const status = document.querySelector('.reading-speech-status').getBoundingClientRect();
        return {
          viewport: innerWidth,
          page: document.documentElement.scrollWidth,
          cardLeft: card.left,
          cardRight: card.right,
          statusLeft: status.left,
          statusRight: status.right,
        };
      })()`);
      assert.ok(
        mobileSpeechStatus.page <= mobileSpeechStatus.viewport,
        JSON.stringify(mobileSpeechStatus),
      );
      assert.ok(
        mobileSpeechStatus.statusLeft >= mobileSpeechStatus.cardLeft,
        JSON.stringify(mobileSpeechStatus),
      );
      assert.ok(
        mobileSpeechStatus.statusRight <= mobileSpeechStatus.cardRight,
        JSON.stringify(mobileSpeechStatus),
      );
      await evaluate(`window.studySpeech.voices = [
          { lang: 'zh-CN', name: 'Fixture Chinese' },
          { lang: 'en-US', name: 'Fixture English' },
        ];
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until('document.querySelector(".reading-speech-status")?.textContent === ""');
      assert.equal(await evaluate('window.apiFetchLog.length'), apiCallsBeforeSpeech);
      const mobileLayout = await evaluate(`(() => {
        const card = document.querySelector('.reading-card').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, cardLeft: card.left, cardRight: card.right };
      })()`);
      assert.equal(mobileLayout.viewport, 390);
      assert.ok(mobileLayout.page <= mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.ok(
        mobileLayout.cardLeft >= 0 && mobileLayout.cardRight <= mobileLayout.viewport,
        JSON.stringify(mobileLayout),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await evaluate(
          '(() => { const row = document.querySelector(".lesson-word-entry"); const disclosure = row?.querySelector("details.lesson-word-meaning"); return row?.tagName === "DIV" && disclosure?.open === false && getComputedStyle(disclosure.querySelector("small")).display === "none"; })()',
        ),
        true,
        'the word list is not a fake button and its meaning hint starts collapsed',
      );
      await evaluate('document.querySelector(".lesson-word-meaning summary").focus()');
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
      assert.equal(
        await evaluate('document.querySelector(".lesson-word-meaning").open'),
        true,
        'keyboard activation reveals the optional hint',
      );
      assert.equal(
        await evaluate('document.activeElement.matches(".lesson-word-meaning summary")'),
        true,
        'keyboard focus stays on the native disclosure control',
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
        text: ' ',
        unmodifiedText: ' ',
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
      });
      assert.equal(
        await evaluate('document.querySelector(".lesson-word-meaning").open'),
        false,
        'the optional hint can be collapsed again by keyboard',
      );
      await evaluate('document.querySelector(".answer-options button").click()');
      await until('document.querySelector(".question-answer")');
      const persistedDrafts = await evaluate(`Object.entries(localStorage)
        .filter(([key]) => key.startsWith('lexloop.study.draft.'))
        .map(([key, value]) => ({ key, value }))`);
      assert.equal(persistedDrafts.length, 1);
      assert.doesNotMatch(persistedDrafts[0].value, /correctAnswers|explanation|optionNotes/);
      assert.match(persistedDrafts[0].value, /暗的/);

      await send('Page.reload');
      await openCurrentPlan();
      assert.equal(
        await evaluate('document.querySelector(".answer-options button.selected")?.textContent'),
        '暗的',
      );
      assert.equal(await evaluate('document.querySelector(".answer-feedback") === null'), true);

      await evaluate(`const session = JSON.parse(localStorage.getItem('lexloop.session'));
        session.user.id = 'another-study-user';
        localStorage.setItem('lexloop.session', JSON.stringify(session));`);
      await send('Page.reload');
      await openCurrentPlan();
      assert.equal(
        await evaluate('document.querySelector(".answer-options button.selected") === null'),
        true,
      );
      assert.equal(await evaluate('document.querySelector(".answer-feedback") === null'), true);

      await evaluate(`const session = JSON.parse(localStorage.getItem('lexloop.session'));
        session.user.id = 'study-user';
        localStorage.setItem('lexloop.session', JSON.stringify(session));`);
      await send('Page.reload');
      await openCurrentPlan();
      assert.equal(
        await evaluate('document.querySelector(".answer-options button.selected")?.textContent'),
        '暗的',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("清空本组作答")).click()',
      );
      await until('document.querySelector(".answer-options button.selected") === null');
      assert.equal(
        await evaluate(
          "Object.keys(localStorage).some((key) => key.startsWith('lexloop.study.draft.'))",
        ),
        false,
      );

      await evaluate('document.querySelector(".answer-options button").click()');
      await until('document.querySelector(".question-answer")');
      assert.equal(await evaluate('document.querySelector(".answer-feedback") === null'), true);
      assert.equal(
        await evaluate('document.querySelector(".question-explanation") === null'),
        true,
      );
      assert.equal(
        await evaluate(
          'window.studyPlanResponse.content.groups[0].questions[0].correctAnswers === undefined',
        ),
        true,
      );
      assert.equal(
        await evaluate('window.studyPlanResponse.words[0].question.correctAnswers === undefined'),
        true,
      );

      await evaluate('[...document.querySelectorAll(".exercises .check-matches")].at(-1).click()');
      await until('window.studyAlerts.length === 1');
      assert.equal(await evaluate('document.querySelector(".answer-feedback") === null'), true);
      assert.equal(
        await evaluate('document.querySelector(".answer-options button.selected") !== null'),
        true,
      );
      assert.equal(await evaluate('window.studyPlanResponse.status'), 'ACTIVE');
      assert.equal(
        await evaluate(
          "Object.keys(localStorage).some((key) => key.startsWith('lexloop.study.draft.'))",
        ),
        true,
      );

      await evaluate('[...document.querySelectorAll(".exercises .check-matches")].at(-1).click()');
      await until('window.studyAlerts.length === 2');
      assert.equal(await evaluate('document.querySelector(".answer-feedback") === null'), true);
      assert.equal(
        await evaluate('document.querySelector(".question-explanation") === null'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".answer-options button.selected")?.textContent'),
        '暗的',
        'the original answer draft remains available when the server response is lost',
      );
      assert.equal(await evaluate('window.studyPlanWrites.length'), 1);
      assert.equal(await evaluate('window.studyPlanResponse.words[0].completed'), true);
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 2);

      await evaluate('[...document.querySelectorAll(".exercises .check-matches")].at(-1).click()');
      await until('document.querySelector(".answer-feedback")');
      assert.equal(
        await evaluate(
          "Object.keys(localStorage).some((key) => key.startsWith('lexloop.study.draft.'))",
        ),
        false,
      );
      assert.match(
        await evaluate('document.querySelector(".answer-feedback").textContent'),
        /回答错误/,
      );
      assert.match(
        await evaluate('document.querySelector(".question-answer").textContent'),
        /正确答案：明亮的/,
      );
      assert.match(
        await evaluate('document.querySelector(".question-explanation").textContent'),
        /bright 描述光线充足/,
      );
      assert.equal(
        await evaluate('document.querySelector(".saved-review-context p")?.textContent'),
        'Maya missed the bus, so she called a taxi.',
      );
      assert.match(
        await evaluate('document.querySelector(".saved-review-context small").textContent'),
        /微故事 · 上班路上/,
      );
      assert.deepEqual(
        await evaluate(
          'window.studyPlanWrites[0].answers.map(({ bookWordId, selectedAnswer }) => ({ bookWordId, selectedAnswer }))',
        ),
        [{ bookWordId: 'word-1', selectedAnswer: ['暗的'] }],
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 3);
      assert.equal(
        await evaluate('window.studyPlanWrites.length'),
        1,
        'retry after a lost success response returns the saved result without recording a second attempt',
      );
      assert.equal(await evaluate('window.studyPlanResponse.status'), 'ACTIVE');
      assert.equal(
        await evaluate(
          'window.studyPlanResponse.content.groups[1].questions[0].pairs[0].right === window.matchingOriginalPairs[0].right',
        ),
        false,
      );

      await evaluate('document.querySelector(\'button[aria-label="朗读全文"]\').click()');
      assert.notEqual(await evaluate('window.studySpeech.active'), null);
      const speechCancelCount = await evaluate('window.studySpeech.cancelCount');
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("继续下一组")).click()',
      );
      await until('document.querySelectorAll(".match-phrases button").length === 4');
      assert.equal(await evaluate('window.studySpeech.active === null'), true);
      assert.ok(await evaluate(`window.studySpeech.cancelCount > ${speechCancelCount}`));
      await evaluate('document.querySelector(".lesson-page-head button").click()');
      await until('document.querySelector(".sequence-panel")');
      assert.equal(
        await evaluate(
          'document.querySelector(".sequence-head > div > span:last-child")?.textContent',
        ),
        '第 2/2 组',
        'the sequence should identify the next group after the first group is saved',
      );
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".sequence-words article > b")].map((badge) => badge.classList.contains("done"))',
        ),
        [true, false],
        'only the group with persisted completion should be marked done',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const sequenceMobileLayout = await evaluate(`(() => {
        const panel = document.querySelector('.sequence-panel').getBoundingClientRect();
        const header = document.querySelector('.sequence-head').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth,
          panelLeft: panel.left, panelRight: panel.right, headerLeft: header.left, headerRight: header.right };
      })()`);
      assert.ok(
        sequenceMobileLayout.page <= sequenceMobileLayout.viewport &&
          sequenceMobileLayout.panelLeft >= 0 &&
          sequenceMobileLayout.panelRight <= sequenceMobileLayout.viewport &&
          sequenceMobileLayout.headerLeft >= sequenceMobileLayout.panelLeft &&
          sequenceMobileLayout.headerRight <= sequenceMobileLayout.panelRight,
        JSON.stringify(sequenceMobileLayout),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        '[...document.querySelectorAll(".sequence-summary button")].find((button) => button.textContent.includes("继续学习")).click()',
      );
      await until('document.querySelectorAll(".match-phrases button").length === 4');
      assert.equal(
        await evaluate('document.querySelectorAll(".match-definitions button").length'),
        4,
      );
      for (let index = 0; index < 4; index++) {
        await evaluate(`document.querySelectorAll(".match-phrases button")[${index}].click()`);
        await delay(60);
        await evaluate(
          `document.querySelectorAll(".match-definitions button")[${(index + 1) % 4}].click()`,
        );
        await delay(60);
      }
      await until(
        'document.querySelector(".generated-matching .check-matches") && !document.querySelector(".generated-matching .check-matches").disabled',
      );
      await evaluate('document.querySelector(".generated-matching .check-matches").click()');
      await until('document.querySelector(".question-answer")');
      assert.equal(await evaluate('document.querySelector(".answer-feedback") === null'), true);
      await evaluate('[...document.querySelectorAll(".exercises .check-matches")].at(-1).click()');
      await until('document.querySelectorAll(".match-answer-review-correct").length === 4');
      assert.equal(
        await evaluate(
          "Object.keys(localStorage).some((key) => key.startsWith('lexloop.study.draft.'))",
        ),
        false,
      );
      assert.match(
        await evaluate('document.querySelector(".answer-feedback").textContent'),
        /回答错误/,
      );
      assert.deepEqual(
        await evaluate('window.studyPlanWrites[1].answers[0].selectedAnswer.length'),
        4,
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 4);

      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("查看今日总结")).click()',
      );
      await until('document.querySelector("#settlement-title")');
      assert.match(
        await evaluate('document.querySelector("#settlement-title").textContent'),
        /本组学习完成/,
      );
      assert.match(
        await evaluate('document.querySelector(".settlement-overview article p").textContent'),
        /1 新单词.*1 复习单词/,
      );
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".settlement-schedule-list time")].map((time) => time.dateTime)',
        ),
        await evaluate('window.studyPlanResponse.words.map((word) => word.nextReviewAt)'),
      );
      assert.equal(
        await evaluate(
          'document.body.innerText.includes("一个月内") || document.body.innerText.includes("已安排明天优先复习")',
        ),
        false,
      );
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".settlement-schedule-state")].map((node) => node.textContent.trim())',
        ),
        ['已到期 · 可进入首页复习', '尚未到期'],
      );
      assert.ok(
        await evaluate(
          '[...document.querySelectorAll(".settlement-schedule-list time")].every((node) => node.textContent.includes("(") && node.textContent.includes(")"))',
        ),
        'The displayed date must include its time zone.',
      );
      assert.match(
        await evaluate('document.querySelector(".settlement-heading").innerText'),
        /本组首次有效作答结果.*用户当前的排期.*不是本组完成时快照/s,
      );
      assert.match(
        await evaluate('document.querySelector(".settlement-words").innerText'),
        /词义识别.*连续答对 1\/2，还需答对 1 次/s,
      );
      assert.ok(await evaluate('document.querySelector(".settlement-mistakes-link") !== null'));
      await evaluate('document.querySelector(".settlement-mistakes-link").click()');
      await until('document.querySelector(".mistakes-page")');
      assert.equal(await evaluate('window.mistakeRequests.length'), 1);
      assert.equal(await evaluate('window.mistakeRequests[0].method'), 'GET');

      await evaluate('localStorage.setItem("lexloop.test.empty-study-plans", "yes")');
      await send('Page.reload');
      await until('document.querySelector("[role=tab]")');
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("今日学习历史")).click()',
      );
      await until('document.querySelector(".plan-empty")');
      assert.equal(
        await evaluate(
          'document.querySelector(".plan-empty").innerText.includes("今天还没有学习记录")',
        ),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".study-plan-load-notice") === null'),
        true,
      );
      assert.equal(await evaluate('window.studyPlansReadCount'), 1);
      assert.equal(await evaluate('window.studyPlanCreateAttempts.length'), 0);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
