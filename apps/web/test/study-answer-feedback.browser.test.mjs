import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
          `({ path: location.pathname, text: document.body.innerText.slice(-900) })`,
        ).catch(() => null);
        assert.fail(
          `Timed out waiting for ${expression}; state=${JSON.stringify({ pageState, browserErrors })}`,
        );
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
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
            return {
              id: 'plan-1', mode: 'group', purpose: 'normal', status: secondSubmitted ? 'COMPLETED' : 'ACTIVE',
              wordCount: 2, groupCount: 2, completed: completedGroups, createdAt: '2026-10-27T00:00:00.000Z',
              words: [
                { id: 'word-1', word: 'bright', part: 'adj.', meaning: '明亮的', groupIndex: 0,
                  question: firstSubmitted ? questionAfterSubmit : questionBeforeSubmit, completed: firstSubmitted, result: firstSubmitted ? false : undefined },
                { id: 'word-2', word: 'help', part: 'vt.', meaning: '帮助', groupIndex: 1,
                  question: secondSubmitted ? matchingAfterSubmit : matchingBeforeSubmit, completed: secondSubmitted, result: secondSubmitted ? false : undefined },
              ],
              content: { groups: [
                { index: 0, title: 'A bright morning', wordOccurrences: { bright: 1 },
                  sentences: [{ english: 'The bright room felt warm.', chinese: '明亮的房间让人感到温暖。', simplified: '明亮的房间很温暖。', grammar: 'bright 修饰 room。' }],
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
          window.studyPlanWrites = [];
          window.studySubmissionAttempts = [];
          window.studyAlerts = [];
          window.alert = (message) => window.studyAlerts.push(String(message));
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'study-user', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (!path.includes('/api/v1/')) return nativeFetch(url, options);
            const method = options.method ?? 'GET';
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'study-user' });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 1, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/ai/tutor/history')) return Response.json({ messages: [], hasMore: false });
            if (path.includes('/api/v1/study/plans/plan-1/groups/') && path.endsWith('/complete') && method === 'POST') {
              const groupIndex = Number(path.split('/groups/')[1].split('/')[0]);
              const body = JSON.parse(options.body);
              window.studySubmissionAttempts.push(body);
              if (window.studySubmissionAttempts.length === 1) return Response.json({ message: 'Fixture submission failed' }, { status: 503 });
              window.studyPlanWrites.push(body);
              window.studyPlanResponse = makePlan(groupIndex + 1);
              return Response.json(window.studyPlanResponse);
            }
            if (path.includes('/api/v1/study/plans')) return Response.json([window.studyPlanResponse]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            return Response.json({});
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
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
      const choiceState = await evaluate(`({
        buttonCount: document.querySelectorAll('.answer-options button').length,
        hasCard: Boolean(document.querySelector('.generated-question')),
        path: location.pathname,
        excerpt: document.body.innerText.slice(-700),
      })`);
      assert.ok(choiceState.buttonCount > 0, JSON.stringify({ ...choiceState, browserErrors }));
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

      await evaluate('[...document.querySelectorAll(".exercises .check-matches")].at(-1).click()');
      await until('document.querySelector(".answer-feedback")');
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
      assert.deepEqual(
        await evaluate(
          'window.studyPlanWrites[0].answers.map(({ bookWordId, selectedAnswer }) => ({ bookWordId, selectedAnswer }))',
        ),
        [{ bookWordId: 'word-1', selectedAnswer: ['暗的'] }],
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 2);
      assert.equal(await evaluate('window.studyPlanResponse.status'), 'ACTIVE');
      assert.equal(
        await evaluate(
          'window.studyPlanResponse.content.groups[1].questions[0].pairs[0].right === window.matchingOriginalPairs[0].right',
        ),
        false,
      );

      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("继续下一组")).click()',
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
      assert.match(
        await evaluate('document.querySelector(".answer-feedback").textContent'),
        /回答错误/,
      );
      assert.deepEqual(
        await evaluate('window.studyPlanWrites[1].answers[0].selectedAnswer.length'),
        4,
      );
      assert.equal(await evaluate('window.studySubmissionAttempts.length'), 3);

      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("查看今日总结")).click()',
      );
      await until('document.querySelector("#settlement-title")');
      assert.match(
        await evaluate('document.querySelector("#settlement-title").textContent'),
        /本组学习完成/,
      );
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
