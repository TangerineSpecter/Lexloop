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
        if (result.exceptionDetails)
          throw new Error(
            `${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? ''}`,
          );
        return result.result.value;
      };
      const clickVisible = async (selector) => {
        let point = await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return null;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, visible: rect.width > 0 && rect.height > 0, hit: hit === element || element.contains(hit) };
        })()`);
        assert.ok(point?.visible, `Expected visible click target: ${selector}`);
        assert.equal(point.hit, true, `Expected unobstructed click target: ${selector}`);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
        });
        await delay(50);
        point = await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, visible: rect.width > 0 && rect.height > 0, hit: hit === element || element.contains(hit) };
        })()`);
        assert.ok(point?.visible, `Expected visible click target after hover: ${selector}`);
        assert.equal(
          point.hit,
          true,
          `Expected unobstructed click target after hover: ${selector}`,
        );
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
          state = `page text: ${(await evaluate('document.body.innerText')).slice(0, 800)}; browser state: ${await evaluate("JSON.stringify({ session: localStorage.getItem('lexloop.session'), fixture: window.microFixture, storage: Object.keys(localStorage), collectionForm: (() => { const form = document.querySelector('details form'); return form ? { open: form.closest('details').open, valid: form.checkValidity(), fields: [...form.querySelectorAll('input,textarea')].map(field => ({ value: field.value, valid: field.checkValidity() })) } : null; })() })")}`;
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
      window.microFixture = { index: savedFixture.index ?? (completedOriginal ? 9 : 0), revealed: savedFixture.revealed || false, failReveal: params.has('fail-reveal') && sessionStorage.getItem(fixtureKey + '.reveal-failed') !== '1', interpretation: savedFixture.interpretation || '', errors: savedFixture.errors || [], reviewDone: savedFixture.reviewDone || false, failReview: params.has('fail-review') && sessionStorage.getItem(fixtureKey + '.review-failed') !== '1', speechLog: [], speechCancelCount: 0, requests: [], notebookSaves: [], notebookButtonClicks: 0, notebookSubmits: 0 };
      document.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('details form button')) window.microFixture.notebookButtonClicks += 1; });
      document.addEventListener('submit', event => { if (event.target instanceof HTMLFormElement && event.target.closest('details')) window.microFixture.notebookSubmits += 1; });
      const audioAuditKey = 'lexloop.test.local-audio-audit';
      const readAudioAudit = () => JSON.parse(sessionStorage.getItem(audioAuditKey) || '{"stoppedTracks":0,"revokedUrls":[]}');
      const writeAudioAudit = audit => sessionStorage.setItem(audioAuditKey, JSON.stringify(audit));
      window.addEventListener('pagehide', () => { const audit = readAudioAudit(); audit.pageHides = (audit.pageHides || 0) + 1; writeAudioAudit(audit); });
      window.localSpeechFixture = { permissionRequests: [], streams: [], recorders: [], createdUrls: [], revokedUrls: [], playedUrls: [] };
      const localSpeech = window.localSpeechFixture;
      const noMic = params.has('no-mic');
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: noMic ? undefined : async constraints => {
          localSpeech.permissionRequests.push(constraints);
          if (params.has('slow-mic')) await new Promise(resolve => setTimeout(resolve, 500));
          if (params.has('mic-denied')) throw new DOMException('Permission denied', 'NotAllowedError');
          const track = { readyState: 'live', stopped: false, stop() { if (!this.stopped) { this.stopped = true; this.readyState = 'ended'; const audit = readAudioAudit(); audit.stoppedTracks += 1; writeAudioAudit(audit); } } };
          const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
          localSpeech.streams.push(stream);
          return stream;
        },
      } });
      class FixtureMediaRecorder extends EventTarget {
        constructor(stream) { super(); this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; localSpeech.recorders.push(this); }
        start() { this.state = 'recording'; if (params.has('mic-error')) setTimeout(() => { this.state = 'inactive'; this.dispatchEvent(new Event('error')); }, 25); }
        stop() {
          if (this.state === 'inactive') return;
          this.state = 'inactive';
          const data = new Event('dataavailable');
          Object.defineProperty(data, 'data', { value: new Blob(['fixture audio'], { type: this.mimeType }) });
          this.dispatchEvent(data);
          this.dispatchEvent(new Event('stop'));
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: noMic ? undefined : FixtureMediaRecorder });
      const createObjectUrl = URL.createObjectURL.bind(URL);
      const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = createObjectUrl(blob); localSpeech.createdUrls.push(url); return url; };
      URL.revokeObjectURL = url => { localSpeech.revokedUrls.push(url); const audit = readAudioAudit(); audit.revokedUrls.push(url); writeAudioAudit(audit); revokeObjectUrl(url); };
      HTMLMediaElement.prototype.play = function () { localSpeech.playedUrls.push(this.currentSrc || this.src); return Promise.resolve(); };
      if (params.has('fast-mic-limit')) {
        const nativeSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, timeout, ...args) => nativeSetTimeout(callback, timeout === 30000 ? 2000 : timeout, ...args);
      }
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
        if (path.includes('/api/v1/vocabulary/personal/items') && options.method === 'POST') {
          f.notebookSaves.push({ body: JSON.parse(options.body), authorization: new Headers(options.headers).get('Authorization') });
          return Response.json({ id: 'saved-phrase', addedToReview: true });
        }
        if (path.includes('/api/v1/micro-stories/current')) return Response.json({ completed: f.index, total: f.index >= 9 ? 15 : 2, lesson: f.index >= 9 ? continuation : f.index ? { key: 'bus-02', series: '上班路上', part: 2, level: 'A1', english: 'Tom calls his boss.', interpretation: null } : f.revealed ? { ...first, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', frame: 'I missed the bus.', example: 'I missed the train.', focusPhrase: 'miss the bus', focusMeaning: '没赶上公交车；不是“想念公交车”。' } : first, review: f.errors.length && !f.reviewDone ? { id: 'card1', key: 'bus-01', english: first.english, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', ownSentence: f.errors[0].ownSentence, reviewCount: 0 } : null });
        if (path.endsWith('/api/v1/micro-stories/completed')) return Response.json(f.index >= 9 ? [{ key: 'bus-01', series: '上班路上', part: 1, level: 'A1', english: first.english }] : []);
        if (path.endsWith('/api/v1/micro-stories/completed/bus-01')) return Response.json({ key: 'bus-01', series: '上班路上', part: 1, level: 'A1', english: first.english, reference: '汤姆出门晚了，没赶上公交车。', explanation: 'miss the bus 是“没赶上公交车”，不是“想念公交车”。', frame: 'I missed the bus.', example: 'I missed the train.', focusPhrase: 'miss the bus', focusMeaning: '没赶上公交车；不是“想念公交车”。' });
        if (path.includes('/api/v1/micro-stories/errors')) return Response.json(f.errors);
        if (path.includes('/api/v1/micro-stories/bus-01/interpret')) {
          if (f.failReveal) { f.failReveal = false; sessionStorage.setItem(fixtureKey + '.reveal-failed', '1'); return Response.json({ message: 'Fixture failure' }, { status: 500 }); }
          f.interpretation = JSON.parse(options.body).interpretation; f.revealed = true; persistFixture();
          return Response.json({ ...first, interpretation: f.interpretation, reference: '汤姆没赶上公交车。', explanation: 'miss the bus 是没赶上公交车。', frame: 'I missed the bus.', example: 'I missed the train.', focusPhrase: 'miss the bus', focusMeaning: '没赶上公交车；不是“想念公交车”。' });
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
        url: new URL(
          '/dashboard/micro-stories?fail-reveal=1&fail-review=1&fast-mic-limit=1',
          baseUrl,
        ).href,
      });
      await until('document.querySelector("textarea")');
      const requestsOnInitialLoad = await evaluate('window.microFixture.requests.length');
      assert.equal(await evaluate('document.querySelector("details summary")'), null);
      assert.equal(await evaluate('window.microFixture.notebookSaves.length'), 0);
      await until('document.querySelector(`button[aria-label="按正常速度播放微故事原文"]`)');
      assert.equal(await evaluate('window.localSpeechFixture.permissionRequests.length'), 0);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(100);
      const desktopPracticeBounds = await evaluate(
        'JSON.stringify((() => { const r = document.querySelector("[data-local-speaking-practice]").getBoundingClientRect(); const a = document.querySelector("[data-local-speaking-practice] audio"); const ar = a?.getBoundingClientRect(); return { left: r.left, right: r.right, audioRight: ar?.right ?? null, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
      );
      const desktopBounds = JSON.parse(desktopPracticeBounds);
      assert.ok(desktopBounds.left >= 0 && desktopBounds.right <= desktopBounds.viewport);
      assert.ok(desktopBounds.scrollWidth <= desktopBounds.viewport);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const mobileBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const r = document.querySelector("[data-local-speaking-practice]").getBoundingClientRect(); const a = document.querySelector("[data-local-speaking-practice] audio"); const ar = a?.getBoundingClientRect(); return { left: r.left, right: r.right, audioRight: ar?.right ?? null, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(mobileBounds.left >= 0 && mobileBounds.right <= mobileBounds.viewport);
      assert.ok(mobileBounds.scrollWidth <= mobileBounds.viewport);
      await send('Emulation.clearDeviceMetricsOverride');
      const storageBeforeLocalSpeech = await evaluate(
        'JSON.stringify(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]))',
      );
      const apiRequestsBeforeLocalSpeech = await evaluate('window.microFixture.requests.length');
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("正在录音")',
      );
      assert.deepEqual(await evaluate('window.localSpeechFixture.permissionRequests'), [
        { audio: true },
      ]);
      await evaluate('document.querySelector("[data-local-speech-action=cancel]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("已取消录音")',
      );
      assert.equal(await evaluate('window.localSpeechFixture.streams[0].track.stopped'), true);
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("正在录音")',
      );
      await evaluate('document.querySelector("[data-local-speech-action=stop]").click()');
      await until('document.querySelector("[data-local-speaking-practice] audio[src]")');
      assert.equal(await evaluate('window.localSpeechFixture.streams[1].track.stopped'), true);
      const firstLocalRecordingUrl = await evaluate(
        'document.querySelector("[data-local-speaking-practice] audio").src',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const mobilePlayerBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const r = document.querySelector("[data-local-speaking-practice] audio").getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(
        mobilePlayerBounds.left >= 0 && mobilePlayerBounds.right <= mobilePlayerBounds.viewport,
      );
      assert.ok(mobilePlayerBounds.scrollWidth <= mobilePlayerBounds.viewport);
      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate('document.querySelector("[data-local-speaking-practice] audio").play()');
      assert.deepEqual(await evaluate('window.localSpeechFixture.playedUrls'), [
        firstLocalRecordingUrl,
      ]);
      await evaluate('document.querySelector("[data-local-speech-action=delete]").click()');
      await until('document.querySelector("[data-local-speaking-practice] audio") === null');
      assert.equal(
        await evaluate(
          `window.localSpeechFixture.revokedUrls.includes(${JSON.stringify(firstLocalRecordingUrl)})`,
        ),
        true,
      );
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("正在录音")',
      );
      await until(
        'document.querySelector("[data-local-speaking-practice] audio[src]") && document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("30 秒上限")',
      );
      assert.equal(await evaluate('window.localSpeechFixture.streams[2].track.stopped'), true);
      await evaluate('document.querySelector("[data-local-speech-action=delete]").click()');
      assert.equal(
        await evaluate('window.microFixture.requests.length'),
        apiRequestsBeforeLocalSpeech,
      );
      assert.equal(
        await evaluate(
          'JSON.stringify(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]))',
        ),
        storageBeforeLocalSpeech,
      );
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
      await until('document.querySelector("details summary")');
      assert.equal(await evaluate('document.querySelector("details").open'), false);
      assert.equal(await evaluate('window.microFixture.notebookSaves.length'), 0);
      assert.equal(
        await evaluate('document.querySelector("details input")?.value'),
        'miss the bus',
      );
      assert.equal(
        await evaluate('document.querySelector("details textarea")?.value'),
        'Tom misses the bus.',
      );
      const openingPoint = await evaluate(`(() => {
        const summary = document.querySelector('details summary');
        summary.scrollIntoView({ block: 'center' });
        const rect = summary.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, visible: rect.width > 0 && rect.height > 0, hit: hit === summary || summary.contains(hit) };
      })()`);
      assert.equal(openingPoint.visible, true);
      assert.equal(openingPoint.hit, true);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: openingPoint.x,
        y: openingPoint.y,
        button: 'none',
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: openingPoint.x,
        y: openingPoint.y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: openingPoint.x,
        y: openingPoint.y,
        button: 'left',
        clickCount: 1,
      });
      assert.equal(await evaluate('document.querySelector("details").open'), true);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const desktopNotebookBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const rect = document.querySelector("details").getBoundingClientRect(); return { left: rect.left, right: rect.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(
        desktopNotebookBounds.left >= 0 &&
          desktopNotebookBounds.right <= desktopNotebookBounds.viewport,
      );
      assert.ok(desktopNotebookBounds.scrollWidth <= desktopNotebookBounds.viewport);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileNotebookBounds = JSON.parse(
        await evaluate(
          'JSON.stringify((() => { const rect = document.querySelector("details").getBoundingClientRect(); return { left: rect.left, right: rect.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }; })())',
        ),
      );
      assert.ok(
        mobileNotebookBounds.left >= 0 &&
          mobileNotebookBounds.right <= mobileNotebookBounds.viewport,
      );
      assert.ok(mobileNotebookBounds.scrollWidth <= mobileNotebookBounds.viewport);
      await send('Emulation.clearDeviceMetricsOverride');
      assert.equal(await evaluate('document.querySelector("details form").checkValidity()'), true);
      await clickVisible('details form button');
      await until('window.microFixture.notebookSaves.length === 1');
      assert.deepEqual(await evaluate('window.microFixture.notebookSaves[0]'), {
        body: {
          text: 'miss the bus',
          type: 'PHRASE',
          meaning: '没赶上公交车；不是“想念公交车”。',
          example: 'Tom misses the bus.',
          sourceScenario: '微故事 · 上班路上 · 第 1 段',
          sourceType: 'READING',
        },
        authorization: 'Bearer fixture',
      });
      await until(
        'document.querySelector("details [role=status]")?.textContent.includes("已加入复习")',
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=notebook-other', baseUrl).href,
      });
      await until('document.querySelector("#story-meaning")');
      assert.equal(await evaluate('document.querySelector("details summary")'), null);
      assert.equal(await evaluate('document.body.textContent.includes("miss the bus")'), false);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?fail-reveal=1&fail-review=1', baseUrl).href,
      });
      await until('document.body.textContent.includes("你的理解：")');
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
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("正在录音")',
      );
      const streamBeforeStoryChange = await evaluate(
        'window.localSpeechFixture.streams.length - 1',
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('读下一段')).click()`,
      );
      await until('document.body.textContent.includes("第 2 小段")');
      assert.equal(
        await evaluate(
          `window.localSpeechFixture.streams[${streamBeforeStoryChange}].track.stopped`,
        ),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("[data-local-speaking-practice] audio")'),
        null,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("录音只暂存在当前页面")',
        ),
        true,
      );
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
      const requestsBeforeRevisit = await evaluate('window.microFixture.requests.length');
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('选择故事')).click()`,
      );
      await until(`document.body.textContent.includes('上班路上 · 第 1 小段')`);
      assert.equal(await evaluate('document.body.textContent.includes("没赶上公交车")'), false);
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('重读这段')).click()`,
      );
      assert.equal(await evaluate('document.body.textContent.includes("miss the bus 是")'), false);
      await evaluate(
        `(() => { const input = document.querySelector('#completed-attempt'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '汤姆没赶上公交车'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.includes('查看解析')).click()`,
      );
      await until(`document.body.textContent.includes('这次回想（未保存）')`);
      assert.equal(await evaluate('document.body.textContent.includes("miss the bus 是")'), true);
      assert.equal(await evaluate('document.querySelector("details").open'), false);
      assert.equal(
        await evaluate('document.querySelector("details input")?.value'),
        'miss the bus',
      );
      assert.equal(await evaluate('window.microFixture.notebookSaves.length'), 0);
      assert.equal(
        await evaluate(
          'document.body.textContent.includes("Maya wants to see a friend this weekend.")',
        ),
        true,
      );
      assert.deepEqual(
        await evaluate('window.microFixture.requests.slice(-2).map(request => request.path)'),
        ['/api/v1/micro-stories/completed', '/api/v1/micro-stories/completed/bus-01'],
      );
      assert.equal(
        await evaluate('window.microFixture.requests.length'),
        requestsBeforeRevisit + 2,
      );

      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(100);
      assert.equal(
        await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
        true,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      assert.equal(
        await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
        true,
      );
      assert.equal(await evaluate('document.querySelector("#completed-attempt")'), null);
      assert.equal(await evaluate('document.body.textContent.includes("miss the bus 是")'), true);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?mic-denied=1&user=denied', baseUrl).href,
      });
      await until('document.querySelector("[data-local-speaking-practice] [role=status]")');
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=alert]")?.textContent.includes("没有获得麦克风权限")',
      );
      assert.equal(await evaluate('window.localSpeechFixture.permissionRequests.length'), 1);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?no-mic=1&user=unsupported', baseUrl).href,
      });
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("不支持本地录音")',
      );
      assert.equal(
        await evaluate('document.querySelector("[data-local-speech-action=start]")'),
        null,
      );
      assert.equal(await evaluate('window.localSpeechFixture.permissionRequests.length'), 0);
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?slow-mic=1&user=slow', baseUrl).href,
      });
      await until(
        'document.querySelector("[data-local-speaking-practice] [data-local-speech-action=start]")',
      );
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [data-local-speech-action=cancel]")',
      );
      await evaluate('document.querySelector("[data-local-speech-action=cancel]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=status]")?.textContent.includes("已取消录音")',
      );
      await delay(650);
      assert.equal(await evaluate('window.localSpeechFixture.streams[0].track.stopped'), true);
      assert.equal(await evaluate('window.localSpeechFixture.recorders.length'), 0);

      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?mic-error=1&user=error', baseUrl).href,
      });
      await until(
        'document.querySelector("[data-local-speaking-practice] [data-local-speech-action=start]")',
      );
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [role=alert]")?.textContent.includes("录音失败了")',
      );
      assert.equal(await evaluate('window.localSpeechFixture.streams[0].track.stopped'), true);

      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=recording-owner', baseUrl).href,
      });
      await until(
        'document.querySelector("[data-local-speaking-practice] [data-local-speech-action=start]")',
      );
      await evaluate('document.querySelector("[data-local-speech-action=start]").click()');
      await until(
        'document.querySelector("[data-local-speaking-practice] [data-local-speech-action=stop]")',
      );
      await evaluate('document.querySelector("[data-local-speech-action=stop]").click()');
      await until('document.querySelector("[data-local-speaking-practice] audio[src]")');
      const recordingRevokedOnAccountChange = await evaluate(
        'document.querySelector("[data-local-speaking-practice] audio").src',
      );
      await send('Page.navigate', {
        url: new URL('/dashboard/micro-stories?user=other-account', baseUrl).href,
      });
      await until(
        'document.querySelector("[data-local-speaking-practice] [data-local-speech-action=start]")',
      );
      assert.equal(
        await evaluate(
          `JSON.parse(sessionStorage.getItem('lexloop.test.local-audio-audit')).revokedUrls.includes(${JSON.stringify(recordingRevokedOnAccountChange)})`,
        ),
        true,
        await evaluate("sessionStorage.getItem('lexloop.test.local-audio-audit')"),
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
