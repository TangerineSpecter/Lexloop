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
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      });
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          waiting.set(id, { resolve, reject, method });
          socket.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression) => {
        let result;
        try {
          result = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
        } catch (cause) {
          throw new Error(
            `${cause instanceof Error ? cause.message : String(cause)}; expression=${expression.slice(0, 160)}`,
          );
        }
        if (result.exceptionDetails)
          throw new Error(
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
          );
        return result.result.value;
      };
      const pressKey = async (key, code, windowsVirtualKeyCode, text) => {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code,
          windowsVirtualKeyCode,
          ...(text ? { text, unmodifiedText: text } : {}),
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode,
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
              { lang: 'en-US', name: 'Fixture English', localService: true },
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
                sentences: [{ english: 'Bright rooms are bright; brightness matters when rooms are brightly lit.', chinese: '房间要明亮，充足的光线也很重要。', simplified: '房间越明亮，越让人在意光线。', grammar: 'bright 修饰 rooms；brightness 是名词，brightly 是副词。' }],
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
          window.readingRewriteRequests = [];
          window.readingRewriteResolvers = [];
          window.failNextRewriteFeedback = false;
          window.readingWordUseRequests = [];
          window.readingWordUseResolvers = [];
          window.failNextWordUseFeedback = false;
          window.readingTranslationRequests = [];
          window.readingTranslationResolvers = [];
          window.failNextTranslationFeedback = false;
          window.holdNextTranslationFeedback = false;
          window.studyAlerts = [];
          window.mistakeRequests = [];
          window.apiFetchLog = [];
          window.tutorRequests = [];
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
            if (path.endsWith('/api/v1/ai/tutor/messages') && method === 'POST') {
              const record = { body: JSON.parse(options.body), aborted: false, cancelled: false };
              window.tutorRequests.push(record);
              const body = new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('event: delta\\ndata: {"content":"先从句子结构"}\\n\\n'));
                  options.signal?.addEventListener('abort', () => {
                    record.aborted = true;
                    try { controller.error(new DOMException('Fixture stream aborted', 'AbortError')); } catch { /* Already closed by the reader. */ }
                  }, { once: true });
                },
                cancel() { record.cancelled = true; },
              });
              return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
            }
            if (path.includes('/api/v1/mistakes?')) {
              window.mistakeRequests.push({ method, url: path });
              return Response.json({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false });
            }
            const generationPath = '/api/v1/study/plans/first-plan-book-b/generate';
            if (path.endsWith(generationPath) && method === 'POST' && window.firstPlanJourney) {
              window.firstPlanGenerationAttempts.push('first-plan-book-b');
              return Response.json(window.firstPlanActiveResponse);
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
              if (window.firstPlanJourney) {
                window.studyPlanCreations.push(window.firstPlanGeneratingResponse);
                if (window.delayFirstPlanJourneyCreate) {
                  return new Promise((resolve) => window.studyPlanCreateResolvers.push(resolve));
                }
                return Response.json(window.firstPlanGeneratingResponse);
              }
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
            if (path.endsWith('/api/v1/ai/reading-rewrite-feedback') && method === 'POST') {
              window.readingRewriteRequests.push({
                userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id,
                body: JSON.parse(options.body),
              });
              if (window.failNextRewriteFeedback) {
                window.failNextRewriteFeedback = false;
                return new Promise((resolve) => window.readingRewriteResolvers.push(resolve));
              }
              if (window.readingRewriteRequests.length === 1) {
                return new Promise((resolve) => window.readingRewriteResolvers.push(resolve));
              }
              return Response.json({
                meaning: '保留了光线充足会让房间显得明亮这一层意思。',
                grammar: 'rooms 作主语时，look 后可接形容词 brighter。',
                naturalness: '整体表达清楚自然。',
                alternative: 'Good lighting makes a big difference in a room.',
              });
            }
            if (path.endsWith('/api/v1/ai/reading-word-use-feedback') && method === 'POST') {
              window.readingWordUseRequests.push({
                userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id,
                body: JSON.parse(options.body),
              });
              if (window.failNextWordUseFeedback) {
                window.failNextWordUseFeedback = false;
                return new Promise((resolve) => window.readingWordUseResolvers.push(resolve));
              }
              if (window.readingWordUseRequests.length === 1) {
                return new Promise((resolve) => window.readingWordUseResolvers.push(resolve));
              }
              return Response.json({
                wordUse: 'bright 用作形容词修饰 room，符合给定词义。',
                meaning: '句子表达了房间光线充足。',
                grammar: '主谓搭配正确。',
                naturalness: '表达清楚自然。',
                alternative: null,
              });
            }
            if (path.endsWith('/api/v1/ai/reading-translation-feedback') && method === 'POST') {
              window.readingTranslationRequests.push({
                userId: JSON.parse(localStorage.getItem('lexloop.session')).user.id,
                body: JSON.parse(options.body),
              });
              if (window.failNextTranslationFeedback) {
                window.failNextTranslationFeedback = false;
                return Response.json({ message: 'Fixture translation feedback unavailable' }, { status: 503 });
              }
              if (window.holdNextTranslationFeedback) {
                window.holdNextTranslationFeedback = false;
                return new Promise((resolve) => window.readingTranslationResolvers.push(resolve));
              }
              return Response.json({
                meaning: '译文保留了照明让房间显得更亮的因果关系。',
                naturalness: '中文表达清楚自然。',
              });
            }
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
      assert.equal(
        await evaluate('document.querySelector(".book-selection-prompt") === null'),
        true,
        'a learner with an active plan should not see the new-user vocabulary prompt',
      );
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
      await until(
        'document.querySelector(".book-message")?.textContent.includes("暂时无法连接学习服务，请检查网络或稍后重试")',
      );
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
      await evaluate(`(() => {
        const input = document.querySelector('.tutor-composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '为什么这里用这个时态？');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').querySelector('button').click();
      })()`);
      await until(
        'window.tutorRequests.length === 1 && document.querySelector(".tutor-message.is-assistant .tutor-message-body")?.textContent.includes("先从句子结构")',
      );
      assert.deepEqual(await evaluate('window.tutorRequests[0].body'), {
        type: 'STUDY_GROUP',
        planId: 'plan-1',
        groupIndex: 0,
        message: '为什么这里用这个时态？',
      });
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const stopBounds = await evaluate(`(() => {
        const button = document.querySelector('.tutor-stop').getBoundingClientRect();
        return { left: button.left, right: button.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
      })()`);
      assert.ok(
        stopBounds.left >= 0 &&
          stopBounds.right <= stopBounds.viewport &&
          stopBounds.scrollWidth <= stopBounds.viewport,
        JSON.stringify(stopBounds),
      );
      await evaluate('document.querySelector(".tutor-stop").focus()');
      assert.equal(
        await evaluate('document.activeElement === document.querySelector(".tutor-stop")'),
        true,
      );
      await pressKey('Enter', 'Enter', 13, '\r');
      await until(
        'window.tutorRequests[0].aborted && !document.querySelector(".tutor-panel .tutor-stop")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".tutor-message.is-assistant.is-failed .tutor-message-body")?.textContent.includes("先从句子结构")',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".tutor-message.is-assistant.is-failed .tutor-failed button")?.textContent.includes("重试")',
        ),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".tutor-error.is-error") === null'),
        true,
        'intentional stop must not be reported as a network error',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".tutor-error.is-success")?.textContent.includes("已收到的内容仍保留")',
        ),
        true,
      );
      await evaluate(
        'document.querySelector(".tutor-message.is-assistant.is-failed .tutor-failed button").click()',
      );
      await until(
        'window.tutorRequests.length === 2 && document.querySelector(".tutor-message.is-assistant.is-pending .tutor-message-body")?.textContent.includes("先从句子结构")',
      );
      assert.equal(
        await evaluate('window.tutorRequests[1].body.message'),
        '为什么这里用这个时态？',
      );
      await evaluate('document.querySelector(".lesson-page-head button").click()');
      await until('document.querySelector(".sequence-panel") && window.tutorRequests[1].aborted');
      await send('Emulation.clearDeviceMetricsOverride');
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
      await evaluate(`window.studySpeech.voices = [{ lang: 'en-US', name: 'Remote English', localService: false }];
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until(
        'document.querySelector(".reading-speech-status")?.textContent.includes("标记为本地服务")',
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
      assert.equal(await evaluate('window.apiFetchLog.length'), apiCallsBeforeSpeech);
      await evaluate(`window.SpeechSynthesisUtterance = window.StudyUtteranceFixture;
        window.studySpeech.voices = [{ lang: 'en-US', name: 'Fixture English', localService: true }];
        document.querySelector('button[aria-label="展开分句阅读"]').click()`);
      await until('document.querySelector(".sentence-tools button[aria-label=朗读]")');
      assert.equal(
        await evaluate('document.querySelector(".sentence-rewrite-panel")?.hidden'),
        true,
      );
      await evaluate(
        `document.querySelector('.sentence-tools button[aria-label="换种说法第 1 句"]').click()`,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-tools button[aria-label*=换种说法]").getAttribute("aria-expanded")',
        ),
        'true',
      );
      const rewriteNote = await evaluate(
        'document.querySelector(".sentence-rewrite-note")?.textContent',
      );
      assert.ok(rewriteNote.includes('当前选择的模型'));
      assert.ok(rewriteNote.includes('不会保存作答'));
      assert.equal(await evaluate('window.readingRewriteRequests.length'), 0);
      await evaluate(`(() => {
        const input = document.querySelector('#sentence-rewrite-0-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Rooms look brighter when there is enough light.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').querySelector('button[type="submit"]').focus();
      })()`);
      const rewriteSubmit =
        'document.querySelector("#sentence-rewrite-0-answer").closest("form").querySelector("button[type=submit]")';
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
      await until('window.readingRewriteRequests.length === 1');
      assert.equal(await evaluate(`${rewriteSubmit}.disabled`), true);
      await evaluate(`${rewriteSubmit}.click()`);
      await delay(80);
      assert.equal(await evaluate('window.readingRewriteRequests.length'), 1);
      await evaluate(
        `window.readingRewriteResolvers.shift()(Response.json({ message: '模型暂时不可用' }, { status: 503 }))`,
      );
      await until('document.querySelector(".sentence-rewrite-error")');
      assert.equal(
        await evaluate('document.querySelector("#sentence-rewrite-0-answer").value'),
        'Rooms look brighter when there is enough light.',
        'the learner draft remains available after a failed feedback request',
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 0);
      assert.equal(await evaluate('window.studyPlanWrites.length'), 0);
      await evaluate(`${rewriteSubmit}.click()`);
      await until('document.querySelector(".sentence-rewrite-feedback")');
      assert.equal(await evaluate('window.readingRewriteRequests.length'), 2);
      assert.equal(await evaluate('window.readingRewriteRequests[1].userId'), 'study-user');
      assert.deepEqual(await evaluate('window.readingRewriteRequests[1].body'), {
        sourceSentence: 'Bright rooms are bright; brightness matters when rooms are brightly lit.',
        learnerRewrite: 'Rooms look brighter when there is enough light.',
      });
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-rewrite-feedback").innerText.includes("分" )',
        ),
        false,
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 0);
      assert.equal(await evaluate('window.studyPlanWrites.length'), 0);
      const previousRewriteFeedback = await evaluate(
        'document.querySelector(".sentence-rewrite-feedback").innerText',
      );
      const revisedRewrite = 'Good lighting makes the room appear brighter.';
      await evaluate(`(() => {
        const input = document.querySelector('#sentence-rewrite-0-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(revisedRewrite)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-rewrite-feedback blockquote").textContent',
        ),
        'Rooms look brighter when there is enough light.',
        'editing keeps the submitted version that produced the visible feedback',
      );
      await evaluate(`window.failNextRewriteFeedback = true; ${rewriteSubmit}.click()`);
      await until('window.readingRewriteRequests.length === 3');
      assert.equal(await evaluate(`${rewriteSubmit}.textContent.includes('正在更新建议…')`), true);
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-rewrite-feedback").innerText.includes("保留了光线充足")',
        ),
        true,
        'the last successful feedback stays attached to its submitted answer during a new request',
      );
      await evaluate(
        `window.readingRewriteResolvers.shift()(Response.json({ message: '模型暂时不可用' }, { status: 503 }))`,
      );
      await until('document.querySelector(".sentence-rewrite-error")');
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-rewrite-error").textContent.includes("上次成功的反馈（对应下方所示版本）仍保留")',
        ),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".sentence-rewrite-feedback").innerText'),
        previousRewriteFeedback,
      );
      assert.equal(
        await evaluate('document.querySelector("#sentence-rewrite-0-answer").value'),
        revisedRewrite,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-rewrite-feedback blockquote").textContent',
        ),
        'Rooms look brighter when there is enough light.',
      );
      await evaluate(`${rewriteSubmit}.click()`);
      await until('window.readingRewriteRequests.length === 4');
      await until(
        `document.querySelector(".sentence-rewrite-feedback blockquote")?.textContent === ${JSON.stringify(revisedRewrite)}`,
      );
      assert.equal(
        await evaluate('window.readingRewriteRequests[2].body.learnerRewrite'),
        revisedRewrite,
      );
      assert.equal(
        await evaluate('window.readingRewriteRequests[3].body.learnerRewrite'),
        revisedRewrite,
      );
      const wordUseToggle = 'document.querySelector(".reading-word-use-toggle")';
      assert.equal(await evaluate(`${wordUseToggle}.getAttribute('aria-expanded')`), 'false');
      assert.equal(await evaluate('window.readingWordUseRequests.length'), 0);
      await evaluate(`${wordUseToggle}.click()`);
      await until('!document.querySelector("#reading-word-use-practice").hidden');
      assert.equal(
        await evaluate('document.querySelector(".sentence-rewrite-panel").hidden'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("#sentence-rewrite-0-answer").value'),
        revisedRewrite,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".sentence-rewrite-panel .sentence-rewrite-feedback") !== null',
        ),
        true,
      );
      assert.ok(
        (
          await evaluate(
            'document.querySelector(".sentence-word-use-panel .sentence-rewrite-note").textContent',
          )
        ).includes('只有点击提交后'),
      );
      await evaluate(`${wordUseToggle}.focus()`);
      for (const expectedFocus of [
        'reading-word-use-practice-word',
        'reading-word-use-practice-meaning-hint',
        'reading-word-use-practice-answer',
      ]) {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Tab',
          code: 'Tab',
          windowsVirtualKeyCode: 9,
        });
        await until(`document.activeElement.id === ${JSON.stringify(expectedFocus)}`);
      }
      const wordUseAnswer = 'The room is bright in the morning.';
      await evaluate(`(() => {
        const input = document.querySelector('#reading-word-use-practice-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(wordUseAnswer)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').querySelector('button[type="submit"]').focus();
      })()`);
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
      await until('window.readingWordUseRequests.length === 1');
      const wordUseSubmit =
        'document.querySelector("#reading-word-use-practice button[type=submit]")';
      assert.equal(await evaluate(`${wordUseSubmit}.disabled`), true);
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice-word").disabled'),
        true,
      );
      await evaluate(`${wordUseSubmit}.click()`);
      await delay(60);
      assert.equal(await evaluate('window.readingWordUseRequests.length'), 1);
      assert.deepEqual(await evaluate('window.readingWordUseRequests[0]'), {
        userId: 'study-user',
        body: {
          word: 'bright',
          meaning: '明亮的',
          learnerSentence: wordUseAnswer,
        },
      });
      await evaluate(`${wordUseToggle}.click()`);
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice").hidden'),
        true,
      );
      assert.equal(await evaluate('window.readingWordUseRequests.length'), 1);
      await evaluate(`${wordUseToggle}.click()`);
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice-answer").value'),
        wordUseAnswer,
      );
      await evaluate(
        `window.readingWordUseResolvers.shift()(Response.json({ message: '模型暂时不可用' }, { status: 503 }))`,
      );
      await until('document.querySelector("#reading-word-use-practice [role=alert]")');
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice-answer").value'),
        wordUseAnswer,
      );
      assert.equal(await evaluate('window.readingWordUseRequests.length'), 1);
      await evaluate(`${wordUseSubmit}.click()`);
      await until(
        'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback")',
      );
      assert.equal(await evaluate('window.readingWordUseRequests.length'), 2);
      const previousWordUseFeedback = await evaluate(
        'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback").innerText',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback").innerText.includes("分")',
        ),
        false,
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 0);
      assert.equal(await evaluate('window.studyPlanWrites.length'), 0);
      const revisedWordUseAnswer = 'Good lighting keeps the reading corner bright.';
      await evaluate(`(() => {
        const input = document.querySelector('#reading-word-use-practice-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(revisedWordUseAnswer)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback blockquote").textContent',
        ),
        wordUseAnswer,
        'the prior feedback keeps its submitted sentence visible after editing',
      );
      await evaluate(
        'document.querySelector("#reading-word-use-practice").scrollIntoView({ block: "center" })',
      );
      await capture('word-use-prior-submission-1440.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      const wordUseRevision390 = await evaluate(`(() => {
        const panel = document.querySelector('#reading-word-use-practice').getBoundingClientRect();
        const feedback = document.querySelector('#reading-word-use-practice .sentence-rewrite-feedback').getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, panelLeft: panel.left, panelRight: panel.right, feedbackRight: feedback.right };
      })()`);
      assert.ok(
        wordUseRevision390.viewport === 390 &&
          wordUseRevision390.scrollWidth <= 390 &&
          wordUseRevision390.panelLeft >= 0 &&
          wordUseRevision390.panelRight <= 391 &&
          wordUseRevision390.feedbackRight <= 391,
        JSON.stringify(wordUseRevision390),
      );
      await capture('word-use-prior-submission-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(`window.failNextWordUseFeedback = true; ${wordUseSubmit}.click()`);
      await until('window.readingWordUseRequests.length === 3');
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice [role=status]")?.textContent',
        ),
        '正在更新建议…',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback").innerText',
        ),
        previousWordUseFeedback,
      );
      await evaluate(
        `window.readingWordUseResolvers.shift()(Response.json({ message: '模型暂时不可用' }, { status: 503 }))`,
      );
      await until('document.querySelector("#reading-word-use-practice [role=alert]")');
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice [role=alert]").textContent.includes("上次成功的反馈仍保留")',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback").innerText',
        ),
        previousWordUseFeedback,
      );
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice-answer").value'),
        revisedWordUseAnswer,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback blockquote").textContent',
        ),
        wordUseAnswer,
      );
      await evaluate(`${wordUseSubmit}.click()`);
      await until('window.readingWordUseRequests.length === 4');
      await until(
        `document.querySelector("#reading-word-use-practice .sentence-rewrite-feedback blockquote")?.textContent === ${JSON.stringify(revisedWordUseAnswer)}`,
      );
      await evaluate(
        `document.querySelector('.sentence-tools button[aria-label="换种说法第 1 句"]').click()`,
      );
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice").hidden'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".sentence-rewrite-panel").hidden'),
        false,
      );
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice-answer").value'),
        revisedWordUseAnswer,
      );
      await evaluate(`${wordUseToggle}.click()`);
      assert.equal(
        await evaluate('document.querySelector(".sentence-rewrite-panel").hidden'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice-answer").value'),
        revisedWordUseAnswer,
      );
      assert.equal(await evaluate('window.readingRewriteRequests.length'), 4);
      assert.equal(await evaluate('window.readingWordUseRequests.length'), 4);
      const translationDetailToggle =
        'document.querySelector(\'.sentence-tools button[aria-label="翻译"]\')';
      await evaluate(`${translationDetailToggle}.click()`);
      assert.equal(
        await evaluate('Boolean(document.querySelector(".sentence-detail.is-translation"))'),
        true,
      );
      const translationToggle =
        'document.querySelector(\'.sentence-tools button[aria-label="先用中文理解第 1 句"]\')';
      const translationPanel = 'document.querySelector("#sentence-translation-0")';
      await evaluate(`${translationToggle}.click()`);
      await until(`!${translationPanel}.hidden`);
      assert.equal(
        await evaluate('document.querySelector(".sentence-detail.is-translation")'),
        null,
      );
      assert.equal(
        await evaluate('document.querySelector(".sentence-rewrite-panel").hidden'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice").hidden'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-answer").value'),
        '',
      );
      assert.equal(await evaluate('window.readingTranslationRequests.length'), 0);
      const translationReferenceToggle =
        'document.querySelector("#sentence-translation-0 .sentence-translation-reference-toggle")';
      await evaluate(`${translationReferenceToggle}.click()`);
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-reference").textContent'),
        '房间要明亮，充足的光线也很重要。',
      );
      await evaluate(`${translationReferenceToggle}.click()`);
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-reference")'),
        null,
      );
      const translationAnswer = '良好的灯光让房间看起来更明亮。';
      await evaluate(`(() => {
        const input = document.querySelector('#sentence-translation-0-answer');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(translationAnswer)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const translationSubmit =
        'document.querySelector("#sentence-translation-0 button[type=submit]")';
      assert.equal(await evaluate(`${translationSubmit}.disabled`), false);
      await evaluate(`window.holdNextTranslationFeedback = true;
        const form = document.querySelector('#sentence-translation-0-answer').form;
        form.requestSubmit(); form.requestSubmit();`);
      await until('window.readingTranslationRequests.length === 1');
      await delay(50);
      assert.deepEqual(await evaluate('window.readingTranslationRequests[0]'), {
        userId: 'study-user',
        body: {
          sourceSentence:
            'Bright rooms are bright; brightness matters when rooms are brightly lit.',
          learnerTranslation: translationAnswer,
        },
      });
      assert.equal(await evaluate(`${translationSubmit}.disabled`), true);
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-reference")'),
        null,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback")',
        ),
        null,
      );
      assert.equal(await evaluate('window.readingTranslationRequests.length'), 1);
      await evaluate(`window.readingTranslationResolvers.shift()(Response.json({
        meaning: '译文保留了房间光线带来明亮感的意思。',
        naturalness: '中文表达自然。',
      }))`);
      await until('document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback")');
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback blockquote").textContent',
        ),
        translationAnswer,
      );
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-reference").textContent'),
        '房间要明亮，充足的光线也很重要。',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback").innerText.includes("得分")',
        ),
        false,
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 0);
      assert.equal(await evaluate('window.studyPlanWrites.length'), 0);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        'document.querySelector("#sentence-translation-0").scrollIntoView({ block: "center" })',
      );
      await capture('reading-translation-1440.png');
      const translationDesktop = await evaluate(`(() => {
        const panel = document.querySelector('#sentence-translation-0').getBoundingClientRect();
        const input = document.querySelector('#sentence-translation-0-answer').getBoundingClientRect();
        const toolbar = document.querySelector('.sentence-tools').getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: panel.left, right: panel.right, inputRight: input.right, toolbarLeft: toolbar.left, toolbarRight: toolbar.right };
      })()`);
      assert.ok(
        translationDesktop.scrollWidth <= translationDesktop.viewport,
        JSON.stringify(translationDesktop),
      );
      assert.ok(
        translationDesktop.left >= 0 && translationDesktop.right <= translationDesktop.viewport,
        JSON.stringify(translationDesktop),
      );
      assert.ok(
        translationDesktop.inputRight <= translationDesktop.viewport,
        JSON.stringify(translationDesktop),
      );
      assert.ok(
        translationDesktop.toolbarLeft >= 0 &&
          translationDesktop.toolbarRight <= translationDesktop.viewport,
        JSON.stringify(translationDesktop),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      const translationMobile = await evaluate(`(() => {
        const panel = document.querySelector('#sentence-translation-0').getBoundingClientRect();
        const input = document.querySelector('#sentence-translation-0-answer').getBoundingClientRect();
        const toolbar = document.querySelector('.sentence-tools').getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: panel.left, right: panel.right, inputRight: input.right, toolbarLeft: toolbar.left, toolbarRight: toolbar.right };
      })()`);
      assert.equal(translationMobile.viewport, 390);
      assert.ok(translationMobile.scrollWidth <= 390, JSON.stringify(translationMobile));
      assert.ok(
        translationMobile.left >= 0 && translationMobile.right <= 391,
        JSON.stringify(translationMobile),
      );
      assert.ok(translationMobile.inputRight <= 391, JSON.stringify(translationMobile));
      assert.ok(
        translationMobile.toolbarLeft >= 0 && translationMobile.toolbarRight <= 391,
        JSON.stringify(translationMobile),
      );
      await evaluate(
        'document.querySelector("#sentence-translation-0").scrollIntoView({ block: "center" })',
      );
      await capture('reading-translation-390.png');
      await evaluate('document.querySelector("#sentence-translation-0-answer").focus()');
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate(
          'document.activeElement === document.querySelector("#sentence-translation-0 button[type=submit]")',
        ),
        true,
      );
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate(
          'document.activeElement === document.querySelector("#sentence-translation-0 .sentence-translation-reference-toggle")',
        ),
        true,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(`window.failNextTranslationFeedback = true;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(document.querySelector('#sentence-translation-0-answer'), '光线好会让房间显得更亮。');
        document.querySelector('#sentence-translation-0-answer').dispatchEvent(new Event('input', { bubbles: true }));
        ${translationSubmit}.click()`);
      await until('window.readingTranslationRequests.length === 2');
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback blockquote").textContent',
        ),
        translationAnswer,
        'a new draft does not relabel the previous feedback as if it described this draft',
      );
      await until('document.querySelector("#sentence-translation-0 [role=alert]")');
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-answer").value'),
        '光线好会让房间显得更亮。',
      );
      await evaluate(`${translationSubmit}.click()`);
      await until('window.readingTranslationRequests.length === 3');
      await until(
        'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback blockquote")?.textContent === "光线好会让房间显得更亮。"',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback blockquote").textContent',
        ),
        '光线好会让房间显得更亮。',
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 0);
      assert.equal(await evaluate('window.studyPlanWrites.length'), 0);
      await evaluate(`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(document.querySelector('#sentence-translation-0-answer'), '先读懂，再自己翻译。');
        document.querySelector('#sentence-translation-0-answer').dispatchEvent(new Event('input', { bubbles: true }));
        window.holdNextTranslationFeedback = true; ${translationSubmit}.click()`);
      await until('window.readingTranslationRequests.length === 4');
      await capture('reading-translation-prior-submission-1440.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      const translationRevision390 = await evaluate(`(() => {
        const panel = document.querySelector('#sentence-translation-0').getBoundingClientRect();
        const feedback = document.querySelector('#sentence-translation-0 .sentence-rewrite-feedback').getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, panelLeft: panel.left, panelRight: panel.right, feedbackRight: feedback.right };
      })()`);
      assert.ok(
        translationRevision390.viewport === 390 &&
          translationRevision390.scrollWidth <= 390 &&
          translationRevision390.panelLeft >= 0 &&
          translationRevision390.panelRight <= 391 &&
          translationRevision390.feedbackRight <= 391,
        JSON.stringify(translationRevision390),
      );
      await capture('reading-translation-prior-submission-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(`${translationToggle}.click()`);
      assert.equal(await evaluate(`${translationPanel}.hidden`), true);
      await evaluate(
        `window.readingTranslationResolvers.shift()(Response.json({ meaning: '迟到的结果', naturalness: '不应显示' }))`,
      );
      await delay(80);
      await evaluate(`${translationToggle}.click()`);
      await until(`!${translationPanel}.hidden`);
      assert.equal(
        await evaluate('document.querySelector("#sentence-translation-0-answer").value'),
        '先读懂，再自己翻译。',
      );
      assert.notEqual(
        await evaluate(
          'Boolean(document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback"))',
        ),
        false,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback blockquote").textContent',
        ),
        '光线好会让房间显得更亮。',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#sentence-translation-0 .sentence-rewrite-feedback").innerText.includes("迟到的结果")',
        ),
        false,
      );
      assert.equal(await evaluate('window.readingTranslationRequests.length'), 4);
      const wordUseMobile = await evaluate(`(() => {
        const panel = document.querySelector('.sentence-word-use-panel').getBoundingClientRect();
        const input = document.querySelector('#reading-word-use-practice-answer').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, left: panel.left, right: panel.right, inputRight: input.right };
      })()`);
      await capture('word-use-feedback-1440.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      const wordUse390 = await evaluate(`(() => {
        const panel = document.querySelector('.sentence-word-use-panel').getBoundingClientRect();
        const input = document.querySelector('#reading-word-use-practice-answer').getBoundingClientRect();
        const sidebar = document.querySelector('.study-sidebar').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, left: panel.left, right: panel.right, inputRight: input.right, sidebarRight: sidebar.right };
      })()`);
      assert.equal(wordUse390.viewport, 390);
      assert.ok(
        wordUse390.page <= 390 &&
          wordUse390.left >= 0 &&
          wordUse390.right <= 391 &&
          wordUse390.inputRight <= 391 &&
          wordUse390.sidebarRight <= 1,
        JSON.stringify(wordUse390),
      );
      await capture('word-use-feedback-390.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.ok(
        wordUseMobile.page <= wordUseMobile.viewport &&
          wordUseMobile.left >= 0 &&
          wordUseMobile.right <= wordUseMobile.viewport &&
          wordUseMobile.inputRight <= wordUseMobile.viewport,
        JSON.stringify(wordUseMobile),
      );
      await evaluate(
        `document.querySelector('.sentence-tools button[aria-label="换种说法第 1 句"]').click()`,
      );
      await until('!document.querySelector(".sentence-rewrite-panel").hidden');
      assert.equal(
        await evaluate('document.querySelector("#reading-word-use-practice").hidden'),
        true,
      );
      const rewriteDesktop = await evaluate(`(() => {
        const panel = document.querySelector('.sentence-rewrite-panel').getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: panel.left, right: panel.right, width: panel.width };
      })()`);
      assert.ok(
        rewriteDesktop.scrollWidth <= rewriteDesktop.viewport,
        JSON.stringify(rewriteDesktop),
      );
      assert.ok(
        rewriteDesktop.left >= 0 && rewriteDesktop.right <= rewriteDesktop.viewport,
        JSON.stringify(rewriteDesktop),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      const rewriteMobile = await evaluate(`(() => {
        const panel = document.querySelector('.sentence-rewrite-panel').getBoundingClientRect();
        const field = document.querySelector('#sentence-rewrite-0-answer').getBoundingClientRect();
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, panelLeft: panel.left, panelRight: panel.right, fieldRight: field.right, fieldWidth: field.width };
      })()`);
      assert.ok(rewriteMobile.scrollWidth <= 390, JSON.stringify(rewriteMobile));
      assert.ok(
        rewriteMobile.panelLeft >= 0 && rewriteMobile.panelRight <= 391,
        JSON.stringify(rewriteMobile),
      );
      assert.ok(
        rewriteMobile.fieldWidth > 0 && rewriteMobile.fieldRight <= 391,
        JSON.stringify(rewriteMobile),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
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
      await evaluate(`window.studySpeech.voices = [{ lang: 'en-US', name: 'Remote English', localService: false }];
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until(
        'document.querySelector(".reading-speech-status")?.textContent.includes("标记为本地服务")',
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
      const apiCallsBeforeMobileSpeech = await evaluate('window.apiFetchLog.length');
      await evaluate(`window.studySpeech.voices = [
          { lang: 'zh-CN', name: 'Fixture Chinese' },
          { lang: 'en-US', name: 'Fixture English', localService: true },
        ];
        document.querySelector('button[aria-label="朗读全文"]').click()`);
      await until('document.querySelector(".reading-speech-status")?.textContent === ""');
      assert.equal(await evaluate('window.apiFetchLog.length'), apiCallsBeforeMobileSpeech);
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
      const apiFetchesBeforeKeyboardAnswer = await evaluate('window.apiFetchLog.length');
      // A 195 CSS px viewport at DPR 2 represents a 390 px narrow screen at 200% zoom.
      await send('Emulation.setDeviceMetricsOverride', {
        width: 195,
        height: 422,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      await evaluate('document.querySelector(".answer-options button").focus()');
      await pressKey('Enter', 'Enter', 13, '\r');
      await until(
        'document.querySelector(".answer-options button.selected") && document.activeElement.matches(".question-answer[role=status]")',
      );
      assert.equal(
        await evaluate('document.activeElement.matches(".question-answer[role=status]")'),
        true,
        'keyboard selection moves focus to the answer status after its option becomes disabled',
      );
      assert.equal(
        await evaluate('window.apiFetchLog.length'),
        apiFetchesBeforeKeyboardAnswer,
        'moving answer focus and recording the local draft do not add an API request',
      );
      assert.deepEqual(
        await evaluate(`(() => {
          const style = getComputedStyle(document.activeElement);
          return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
        })()`),
        { outlineStyle: 'solid', outlineWidth: '3px', outlineColor: 'rgb(255, 131, 81)' },
        'the focused answer status has a visible brand-colored focus indicator',
      );
      await capture('study-answer-keyboard-200-percent.png');
      const answerKeyboardLayout = await evaluate(`(() => {
        const status = document.querySelector('.question-answer').getBoundingClientRect();
        const topbar = document.querySelector('.study-topbar').getBoundingClientRect();
        const updates = document.querySelector('.topbar-actions a[href="/updates"]');
        const account = document.querySelector('.topbar-account');
        const updatesRect = updates.getBoundingClientRect();
        const accountRect = account.getBoundingClientRect();
        const overflow = [...document.querySelectorAll('body *')].map((element) => {
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', left: Math.round(rect.left), right: Math.round(rect.right), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        }).filter((element) => element.right > innerWidth + 1 || element.left < -1).sort((a, b) => b.right - a.right).slice(0, 8);
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth, left: status.left, right: status.right, width: status.width, topbar: { left: topbar.left, right: topbar.right, height: topbar.height, updatesLeft: updatesRect.left, updatesRight: updatesRect.right, updatesDisplay: getComputedStyle(updates).display, accountLeft: accountRect.left, accountRight: accountRect.right, accountDisplay: getComputedStyle(account).display }, overflow };
      })()`);
      assert.equal(answerKeyboardLayout.viewport, 195);
      assert.ok(
        answerKeyboardLayout.page <= answerKeyboardLayout.viewport,
        JSON.stringify(answerKeyboardLayout),
      );
      assert.ok(
        answerKeyboardLayout.left >= 0 && answerKeyboardLayout.right <= 195,
        JSON.stringify(answerKeyboardLayout),
      );
      assert.ok(
        answerKeyboardLayout.topbar.left >= 0 &&
          answerKeyboardLayout.topbar.right <= 195 &&
          answerKeyboardLayout.topbar.updatesDisplay !== 'none' &&
          answerKeyboardLayout.topbar.accountDisplay !== 'none' &&
          answerKeyboardLayout.topbar.updatesLeft >= answerKeyboardLayout.topbar.left &&
          answerKeyboardLayout.topbar.updatesRight <= answerKeyboardLayout.topbar.right &&
          answerKeyboardLayout.topbar.accountLeft >= answerKeyboardLayout.topbar.left &&
          answerKeyboardLayout.topbar.accountRight <= answerKeyboardLayout.topbar.right,
        JSON.stringify(answerKeyboardLayout),
      );
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.matches(".lesson-draft-clear")'),
        true,
        'Tab moves from the answer status to the draft action',
      );
      await pressKey('Tab', 'Tab', 9);
      assert.equal(
        await evaluate('document.activeElement.matches(".lesson-draft-actions .check-matches")'),
        true,
        'Tab reaches the group submit control after the draft action',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
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

      await send('Emulation.setDeviceMetricsOverride', {
        width: 195,
        height: 422,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 1');
      await evaluate(`(() => {
        const longWord = 'antidisestablishmentarianism'.repeat(12);
        document.querySelector('.answer-options button').textContent = longWord;
        document.querySelector('.question-answer').textContent = '正确答案：' + longWord;
        document.querySelector('.question-explanation').textContent = '解析：' + longWord + '。这里继续一段较长的中文解释，说明词义、搭配和句中线索。'.repeat(8);
        document.querySelector('.answer-feedback').textContent = '回答错误。' + longWord;
        document.querySelector('.exercise-card').scrollIntoView({ block: 'start' });
      })()`);
      await capture('study-feedback-200-percent-long-text.png');
      await evaluate(
        'document.querySelector(".question-explanation").scrollIntoView({ block: "center" })',
      );
      await capture('study-feedback-explanation-200-percent.png');
      const longTextLayout = await evaluate(`(() => {
        const selectors = ['.exercise-card', '.answer-options button', '.question-answer', '.question-explanation', '.answer-feedback'];
        const boxes = Object.fromEntries(selectors.map((selector) => {
          const element = document.querySelector(selector);
          const rect = element.getBoundingClientRect();
          return [selector, { left: rect.left, right: rect.right, width: rect.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }];
        }));
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth, boxes };
      })()`);
      assert.equal(longTextLayout.viewport, 195);
      assert.ok(longTextLayout.page <= longTextLayout.viewport, JSON.stringify(longTextLayout));
      assert.ok(longTextLayout.body <= longTextLayout.viewport, JSON.stringify(longTextLayout));
      for (const [selector, box] of Object.entries(longTextLayout.boxes)) {
        assert.ok(
          box.left >= 0 && box.right <= longTextLayout.viewport + 1,
          `${selector}: ${JSON.stringify(box)}`,
        );
        assert.ok(
          box.scrollWidth <= box.clientWidth + 1,
          `${selector}: text overflows its box: ${JSON.stringify(box)}`,
        );
      }
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });

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
      await until(
        '[...document.querySelector(".group-settlement").getAnimations()].every((animation) => animation.playState === "finished")',
      );
      await capture('existing-learner-settlement-desktop.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until(
        '!document.querySelector(".study-sidebar").classList.contains("is-open") && new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".study-sidebar")).transform).m41 <= -219',
      );
      const settlementMobileLayout = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.settlement-card')].map((card) => {
          const rect = card.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        });
        const action = document.querySelector('.settlement-mistakes-link').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, cards,
          actionLeft: action.left, actionRight: action.right, actionWidth: action.width };
      })()`);
      assert.ok(
        settlementMobileLayout.page <= settlementMobileLayout.viewport &&
          settlementMobileLayout.cards.every(
            ({ left, right }) => left >= 0 && right <= settlementMobileLayout.viewport,
          ) &&
          settlementMobileLayout.actionLeft >= 0 &&
          settlementMobileLayout.actionRight <= settlementMobileLayout.viewport &&
          settlementMobileLayout.actionWidth > 0,
        JSON.stringify(settlementMobileLayout),
      );
      await capture('existing-learner-settlement-mobile.png');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
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

      // Walk a newly created plan all the way to its first question. The
      // create response is GENERATING; the mocked generation response is
      // fixture content, so this path never calls a real model.
      await evaluate(`(() => {
        const firstQuestion = {
          bookWordId: 'book-b-word-1',
          type: 'MEANING_RECOGNITION',
          prompt: 'In the sentence, what does “adapt” mean?',
          options: ['适应', '拒绝'],
        };
        const secondQuestion = {
          bookWordId: 'book-b-word-2',
          type: 'MEANING_RECOGNITION',
          prompt: 'In the sentence, what does “consider” mean?',
          options: ['考虑', '忽略'],
        };
        const plan = {
          id: 'first-plan-book-b', mode: 'group', purpose: 'normal', status: 'GENERATING',
          blocksNewPlanCreation: true, wordCount: 2, groupCount: 2, completed: 0,
          createdAt: new Date().toISOString(), completedAt: null, generatedAt: null,
          generationStartedAt: null, generationError: null, content: null,
          words: [
            { id: 'book-b-word-1', word: 'adapt', part: 'vt.', meaning: '适应', source: 'NEW', groupIndex: 0, completed: false, nextReviewAt: null, activeWeaknesses: [], question: null },
            { id: 'book-b-word-2', word: 'consider', part: 'vt.', meaning: '考虑', source: 'NEW', groupIndex: 1, completed: false, nextReviewAt: null, activeWeaknesses: [], question: null },
          ],
          summary: { totalQuestions: 0, correctQuestions: 0, durationSeconds: 0, typeStats: [] },
        };
        window.firstPlanGeneratingResponse = plan;
        window.firstPlanActiveResponse = {
          ...plan,
          status: 'ACTIVE',
          generatedAt: new Date().toISOString(),
          words: [
            { ...plan.words[0], question: firstQuestion },
            { ...plan.words[1], question: secondQuestion },
          ],
          content: { groups: [
            { index: 0, title: 'A new routine', wordOccurrences: { adapt: 1 },
              sentences: [{ english: 'People adapt to new routines.', chinese: '人们会适应新的日常安排。', simplified: '人们会适应新的安排。', grammar: 'adapt to 表示适应某种变化。' }],
              questions: [firstQuestion] },
            { index: 1, title: 'A careful choice', wordOccurrences: { consider: 1 },
              sentences: [{ english: 'Please consider the options.', chinese: '请考虑这些选项。', simplified: '请想想这些选择。', grammar: 'consider 后可直接接名词。' }],
              questions: [secondQuestion] },
          ] },
        };
        window.firstPlanGenerationAttempts = [];
        window.firstPlanJourney = true;
        window.delayFirstPlanJourneyCreate = true;
      })()`);
      await evaluate(
        '[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes("单词列表")).click()',
      );
      if ((await evaluate('window.defaultBook?.id')) !== 'book-b') {
        await evaluate('document.querySelector(".switch-book").click()');
        await until('document.querySelector(".book-drawer")');
        await until(
          '[...document.querySelectorAll(".book-choice")].some((card) => card.textContent.includes("Book B"))',
        );
        await evaluate(
          '[...document.querySelectorAll(".book-choice")].find((card) => card.textContent.includes("Book B")).querySelector("button").click()',
        );
      }
      await until(
        'document.querySelector(".words-load-error") || [...document.querySelectorAll(".word-row strong")].map((node) => node.textContent).join(",") === "adapt,consider"',
      );
      if (await evaluate('Boolean(document.querySelector(".words-load-error"))')) {
        await evaluate('document.querySelector(".words-load-error button").click()');
      }
      await until(
        '[...document.querySelectorAll(".word-row strong")].map((node) => node.textContent).join(",") === "adapt,consider"',
      );
      await until('!document.querySelector(".create").disabled');
      await evaluate(`document.querySelector(".create").click();
        document.querySelector(".create").click();`);
      await until('window.studyPlanCreateAttempts.length === 1');
      assert.equal(await evaluate('window.studyPlanCreateResolvers.length'), 1);
      assert.equal(await evaluate('document.querySelector(".create").disabled'), true);
      assert.deepEqual(await evaluate('window.studyPlanCreateAttempts[0]'), {
        newWordCount: 2,
        reviewWordCount: 0,
        mode: 'group',
      });
      await evaluate('document.querySelector(".switch-book").click()');
      await until('document.querySelector(".book-drawer")');
      await until(
        '[...document.querySelectorAll(".book-choice")].some((card) => card.textContent.includes("Book A"))',
      );
      await evaluate(
        '[...document.querySelectorAll(".book-choice")].find((card) => card.textContent.includes("Book A")).querySelector("button").click()',
      );
      await until('window.defaultBook?.id === "book-a"');
      await until(
        '[...document.querySelectorAll(".word-row strong")].map((node) => node.textContent).join(",") === "take"',
      );
      await evaluate(
        'window.resolveStudyPlanCreate(Response.json(window.firstPlanGeneratingResponse))',
      );
      await until(
        'document.querySelector(".plan-preview-layer") && window.firstPlanGenerationAttempts.length === 1',
      );
      assert.equal(await evaluate('window.defaultBook?.id'), 'book-a');
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".word-row strong")].map((node) => node.textContent)',
        ),
        ['take'],
        'the delayed Book B plan response must not replace the newly selected Book A words',
      );
      assert.equal(
        await evaluate('document.querySelector(".preview-word-title strong")?.textContent'),
        'adapt',
        'the already-created Book B plan remains available for recovery',
      );
      assert.deepEqual(await evaluate('window.firstPlanGenerationAttempts'), ['first-plan-book-b']);
      await until(
        'document.querySelector(".plan-preview .start-challenge")?.textContent.includes("开始今天的挑战") && !document.querySelector(".plan-preview .start-challenge").disabled',
      );
      await evaluate('document.querySelector(".plan-preview .start-challenge").click()');
      await until('document.querySelector(".lesson-page .answer-options button")');
      assert.equal(
        await evaluate('document.querySelector(".lesson-page").innerText.includes("adapt")'),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".lesson-page").innerText.includes("In the sentence, what does “adapt” mean?")',
        ),
        true,
      );
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".lesson-page .answer-options button")].map((button) => button.textContent.trim())',
        ),
        ['适应', '拒绝'],
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
