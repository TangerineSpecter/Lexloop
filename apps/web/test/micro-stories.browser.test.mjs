import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'micro-stories support listening before revealing the text and refresh the notebook after a new error',
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
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A navigation can briefly replace the JavaScript context.
          }
          await delay(100);
        }
        let state = 'page state unavailable';
        try {
          state = `page text: ${(await evaluate('document.body.innerText')).slice(0, 800)}; browser state: ${await evaluate("JSON.stringify({ session: localStorage.getItem('lexloop.session'), fixture: window.microFixture, storage: Object.keys(localStorage) })")}`;
        } catch {
          // Keep the original wait failure if the page never acquired a context.
        }
        assert.fail(`Timed out waiting for ${expression}; ${state}`);
      };
      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      const params = new URL(location.href).searchParams;
      const fixtureUser = params.get('user') || 'fixture';
      const completedOriginal = params.has('completed-original');
      const fixtureKey = 'micro-fixture.' + fixtureUser;
      const savedFixture = JSON.parse(sessionStorage.getItem(fixtureKey) || 'null') || {};
      localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: fixtureUser, email: fixtureUser + '@example.invalid', displayName: 'Fixture', role: 'USER' } }));
      if (params.has('corrupt-story')) localStorage.setItem('lexloop.micro-story.story.' + fixtureUser, '{invalid');
      if (params.has('wrong-story')) localStorage.setItem('lexloop.micro-story.story.' + fixtureUser, JSON.stringify({ storyKey: 'bus-99', interpretation: '上一段的私密理解', ownSentence: '' }));
      if (params.has('storage-fail')) {
        const nativeSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('lexloop.micro-story.')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          return nativeSetItem.call(this, key, value);
        };
      }
      window.microFixture = { index: savedFixture.index ?? (completedOriginal ? 9 : 0), revealed: savedFixture.revealed || false, failReveal: params.has('fail-reveal') && sessionStorage.getItem(fixtureKey + '.reveal-failed') !== '1', interpretation: savedFixture.interpretation || '', errors: savedFixture.errors || [], reviewDone: savedFixture.reviewDone || false, failReview: params.has('fail-review') && sessionStorage.getItem(fixtureKey + '.review-failed') !== '1', speechLog: [], speechCancelCount: 0, requests: [] };
      const persistFixture = () => sessionStorage.setItem(fixtureKey, JSON.stringify({ index: window.microFixture.index, revealed: window.microFixture.revealed, interpretation: window.microFixture.interpretation, errors: window.microFixture.errors, reviewDone: window.microFixture.reviewDone }));
      const noSpeech = params.has('no-speech');
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: noSpeech ? undefined : class { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; } } });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [{ lang: 'en-US' }], cancel: () => { window.microFixture.speechCancelCount += 1; }, speak: utterance => { window.microFixture.speechLog.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate }); } } });
      const nativeFetch = window.fetch;
      window.fetch = async (url, options = {}) => {
        const path = String(url);
        const f = window.microFixture;
        if (path.includes('/api/v1/')) f.requests.push({ path, method: options.method ?? 'GET', authorization: new Headers(options.headers).get('Authorization') });
        const first = { key: 'bus-01', series: '上班路上', part: 1, level: 'A1', english: 'Tom misses the bus.', interpretation: f.revealed ? f.interpretation : null };
        const continuation = { key: 'weekend-01', series: '周末约朋友', part: 1, level: 'A2', english: 'Maya wants to see a friend this weekend. She texts Leo to ask if he is free on Saturday.', interpretation: null };
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: fixtureUser });
        if (path.includes('/api/v1/micro-stories/current')) return Response.json({ completed: f.index, total: f.index >= 9 ? 15 : 2, lesson: f.index >= 9 ? continuation : f.index ? { key: 'bus-02', series: '上班路上', part: 2, level: 'A1', english: 'Tom calls his boss.', interpretation: null } : f.revealed ? { ...first, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', frame: 'I missed the bus.', example: 'I missed the train.' } : first, review: f.errors.length && !f.reviewDone ? { id: 'card1', key: 'bus-01', english: first.english, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', ownSentence: f.errors[0].ownSentence, reviewCount: 0 } : null });
        if (path.includes('/api/v1/micro-stories/errors')) return Response.json(f.errors);
        if (path.includes('/api/v1/micro-stories/bus-01/interpret')) {
          if (f.failReveal) { f.failReveal = false; sessionStorage.setItem(fixtureKey + '.reveal-failed', '1'); return Response.json({ message: 'Fixture failure' }, { status: 500 }); }
          f.interpretation = JSON.parse(options.body).interpretation; f.revealed = true; persistFixture();
          return Response.json({ ...first, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', frame: 'I missed the bus.', example: 'I missed the train.' });
        }
        if (path.includes('/api/v1/micro-stories/bus-01/complete')) {
          f.errors.push({ id: 'card1', english: first.english, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', ownSentence: JSON.parse(options.body).ownSentence, dueAt: new Date().toISOString() });
          f.index = 1; persistFixture(); return Response.json({ completed: 1, total: 2 });
        }
        if (path.includes('/api/v1/micro-stories/reviews/card1')) {
          if (f.failReview) { f.failReview = false; sessionStorage.setItem(fixtureKey + '.review-failed', '1'); return Response.json({ message: 'Fixture review failure' }, { status: 500 }); }
          f.reviewDone = true; persistFixture(); return Response.json({ ok: true });
        }
        if (path.includes('/api/v1/')) throw new Error('Unexpected API request: ' + path);
        return nativeFetch(url, options);
      };
    `,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-reveal=1&fail-review=1', baseUrl).href,
      });
      await until('document.querySelector("textarea")');
      const requestsOnInitialLoad = await evaluate('window.microFixture.requests.length');
      await until('document.querySelector(`button[aria-label="按正常速度播放微故事原文"]`)');
      const requestsBeforeEmptySubmit = await evaluate('window.microFixture.requests.length');
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find(button => button.textContent.includes("查看解释")).disabled',
        ),
        true,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解释')).click()`,
      );
      assert.equal(
        await evaluate('window.microFixture.requests.length'),
        requestsBeforeEmptySubmit,
      );
      assert.equal(
        await evaluate(
          'window.microFixture.requests.find(request => request.path.includes("/micro-stories/current")).authorization',
        ),
        'Bearer fixture',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('先听后看原文')).click()`,
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find(button => button.textContent.includes("显示英文原文"))?.getAttribute("aria-pressed")',
        ),
        'true',
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        false,
      );
      assert.equal(await evaluate('window.microFixture.requests.length'), requestsOnInitialLoad);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-reveal=1', baseUrl).href,
      });
      await until('document.querySelector("textarea")');
      const requestsAfterRefresh = await evaluate('window.microFixture.requests.length');
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        true,
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find(button => button.textContent.includes("先听后看原文"))?.getAttribute("aria-pressed")',
        ),
        'false',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('先听后看原文')).click()`,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        false,
      );
      await evaluate(
        `document.querySelector('button[aria-label="按正常速度播放微故事原文"]').click()`,
      );
      assert.deepEqual(await evaluate('window.microFixture.speechLog[0]'), {
        text: 'Tom misses the bus.',
        lang: 'en-US',
        rate: 1,
      });
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('显示英文原文')).click()`,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        true,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('先听后看原文')).click()`,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        false,
      );
      assert.equal(await evaluate('window.microFixture.requests.length'), requestsAfterRefresh);
      await evaluate(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '想念公交车');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      const sentence = document.querySelector('#own-sentence-before-reveal');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(sentence, 'I missed the train.');
      sentence.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      assert.equal(await evaluate('window.microFixture.requests.length'), requestsAfterRefresh);
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('清除本机草稿')).click()`,
      );
      assert.equal(await evaluate('document.querySelector("#story-meaning").value'), '');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.story.fixture")'),
        null,
      );
      await evaluate(`(() => {
      const area = document.querySelector('#story-meaning');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '想念公交车');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      const sentence = document.querySelector('#own-sentence-before-reveal');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(sentence, 'I missed the train.');
      sentence.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      await until(
        `![...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解释')).disabled`,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解释')).click()`,
      );
      await until('document.body.textContent.includes("服务暂时不可用")');
      assert.equal(await evaluate('document.body.textContent.includes("第 1 小段")'), true);
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        false,
      );
      assert.equal(await evaluate('document.querySelector("textarea").value'), '想念公交车');
      assert.deepEqual(
        await evaluate('JSON.parse(localStorage.getItem("lexloop.micro-story.story.fixture"))'),
        { storyKey: 'bus-01', interpretation: '想念公交车', ownSentence: 'I missed the train.' },
      );
      assert.equal(
        await evaluate(
          'window.microFixture.requests.some(request => request.path.includes("/complete"))',
        ),
        false,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=other', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      assert.equal(await evaluate('document.querySelector("#story-meaning").value'), '');
      assert.equal(await evaluate('localStorage.getItem("lexloop.micro-story.story.other")'), null);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=storage&storage-fail=1', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      await evaluate(
        `(() => { const input = document.querySelector('#story-meaning'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '只保存在页面中的尝试'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      assert.equal(
        await evaluate('document.querySelector("#story-meaning").value'),
        '只保存在页面中的尝试',
      );
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.story.storage")'),
        null,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=corrupt&corrupt-story=1', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      assert.equal(await evaluate('document.querySelector("#story-meaning").value'), '');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.story.corrupt")'),
        null,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=stale&wrong-story=1', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      assert.equal(await evaluate('document.querySelector("#story-meaning").value'), '');
      assert.equal(await evaluate('localStorage.getItem("lexloop.micro-story.story.stale")'), null);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-reveal=1&fail-review=1', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      await until('document.querySelector("#story-meaning").value === "想念公交车"');
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('先听后看原文')).click()`,
      );
      assert.equal(
        await evaluate('document.querySelector("#own-sentence-before-reveal").value'),
        'I missed the train.',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解释')).click()`,
      );
      await until('document.body.textContent.includes("刚才的理解有偏差吗")');
      await evaluate(
        `localStorage.setItem('lexloop.micro-story.story.fixture', JSON.stringify({ storyKey: 'bus-01', interpretation: '本地旧理解', ownSentence: 'I missed the train.' }))`,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-reveal=1&fail-review=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("你的理解：")');
      assert.equal(
        await evaluate('document.body.textContent.includes("你的理解：想念公交车")'),
        true,
      );
      assert.equal(await evaluate('document.body.textContent.includes("本地旧理解")'), false);
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom misses the bus.")'),
        true,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("I missed the train.")'),
        true,
      );
      await evaluate(`document.querySelector('button[aria-label="慢速播放微故事原文"]').click()`);
      assert.equal(await evaluate('window.microFixture.speechLog[0].rate'), 0.8);
      await evaluate(`document.querySelector('button[aria-label="停止播放微故事原文"]').click()`);
      assert.ok(await evaluate('window.microFixture.speechCancelCount >= 2'));
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('翻看记录')).click()`,
      );
      await until('document.body.textContent.includes("还没有标记过的理解偏差")');
      await evaluate(`document.querySelector('input[name="mismatch"][type="radio"]').click()`);
      assert.equal(
        await evaluate('document.querySelector("#own-sentence").value'),
        'I missed the train.',
      );
      await until('document.body.textContent.includes("读下一段")');
      await evaluate(
        `document.querySelector('button[aria-label="按正常速度播放微故事原文"]').click()`,
      );
      const cancelCountBeforeNext = await evaluate('window.microFixture.speechCancelCount');
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('读下一段')).click()`,
      );
      await until('document.body.textContent.includes("第 2 小段")');
      assert.equal(
        await evaluate('window.microFixture.speechCancelCount > ' + cancelCountBeforeNext),
        true,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom calls his boss.")'),
        true,
      );
      await evaluate(
        `document.querySelector('button[aria-label="按正常速度播放微故事原文"]').click()`,
      );
      assert.equal(await evaluate('window.microFixture.speechLog[2].text'), 'Tom calls his boss.');
      await until('document.querySelector(`button[aria-label="按正常速度播放到期复习句"]`)');
      await evaluate(
        `document.querySelector('button[aria-label="按正常速度播放到期复习句"]').click()`,
      );
      assert.equal(await evaluate('window.microFixture.speechLog[3].rate'), 1);
      await until(
        'document.querySelector("article") && document.querySelector("article").textContent.includes("想念公交车")',
      );
      assert.equal(await evaluate('document.querySelector("#review-attempt").value'), '');
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find(button => button.textContent.includes("先试着回想，查看上次偏差")).disabled',
        ),
        true,
      );
      const currentRequestsBeforeSkipping = await evaluate(
        'window.microFixture.requests.filter(request => request.path.includes("/micro-stories/current")).length',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('跳过本次回想，查看上次偏差')).click()`,
      );
      await until('document.body.textContent.includes("上次我的理解：")');
      assert.equal(
        await evaluate(
          'window.microFixture.requests.filter(request => request.path.includes("/micro-stories/current")).length',
        ),
        currentRequestsBeforeSkipping,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-review=1', baseUrl).href,
      });
      await until('document.querySelector("#review-attempt")');
      assert.equal(await evaluate('document.body.textContent.includes("上次我的理解：")'), false);
      await evaluate(
        `(() => { const input = document.querySelector('#review-attempt'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '汤姆没赶上公交车'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.review.fixture.card1")'),
        '汤姆没赶上公交车',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('清除本机回想草稿')).click()`,
      );
      assert.equal(await evaluate('document.querySelector("#review-attempt").value'), '');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.review.fixture.card1")'),
        null,
      );
      await evaluate(
        `(() => { const input = document.querySelector('#review-attempt'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '汤姆没赶上公交车'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=other', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.review.other.card1")'),
        null,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-review=1', baseUrl).href,
      });
      await until('document.querySelector("#review-attempt")');
      assert.equal(
        await evaluate('document.querySelector("#review-attempt").value'),
        '汤姆没赶上公交车',
      );
      assert.equal(await evaluate('document.body.textContent.includes("上次我的理解：")'), false);
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('先试着回想，查看上次偏差')).click()`,
      );
      await until('document.body.textContent.includes("上次我的理解：")');
      await until('document.body.textContent.includes("上次造句")');
      assert.equal(
        await evaluate('document.body.textContent.includes("I missed the train.")'),
        true,
      );
      assert.equal(await evaluate('window.microFixture.errors.length'), 1);
      const currentRequestsBeforeFailedReview = await evaluate(
        'window.microFixture.requests.filter(request => request.path.includes("/micro-stories/current")).length',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('还没记住，明天再看')).click()`,
      );
      await until('document.body.textContent.includes("服务暂时不可用")');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.review.fixture.card1")'),
        '汤姆没赶上公交车',
      );
      assert.equal(
        await evaluate(
          'window.microFixture.requests.filter(request => request.path.includes("/micro-stories/current")).length',
        ),
        currentRequestsBeforeFailedReview,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('还没记住，明天再看')).click()`,
      );
      await until('document.body.textContent.includes("Tom calls his boss.")');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.micro-story.review.fixture.card1")'),
        null,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?no-speech=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("当前浏览器不支持语音播放")');
      assert.equal(
        await evaluate('Boolean(document.querySelector("button[aria-label*=播放微故事原文]"))'),
        false,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('先听后看原文')).click()`,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom calls his boss.")'),
        false,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('显示英文原文')).click()`,
      );
      assert.equal(
        await evaluate('document.body.textContent.includes("Tom calls his boss.")'),
        true,
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?completed-original=1&user=finished', baseUrl).href,
      });
      await until('document.body.textContent.includes("Maya wants to see a friend this weekend.")');
      assert.equal(await evaluate('document.body.textContent.includes("10/15")'), true);
      assert.equal(await evaluate('document.body.textContent.includes("周末约朋友")'), true);
      assert.equal(
        await evaluate('document.body.textContent.includes("Maya 想这周末见一位朋友")'),
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
