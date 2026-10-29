import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'learning lab quiz selections survive refresh, stay account scoped, and clear after submission',
  { skip: !baseUrl, timeout: 90_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-learning-lab-draft-'));
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
            // Reload replaces the JavaScript context briefly.
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
      const verifyLayout = async (width, height, mobile) => {
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile,
        });
        await delay(100);
        const layout = await evaluate(
          `(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, questions: new Set(Array.from(document.querySelectorAll('input[type=radio]'), (input) => input.name)).size }))()`,
        );
        assert.equal(layout.document, layout.viewport, JSON.stringify(layout));
        assert.equal(layout.body, layout.viewport, JSON.stringify(layout));
        assert.equal(layout.questions, 3);
        return layout;
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
          const sessionKey = 'lexloop.session';
          if (!localStorage.getItem(sessionKey)) localStorage.setItem(sessionKey, JSON.stringify({ accessToken: 'learner-a-token', user: { id: 'learner-a', email: 'learner-a@example.invalid', displayName: 'Learner A', role: 'USER' } }));
          window.labDraftFixture = { unexpected: [], apiCalls: [], failHistoryPageOneOnce: location.search.includes('fail-history-first') && sessionStorage.getItem('__lab_history_initial_failure') !== '1', failHistoryPageTwoOnce: false, storageKeys: () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean) };
          const lessonId = 'lesson-draft-fixture';
          const questionRows = [
            { id: 'q1', prompt: 'Choose the best reply.', options: ['That works for me.', 'At noon yesterday.', 'Blue is a color.'], correctIndex: 0, explanation: 'works for me 表示同意安排。' },
            { id: 'q2', prompt: 'Choose the natural phrase.', options: ['make a decision', 'do a decision', 'build a decision'], correctIndex: 0, explanation: '英语中通常说 make a decision。' },
            { id: 'q3', prompt: 'Choose the closest meaning.', options: ['calm', 'crowded', 'expensive'], correctIndex: 1, explanation: 'crowded 表示人或物很多。' },
          ];
          const savedAnswersKey = (token) => '__learning_lab_fixture_answers_' + token;
          const currentUser = () => localStorage.getItem(sessionKey) ? JSON.parse(localStorage.getItem(sessionKey)).user.id : 'unknown';
          const token = () => localStorage.getItem(sessionKey) ? JSON.parse(localStorage.getItem(sessionKey)).accessToken : '';
          const savedAnswers = () => { try { const value = localStorage.getItem(savedAnswersKey(token())); return value ? JSON.parse(value) : null; } catch { return null; } };
          const lesson = () => {
            const answers = savedAnswers();
            return {
              id: lessonId, kind: 'GRAMMAR', status: 'READY',
              content: { title: 'A small scheduling change', introduction: 'Read the exchange and choose a natural response.', sentences: [], targets: [], topics: [], questions: questionRows.map(({ correctIndex, explanation, ...question }) => answers ? { ...question, correctIndex, explanation } : question) },
              evidence: [], answers, score: answers ? 67 : null, error: null,
              createdAt: '2026-10-28T08:00:00.000Z', submittedAt: answers ? '2026-10-28T08:10:00.000Z' : null,
            };
          };
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (path.startsWith('/api/v1/')) window.labDraftFixture.apiCalls.push({ path, method: options.method || 'GET' });
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: currentUser() });
            if (path.includes('/api/v1/learning-lab/grammar-evidence')) return Response.json([]);
            if (path.includes('/api/v1/learning-lab/lessons?')) {
              const page = Number(new URL(path, location.origin).searchParams.get('page') || 1);
              if (page === 1 && window.labDraftFixture.failHistoryPageOneOnce) {
                window.labDraftFixture.failHistoryPageOneOnce = false;
                sessionStorage.setItem('__lab_history_initial_failure', '1');
                return Response.json({ message: '模拟首次练习历史读取失败' }, { status: 503 });
              }
              if (page === 2 && window.labDraftFixture.failHistoryPageTwoOnce) {
                window.labDraftFixture.failHistoryPageTwoOnce = false;
                return Response.json({ message: '模拟练习历史分页失败' }, { status: 503 });
              }
              const pageLesson = page === 1 ? lesson() : {
                ...lesson(), id: 'lesson-history-page-two',
                content: { ...lesson().content, title: 'A different scheduling lesson' },
              };
              return Response.json({ items: [pageLesson], hasMore: page === 1 });
            }
            if (path.includes('/api/v1/learning-lab/lessons/' + lessonId + '/answers')) {
              const requestBody = JSON.parse(options.body);
              const answerLogs = JSON.parse(localStorage.getItem('__learning_lab_fixture_logs') || '[]');
              answerLogs.push({ token: token(), answers: requestBody.answers });
              localStorage.setItem('__learning_lab_fixture_logs', JSON.stringify(answerLogs));
              if (answerLogs.filter((entry) => entry.token === token()).length === 1) {
                return Response.json({ message: '模拟交卷暂时失败' }, { status: 503 });
              }
              localStorage.setItem(savedAnswersKey(token()), JSON.stringify(requestBody.answers));
              return Response.json(lesson());
            }
            if (path.startsWith('/api/v1/')) {
              window.labDraftFixture.unexpected.push(path);
              return Response.json({ message: 'unexpected fixture API request: ' + path }, { status: 404 });
            }
            return nativeFetch(url, options);
          };
        `,
      });

      const historySection = 'document.querySelector("[aria-label=学习历史]")';
      const url = new URL('/dashboard/notebook?tab=grammar&fail-history-first=1', baseUrl).href;
      await send('Page.navigate', { url });
      await until(
        'document.querySelector("[aria-label=学习历史] [role=alert]")?.innerText.includes("模拟首次练习历史读取失败")',
      );
      assert.equal(await evaluate(`${historySection}.innerText.includes("正在读取历史")`), false);
      assert.equal(
        await evaluate(`${historySection}.innerText.includes("第一份练习会保存在这里")`),
        false,
      );
      const historyReadsAfterInitialFailure = await evaluate(
        'window.labDraftFixture.apiCalls.filter(({ path }) => path.includes("/api/v1/learning-lab/lessons?")).length',
      );
      await evaluate(`${historySection}.querySelector('[role="alert"] button').click()`);
      await until("document.querySelector('input[type=radio]')");
      assert.equal(
        await evaluate(
          'window.labDraftFixture.apiCalls.filter(({ path }) => path.includes("/api/v1/learning-lab/lessons?")).length',
        ),
        historyReadsAfterInitialFailure + 1,
      );
      assert.equal(
        await evaluate('document.querySelectorAll("fieldset input[type=radio]").length'),
        9,
      );
      assert.equal(await evaluate('localStorage.getItem("__learning_lab_fixture_logs")'), null);

      assert.equal(
        await evaluate(`${historySection}.innerText.includes("A small scheduling change")`),
        true,
      );
      const historyReadsBeforeFailure = await evaluate(
        'window.labDraftFixture.apiCalls.filter(({ path }) => path.includes("/api/v1/learning-lab/lessons?")).length',
      );
      await evaluate(`(() => {
        window.labDraftFixture.failHistoryPageTwoOnce = true;
        document.querySelector('[aria-label="练习记录分页"] button:last-child').click();
      })()`);
      await until(
        'document.querySelector("[aria-label=学习历史] [role=alert]")?.innerText.includes("模拟练习历史分页失败")',
      );
      assert.equal(
        await evaluate(`${historySection}.innerText.includes("A small scheduling change")`),
        false,
      );
      assert.equal(
        await evaluate(`${historySection}.innerText.includes("第一份练习会保存在这里")`),
        false,
      );
      assert.equal(await evaluate(`${historySection}.innerText.includes("第 2 页")`), true);
      assert.equal(
        await evaluate(
          'window.labDraftFixture.apiCalls.filter(({ path }) => path.includes("/api/v1/learning-lab/lessons?")).length',
        ),
        historyReadsBeforeFailure + 1,
      );
      await evaluate(`${historySection}.querySelector('[role="alert"] button').click()`);
      await until(`${historySection}.innerText.includes("A different scheduling lesson")`);
      assert.equal(
        await evaluate(`${historySection}.innerText.includes("A small scheduling change")`),
        false,
      );
      assert.equal(
        await evaluate(
          'window.labDraftFixture.apiCalls.filter(({ path }) => path.includes("/api/v1/learning-lab/lessons?")).length',
        ),
        historyReadsBeforeFailure + 2,
      );
      await evaluate(
        `${historySection}.querySelector('[aria-label="练习记录分页"] button:first-child').click()`,
      );
      await until(`${historySection}.innerText.includes("A small scheduling change")`);

      const apiCallsBeforeSelection = await evaluate('window.labDraftFixture.apiCalls.length');
      await evaluate(
        `document.querySelector('input[name="lesson-draft-fixture-q1"][value="1"]').click()`,
      );
      await until('document.querySelector("input[type=radio]:checked")');
      assert.equal(
        await evaluate(
          'window.labDraftFixture.storageKeys().some((key) => key.startsWith("lexloop.learning-lab.quiz.learner-a."))',
        ),
        true,
      );
      assert.equal(await evaluate('localStorage.getItem("__learning_lab_fixture_logs")'), null);
      assert.equal(await evaluate('document.body.innerText.includes("本次得分：")'), false);
      assert.equal(
        await evaluate('window.labDraftFixture.apiCalls.length'),
        apiCallsBeforeSelection,
      );
      const draftStorageLength = await evaluate(
        'localStorage.getItem(window.labDraftFixture.storageKeys().find((key) => key.startsWith("lexloop.learning-lab.quiz.learner-a."))).length',
      );
      assert.ok(draftStorageLength < 256, `draft snapshot was ${draftStorageLength} characters`);
      const desktopLayout = await verifyLayout(1440, 900, false);

      await evaluate('document.querySelector(".quiz-draft-discard")?.click()');
      await until('document.querySelectorAll("input[type=radio]:checked").length === 0');
      assert.equal(
        await evaluate(
          'window.labDraftFixture.storageKeys().some((key) => key.startsWith("lexloop.learning-lab.quiz.learner-a."))',
        ),
        false,
      );
      await evaluate(
        `document.querySelector('input[name="lesson-draft-fixture-q1"][value="1"]').click()`,
      );
      await until('document.querySelector("input[type=radio]:checked")');

      await send('Page.reload');
      await until('document.querySelector("input[type=radio]:checked")');
      assert.equal(
        await evaluate('document.querySelector("input[type=radio]:checked").value'),
        '1',
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("已恢复这份练习尚未提交的选择")'),
        true,
      );
      assert.equal(await evaluate('localStorage.getItem("__learning_lab_fixture_logs")'), null);
      const mobileDraftLayout = await verifyLayout(390, 844, true);

      await evaluate(
        `localStorage.setItem(${JSON.stringify('lexloop.session')}, JSON.stringify({ accessToken: 'learner-b-token', user: { id: 'learner-b', email: 'learner-b@example.invalid', displayName: 'Learner B', role: 'USER' } }))`,
      );
      await send('Page.reload');
      await until("document.querySelector('input[type=radio]')");
      await until('!document.body.innerText.includes("正在检查本机练习草稿")');
      assert.equal(
        await evaluate('document.querySelectorAll("input[type=radio]:checked").length'),
        0,
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("已恢复这份练习尚未提交的选择")'),
        false,
      );
      assert.equal(
        await evaluate(
          'window.labDraftFixture.storageKeys().some((key) => key.startsWith("lexloop.learning-lab.quiz.learner-b."))',
        ),
        false,
      );

      await evaluate(
        `localStorage.setItem(${JSON.stringify('lexloop.session')}, JSON.stringify({ accessToken: 'learner-a-token', user: { id: 'learner-a', email: 'learner-a@example.invalid', displayName: 'Learner A', role: 'USER' } }))`,
      );
      await send('Page.reload');
      await until('document.querySelector("input[type=radio]:checked")');
      assert.equal(
        await evaluate('document.querySelector("input[type=radio]:checked").value'),
        '1',
      );
      await verifyLayout(1440, 900, false);

      await evaluate(
        `document.querySelector('input[name="lesson-draft-fixture-q2"][value="0"]').click()`,
      );
      await evaluate(
        `document.querySelector('input[name="lesson-draft-fixture-q3"][value="1"]').click()`,
      );
      await until(
        '[...document.querySelectorAll("button")].some((button) => button.textContent.includes("交卷并查看解析") && !button.disabled)',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("交卷并查看解析")).click()',
      );
      await until('document.body.innerText.includes("模拟交卷暂时失败")');
      assert.equal(
        await evaluate('document.querySelectorAll("input[type=radio]:checked").length'),
        3,
      );
      assert.equal(await evaluate('document.body.innerText.includes("本次得分：")'), false);
      assert.equal(
        await evaluate(
          'window.labDraftFixture.storageKeys().some((key) => key.startsWith("lexloop.learning-lab.quiz.learner-a."))',
        ),
        true,
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("交卷并查看解析")).click()',
      );
      await until('document.body.innerText.includes("本次得分：67 / 100")');
      assert.equal(
        JSON.stringify(
          await evaluate('JSON.parse(localStorage.getItem("__learning_lab_fixture_logs"))'),
        ),
        JSON.stringify([
          { token: 'learner-a-token', answers: [1, 0, 1] },
          { token: 'learner-a-token', answers: [1, 0, 1] },
        ]),
      );
      assert.equal(
        await evaluate(
          'window.labDraftFixture.storageKeys().some((key) => key.startsWith("lexloop.learning-lab.quiz.learner-a."))',
        ),
        false,
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("已恢复这份练习尚未提交的选择")'),
        false,
      );
      const mobileResultLayout = await verifyLayout(390, 844, true);
      console.log(
        `learning lab quiz layout: desktop ${desktopLayout.viewport}px, mobile draft ${mobileDraftLayout.viewport}px, mobile result ${mobileResultLayout.viewport}px; draft ${draftStorageLength} characters`,
      );
      assert.deepEqual(await evaluate('window.labDraftFixture.unexpected'), []);
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
