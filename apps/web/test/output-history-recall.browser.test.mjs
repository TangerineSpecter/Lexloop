import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'past output feedback supports optional recall before reveal and keeps attempts page-local',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-output-history-test-'));
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
      { stdio: 'ignore' },
    );
    let launchError;
    let closed = false;
    browser.on('error', (error) => {
      launchError = error;
    });
    browser.on('close', () => {
      closed = true;
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
            // A navigation can briefly replace the page's JavaScript context.
          }
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };
      const target = (word, meaning, bookWordId) => ({ word, meaning, bookWordId });
      const feedback = (bookWordId, correctedText) => ({
        score: 72,
        grammarScore: 80,
        coherenceScore: 68,
        correctedText,
        comments: ['试着让句子里的因果关系更清楚。'],
        words: [
          { bookWordId, used: true, correct: true, feedback: '这个词在当前语境中使用恰当。' },
        ],
      });
      const makeHistoryItem = (id, answer, correctedText) => ({
        id,
        date: '2026-10-26',
        prompt: '写一段关于如何解决小问题的英文。',
        targets: [target('approach', '方法', `${id}-word`)],
        answer,
        status: 'COMPLETED',
        feedback: feedback(`${id}-word`, correctedText),
        error: null,
        createdAt: '2026-10-26T09:30:00.000Z',
      });
      const userAItems = [
        makeHistoryItem(
          'history-a',
          'I will approach the problem slowly.',
          'I will approach the problem more carefully.',
        ),
        makeHistoryItem(
          'history-a-second',
          'I need another approach for this issue.',
          'I need a different approach to this issue.',
        ),
      ];
      const userBItems = [
        makeHistoryItem('history-b', 'Account B saved answer.', 'Account B corrected answer.'),
      ];
      const daily = {
        id: 'today-challenge',
        date: '2026-10-27',
        prompt: '写一段关于一次旅行的英文。',
        targets: [target('journey', '旅程', 'today-word')],
        remaining: 3,
        submissions: [],
      };

      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture-a', user: { id: 'user-a', email: 'fixture-a@example.invalid', displayName: 'Fixture A', role: 'USER' } }));
          window.outputApiWrites = [];
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            const method = options.method ?? 'GET';
            if (path.includes('/api/v1/')) {
              if (method !== 'GET') {
                window.outputApiWrites.push({ method, path });
                return Response.json({ message: 'Unexpected write in history recall fixture' }, { status: 500 });
              }
              if (path.includes('/api/v1/auth/me')) {
                const user = JSON.parse(localStorage.getItem('lexloop.session') ?? '{}').user;
                return Response.json({ id: user?.id });
              }
              if (path.includes('/api/v1/practice/output/today')) return Response.json(${JSON.stringify(daily)});
              if (path.includes('/api/v1/practice/output/history')) {
                const user = JSON.parse(localStorage.getItem('lexloop.session') ?? '{}').user;
                return Response.json({ items: user?.id === 'user-b' ? ${JSON.stringify(userBItems)} : ${JSON.stringify(userAItems)}, hasMore: false });
              }
              if (path.includes('/api/v1/practice/confusion')) return Response.json([]);
              throw new Error('Unexpected API request in history recall fixture: ' + path);
            }
            return nativeFetch(url, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard/practice?tab=output', baseUrl).href });
      await until('document.querySelector("#output-answer")');

      const openHistory = async () => {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('查看过去的输出记录'));
          button?.click();
        })()`);
        await until('document.querySelectorAll("details").length >= 1');
      };
      const openFirstRecord = async () => {
        await evaluate('document.querySelectorAll("details")[0].open = true');
        await until('document.querySelector("#output-history-attempt-history-a")');
      };
      const typeFirstAttempt = async (value) =>
        evaluate(`(() => {
          const textarea = document.querySelector('#output-history-attempt-history-a');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(value)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);

      await openHistory();
      assert.equal(await evaluate('document.querySelectorAll("details").length'), 2);
      await openFirstRecord();
      assert.equal(
        await evaluate(
          'document.querySelector("#output-history-attempt-history-a").labels[0].textContent',
        ),
        '你的新版本',
      );
      const beforeReveal = await evaluate('document.body.innerText');
      assert.ok(beforeReveal.includes('写一段关于如何解决小问题的英文。'));
      assert.ok(beforeReveal.includes('approach'));
      assert.ok(!beforeReveal.includes('I will approach the problem slowly.'));
      assert.ok(!beforeReveal.includes('I will approach the problem more carefully.'));
      assert.ok(beforeReveal.includes('直接查看原记录'));

      await typeFirstAttempt('I could approach the problem from another side.');
      await until(
        '[...document.querySelectorAll("button")].some((item) => item.textContent.includes("试写后查看对照") && !item.disabled)',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("试写后查看对照")).click()',
      );
      await until('document.body.innerText.includes("I will approach the problem slowly.")');
      await until('document.activeElement.id === "output-history-answer-history-a"');
      const comparison = await evaluate('document.body.innerText');
      assert.ok(comparison.includes('I could approach the problem from another side.'));
      assert.ok(comparison.includes('I will approach the problem more carefully.'));
      assert.equal(await evaluate('window.outputApiWrites.length'), 0);
      assert.equal(
        await evaluate(
          "Object.keys(localStorage).filter((key) => key.includes('output.history') || key.includes('output.recall')).length",
        ),
        0,
      );

      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("再试一次（先隐藏对照）")).click()',
      );
      await until('!document.body.innerText.includes("I will approach the problem slowly.")');
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-a").value'),
        '',
      );

      await typeFirstAttempt('This attempt should disappear after refresh.');
      await send('Page.reload');
      await until('document.querySelector("#output-answer")');
      await openHistory();
      await openFirstRecord();
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-a").value'),
        '',
      );
      const afterRefresh = await evaluate('document.body.innerText');
      assert.ok(!afterRefresh.includes('I will approach the problem slowly.'));
      assert.ok(!afterRefresh.includes('This attempt should disappear after refresh.'));

      await typeFirstAttempt('This attempt should disappear after navigation.');
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("易混词对比训练")).click()',
      );
      await until('document.body.innerText.includes("暂时没有可用词组")');
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("每日输出挑战")).click()',
      );
      await until('document.querySelector("#output-answer")');
      await openHistory();
      await openFirstRecord();
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-a").value'),
        '',
      );
      const afterNavigation = await evaluate('document.body.innerText');
      assert.ok(!afterNavigation.includes('I will approach the problem slowly.'));
      assert.ok(!afterNavigation.includes('This attempt should disappear after navigation.'));

      // An empty attempt can reveal the saved record directly; no typing is required.
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("直接查看原记录")).click()',
      );
      await until('document.body.innerText.includes("I will approach the problem slowly.")');

      await evaluate(`(() => {
        const session = JSON.parse(localStorage.getItem('lexloop.session'));
        localStorage.setItem('lexloop.session', JSON.stringify({ ...session, accessToken: 'fixture-b', user: { ...session.user, id: 'user-b', email: 'fixture-b@example.invalid', displayName: 'Fixture B' } }));
      })()`);
      await send('Page.reload');
      await until('document.querySelector("#output-answer")');
      await openHistory();
      await evaluate('document.querySelectorAll("details")[0].open = true');
      await until('document.querySelector("#output-history-attempt-history-b")');
      const userBBeforeReveal = await evaluate('document.body.innerText');
      assert.ok(!userBBeforeReveal.includes('I will approach the problem slowly.'));
      assert.ok(!userBBeforeReveal.includes('This attempt should disappear'));
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-b").value'),
        '',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("直接查看原记录")).click()',
      );
      await until('document.body.innerText.includes("Account B saved answer.")');
      assert.ok(
        !(await evaluate('document.body.innerText')).includes(
          'I will approach the problem slowly.',
        ),
      );
      assert.equal(await evaluate('window.outputApiWrites.length'), 0);
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
