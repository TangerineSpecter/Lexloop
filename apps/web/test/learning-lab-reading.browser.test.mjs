import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'reading practice keeps answers hidden until a successful submission and fits desktop and mobile',
  { skip: !baseUrl, timeout: 90_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-reading-practice-'));
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
    const browserErrors = [];
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
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation can briefly replace the document context.
          }
          await delay(100);
        }
        const state = await evaluate(
          '({ path: location.pathname, text: document.body.innerText.slice(-1000) })',
        ).catch(() => null);
        assert.fail(`Timed out waiting for ${expression}; state=${JSON.stringify(state)}`);
      };
      const layoutAt = async (width, height, mobile) => {
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile,
        });
        await delay(100);
        return evaluate(`(() => {
          const rect = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const box = node.getBoundingClientRect();
            return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
          };
          return {
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            lesson: rect('article'),
            quiz: rect('[aria-label="读后小测"]'),
          };
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
          const sessionKey = 'lexloop.session';
          localStorage.setItem(sessionKey, JSON.stringify({ accessToken: 'reading-fixture-token', user: { id: 'reading-fixture-user', email: 'reader@example.invalid', displayName: 'Fixture Reader', role: 'USER' } }));
          window.readingFixture = { unexpected: [], requests: [], createBody: null, submissions: [], savedAnswers: null, holdAnswer: false, releaseAnswer: null };
          const lessonId = 'reading-fixture-lesson';
          const notebookWords = [
            { id: 'wordupdate', wordId: 'word-record-update', text: 'update', type: 'WORD', meaning: '情况更新', example: 'Please send a quick update.', sourceScenario: 'fixture', sourceType: 'MANUAL', state: 'REVIEWING', nextReviewAt: null },
            { id: 'wordlongrun', wordId: 'word-record-long-run', text: 'in the long run', type: 'PHRASE', meaning: '从长远来看', example: 'It will help in the long run.', sourceScenario: 'fixture', sourceType: 'MANUAL', state: 'REVIEWING', nextReviewAt: null },
          ];
          const publicQuestions = [
            { id: 'main-idea', prompt: 'Why did Maya move the meeting?', options: ['Her train was delayed.', 'She forgot the address.', 'The room was too small.'] },
            { id: 'phrase-meaning', prompt: 'What does “in the long run” mean here?', options: ['Over a longer period.', 'Before the trip.', 'Only for one day.'] },
            { id: 'detail', prompt: 'What did Maya send before leaving?', options: ['A short update.', 'A new contract.', 'A train ticket.'] },
          ];
          const fullQuestions = [
            { ...publicQuestions[0], correctIndex: 0, explanation: '文中说明火车延误，所以 Maya 改了时间。' },
            { ...publicQuestions[1], correctIndex: 0, explanation: '这里的 in the long run 指经过较长时间后。' },
            { ...publicQuestions[2], correctIndex: 0, explanation: '第二句提到她出发前发了一条简短更新。' },
          ];
          const content = (submitted) => ({
            title: 'A Change That Helped',
            introduction: 'Read the short story first, then answer from the details you remember.',
            sentences: [
              { english: 'Maya’s train was delayed, so she sent her teammate a quick update before leaving the station.', chinese: 'Maya 的火车晚点了，所以她离开车站前给队友发了一条简短更新。', note: 'so 连接原因与结果；a quick update 指简短的情况说明。' },
              { english: 'They moved the meeting by thirty minutes, which made the plan easier in the long run.', chinese: '他们把会议推迟了三十分钟，这让整个计划从长远来看更容易执行。', note: 'in the long run 表示“从长远来看”。' },
            ],
            targets: [ { id: 'target-update', text: 'update', meaning: '情况更新' }, { id: 'target-long-run', text: 'in the long run', meaning: '从长远来看' } ],
            topics: [],
            questions: submitted ? fullQuestions : publicQuestions,
          });
          const lesson = (submitted = false) => ({
            id: lessonId, kind: 'READING', status: 'READY', content: content(submitted), evidence: [],
            answers: submitted ? [0, 1, 0] : null, score: submitted ? 67 : null,
            error: null, createdAt: '2026-10-29T08:00:00.000Z',
            submittedAt: submitted ? '2026-10-29T08:12:00.000Z' : null,
          });
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (path.startsWith('/api/v1/')) window.readingFixture.requests.push({ path, method: options.method || 'GET' });
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'reading-fixture-user' });
            if (path.includes('/api/v1/vocabulary/notebook?')) {
              return Response.json({ items: notebookWords, hasMore: false, total: notebookWords.length });
            }
            if (path.includes('/api/v1/learning-lab/lessons?')) {
              return Response.json({ items: window.readingFixture.savedAnswers ? [lesson(true)] : [], hasMore: false });
            }
            if (path === '/api/v1/learning-lab/lessons' && options.method === 'POST') {
              window.readingFixture.createBody = JSON.parse(options.body);
              return Response.json(lesson(false));
            }
            if (path.includes('/api/v1/learning-lab/lessons/' + lessonId + '/answers')) {
              const answers = JSON.parse(options.body).answers;
              window.readingFixture.submissions.push(answers);
              if (window.readingFixture.submissions.length === 1) {
                return Response.json({ message: '模拟第一次交卷失败' }, { status: 503 });
              }
              if (window.readingFixture.holdAnswer) {
                return new Promise((resolve) => {
                  window.readingFixture.releaseAnswer = () => {
                    window.readingFixture.savedAnswers = answers;
                    resolve(Response.json(lesson(true)));
                  };
                });
              }
              window.readingFixture.savedAnswers = answers;
              return Response.json(lesson(true));
            }
            if (path.startsWith('/api/v1/')) {
              window.readingFixture.unexpected.push(path);
              return Response.json({ message: 'unexpected fixture API request: ' + path }, { status: 404 });
            }
            return nativeFetch(url, options);
          };
        `,
      });

      await send('Page.navigate', {
        url: new URL('/dashboard/notebook?tab=words', baseUrl).href,
      });
      await until('document.querySelectorAll("article[data-notebook-word]").length === 2');
      await evaluate(
        'document.querySelector("article[data-notebook-word=wordupdate] input[type=checkbox]").click()',
      );
      await until('document.body.innerText.includes("已选 1/6")');
      await evaluate(
        'document.querySelector("article[data-notebook-word=wordlongrun] input[type=checkbox]").click()',
      );
      await until('document.body.innerText.includes("已选 2/6")');
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("用选中词精读")).click()',
      );
      await until('document.body.innerText.includes("在短文里，再遇见生词")');
      await until('document.body.innerText.includes("已选 2/6 个词")');
      await until('document.body.innerText.includes("第一份练习会保存在这里")');
      const readingRoute = await evaluate(
        '({ tab: new URLSearchParams(location.search).get("tab"), words: new URLSearchParams(location.search).get("words") })',
      );
      assert.deepEqual(readingRoute, { tab: 'reading', words: 'wordupdate,wordlongrun' });
      const generateButton =
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("生成精读短文"))';
      assert.equal(await evaluate(`${generateButton}?.disabled`), false);
      await evaluate(`${generateButton}.click()`);
      await until('document.body.innerText.includes("A Change That Helped")');

      assert.deepEqual(await evaluate('window.readingFixture.createBody.wordIds'), [
        'wordupdate',
        'wordlongrun',
      ]);
      assert.equal(await evaluate('window.readingFixture.createBody.kind'), 'READING');
      assert.equal(await evaluate('window.readingFixture.createBody.level'), 'B1');
      assert.equal(await evaluate('document.querySelector("article section") !== null'), true);
      assert.equal(
        await evaluate('document.querySelector("article section mark")?.textContent'),
        'update',
      );
      assert.equal(await evaluate('document.querySelector("article details").open'), false);
      assert.equal(await evaluate('document.body.innerText.includes("so 连接原因与结果")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("文中说明火车延误")'), false);
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="读后小测"]').querySelectorAll('input[type=radio]').length`,
        ),
        9,
      );

      await evaluate('document.querySelector("article details summary").click()');
      await until('document.body.innerText.includes("Maya 的火车晚点了")');
      assert.equal(await evaluate('document.body.innerText.includes("so 连接原因与结果")'), true);

      const desktopLayout = await layoutAt(1440, 1000, false);
      assert.equal(desktopLayout.document, desktopLayout.viewport, JSON.stringify(desktopLayout));
      assert.equal(desktopLayout.body, desktopLayout.viewport, JSON.stringify(desktopLayout));
      assert.ok(desktopLayout.lesson.left >= 0 && desktopLayout.lesson.right <= 1440);
      assert.ok(desktopLayout.quiz.left >= 0 && desktopLayout.quiz.right <= 1440);

      await evaluate(`document.querySelectorAll('input[type="radio"]')[0].click()`);
      await evaluate(`document.querySelectorAll('input[type="radio"]')[4].click()`);
      await evaluate(`document.querySelectorAll('input[type="radio"]')[6].click()`);
      await until(
        `document.querySelector('[aria-label="读后小测"]').querySelectorAll('input[type="radio"]:checked').length === 3`,
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("交卷并查看解析")).click()',
      );
      await until('document.body.innerText.includes("模拟第一次交卷失败")');
      assert.deepEqual(await evaluate('window.readingFixture.submissions'), [[0, 1, 0]]);
      assert.equal(await evaluate('document.body.innerText.includes("本次得分：")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("✓ 正确答案")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("文中说明火车延误")'), false);
      assert.equal(
        await evaluate(
          `document.querySelector('[aria-label="读后小测"]').querySelectorAll('input[type="radio"]:checked').length`,
        ),
        3,
      );

      await evaluate('window.readingFixture.holdAnswer = true');
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("交卷并查看解析")).click()',
      );
      await until('typeof window.readingFixture.releaseAnswer === "function"');
      assert.equal(await evaluate('document.body.innerText.includes("正在交卷…")'), true);
      assert.equal(await evaluate('document.body.innerText.includes("本次得分：")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("✓ 正确答案")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("文中说明火车延误")'), false);
      await evaluate('window.readingFixture.releaseAnswer()');
      await until('document.body.innerText.includes("本次得分：67 / 100")');
      await until('document.querySelector("[aria-label=学习历史]").innerText.includes("67 分")');
      assert.equal(await evaluate('document.body.innerText.includes("✓ 正确答案")'), true);
      assert.equal(await evaluate('document.body.innerText.includes("文中说明火车延误")'), true);
      assert.equal(await evaluate('document.body.innerText.includes("从长远来看")'), true);
      assert.deepEqual(await evaluate('window.readingFixture.submissions'), [
        [0, 1, 0],
        [0, 1, 0],
      ]);

      const mobileLayout = await layoutAt(390, 844, true);
      assert.equal(mobileLayout.document, mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.equal(mobileLayout.body, mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.ok(mobileLayout.lesson.left >= 0 && mobileLayout.lesson.right <= 390);
      assert.ok(mobileLayout.quiz.left >= 0 && mobileLayout.quiz.right <= 390);
      console.log(
        `reading practice layout: desktop ${desktopLayout.viewport}px, mobile ${mobileLayout.viewport}px; ${desktopLayout.lesson.width}px reading, ${mobileLayout.quiz.width}px quiz; retry retained answers and feedback unlocked only after response`,
      );
      assert.deepEqual(await evaluate('window.readingFixture.unexpected'), []);
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
