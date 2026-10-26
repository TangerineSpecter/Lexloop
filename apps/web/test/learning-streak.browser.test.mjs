import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'dashboard displays the saved learning streak without pretending that a click is a check-in',
  { skip: !baseUrl, timeout: 30_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-streak-test-'));
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
        const result = JSON.parse(event.data);
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
          if (await evaluate(`Boolean(${expression})`)) return;
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };
      await send('Page.enable');
      await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'fixture', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
      const query = new URL(location.href).searchParams;
      window.streakFixture = { currentStreak: query.has('streak-empty') ? 0 : 4, todayActive: query.has('today-active'), failed: query.has('streak-error'), loading: query.has('streak-loading'), requests: [] };
      const nativeFetch = window.fetch;
      window.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'fixture' });
        if (path.includes('/api/v1/reports/streak')) {
          window.streakFixture.requests.push({ method: options.method ?? 'GET', url: path });
          if (window.streakFixture.failed) throw new Error('Fixture failure');
          if (window.streakFixture.loading) await new Promise(resolve => setTimeout(resolve, 700));
          return Response.json({ currentStreak: window.streakFixture.currentStreak, todayActive: window.streakFixture.todayActive });
        }
        if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
        if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 0, masteredWords: 0, progress: 0 });
        if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 5, reviewWords: [], newWords: [] });
        if (path.includes('/api/v1/study/plans')) return Response.json([]);
        if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
        if (path.includes('/api/v1/')) throw new Error('Unexpected API request: ' + path);
        return nativeFetch(url, options);
      };
    `,
      });

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector(".streak-count b")?.textContent === "4"');
      await until('document.body.textContent.includes("今天还没有已完成的学习活动")');
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
        url: new URL('/dashboard?streak-loading=1&streak-empty=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("正在读取真实学习记录")');
      assert.equal(await evaluate('document.querySelector(".streak-count b").textContent'), '—');
      await until('document.querySelector(".streak-count b")?.textContent === "0"');
      assert.equal(await evaluate('document.body.textContent.includes("今天还没有已完成的学习活动")'), true);

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
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
