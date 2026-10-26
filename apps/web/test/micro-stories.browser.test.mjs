import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'micro-stories play original and review audio and refresh the notebook after a new error',
  {
    skip: !baseUrl,
    timeout: 30_000,
  },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-micro-test-'));
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
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'fixture', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
      window.microFixture = { index: 0, revealed: false, interpretation: '', errors: [], speechLog: [], speechCancelCount: 0 };
      const noSpeech = new URL(location.href).searchParams.has('no-speech');
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: noSpeech ? undefined : class { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; } } });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [{ lang: 'en-US' }], cancel: () => { window.microFixture.speechCancelCount += 1; }, speak: utterance => { window.microFixture.speechLog.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate }); } } });
      const nativeFetch = window.fetch;
      window.fetch = async (url, options = {}) => {
        const path = String(url);
        const f = window.microFixture;
        const first = { key: 'bus-01', series: '上班路上', part: 1, level: 'A1', english: 'Tom misses the bus.', interpretation: f.revealed ? f.interpretation : null };
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'fixture' });
        if (path.includes('/api/v1/micro-stories/current')) return Response.json({ completed: f.index, total: 2, lesson: f.index ? { key: 'bus-02', series: '上班路上', part: 2, level: 'A1', english: 'Tom calls his boss.', interpretation: null } : f.revealed ? { ...first, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', frame: 'I missed the bus.', example: 'I missed the train.' } : first, review: f.errors.length ? { id: 'card1', key: 'bus-01', english: first.english, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', ownSentence: null, reviewCount: 0 } : null });
        if (path.includes('/api/v1/micro-stories/errors')) return Response.json(f.errors);
        if (path.includes('/api/v1/micro-stories/bus-01/interpret')) {
          f.interpretation = JSON.parse(options.body).interpretation; f.revealed = true;
          return Response.json({ ...first, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', frame: 'I missed the bus.', example: 'I missed the train.' });
        }
        if (path.includes('/api/v1/micro-stories/bus-01/complete')) {
          f.errors.push({ id: 'card1', english: first.english, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', ownSentence: null, dueAt: new Date().toISOString() });
          f.index = 1; return Response.json({ completed: 1, total: 2 });
        }
        if (path.includes('/api/v1/')) throw new Error('Unexpected API request: ' + path);
        return nativeFetch(url, options);
      };
    `,
      });
      await send('Page.navigate', { url: new URL('/dashboard/micro-stories', baseUrl).href });
      await until('document.querySelector("textarea")');
      await until('document.querySelector(`button[aria-label="按正常速度播放微故事原文"]`)');
      await evaluate(
        `document.querySelector('button[aria-label="按正常速度播放微故事原文"]').click()`,
      );
      assert.deepEqual(await evaluate('window.microFixture.speechLog[0]'), {
        text: 'Tom misses the bus.',
        lang: 'en-US',
        rate: 1,
      });
      await evaluate(`document.querySelector('button[aria-label="慢速播放微故事原文"]').click()`);
      assert.equal(await evaluate('window.microFixture.speechLog[1].rate'), 0.8);
      await evaluate(`document.querySelector('button[aria-label="停止播放微故事原文"]').click()`);
      assert.ok(await evaluate('window.microFixture.speechCancelCount >= 3'));
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('翻看记录')).click()`,
      );
      await until('document.body.textContent.includes("还没有标记过的理解偏差")');
      await evaluate(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '想念公交车');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      await until(
        `![...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解释')).disabled`,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解释')).click()`,
      );
      await until('document.body.textContent.includes("刚才的理解有偏差吗")');
      await evaluate(`document.querySelector('input[name="mismatch"][type="radio"]').click()`);
      await until('document.body.textContent.includes("读下一段")');
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('读下一段')).click()`,
      );
      await until('document.body.textContent.includes("第 2 小段")');
      await until('document.querySelector(`button[aria-label="按正常速度播放到期复习句"]`)');
      await evaluate(
        `document.querySelector('button[aria-label="按正常速度播放到期复习句"]').click()`,
      );
      assert.equal(await evaluate('window.microFixture.speechLog[2].rate'), 1);
      await until(
        'document.querySelector("article") && document.querySelector("article").textContent.includes("想念公交车")',
      );
      assert.equal(await evaluate('window.microFixture.errors.length'), 1);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?no-speech=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("当前浏览器不支持语音播放")');
      assert.equal(
        await evaluate('Boolean(document.querySelector("button[aria-label*=播放微故事原文]"))'),
        false,
      );
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
