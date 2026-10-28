import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'daily sentence recall, feedback, and audio preserve learning records and playback boundaries',
  { skip: !baseUrl, timeout: 30_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-daily-feedback-test-'));
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
    browser.on('error', (error) => (launchError = error));
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
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // Navigation can briefly invalidate the current execution context.
          }
          await delay(100);
        }
        const body = await evaluate(
          'document.querySelector("dialog")?.innerText ?? document.body.innerText',
        ).catch((error) => String(error));
        assert.fail(`Timed out waiting for ${expression}; page=${body}`);
      };

      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          const fixtureUserId = new URL(location.href).searchParams.get('user') ?? 'fixture';
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: fixtureUserId, user: { id: fixtureUserId, email: fixtureUserId + '@example.invalid', displayName: 'Fixture', role: 'USER' } }));
          window.noEnglishVoice = new URL(location.href).searchParams.get('no-english') === '1';
          window.legacySentence = {
            id: 'legacy-sentence', dateKey: '2026-10-01', readAt: null, favorite: false,
            difficulty: 'HARD', difficultyTimestampReliable: false,
            content: {
              english: 'She walks home.', chinese: '她步行回家。', level: 'A1', focus: '用一般现在时说日常习惯',
              chunks: [{ text: 'She walks home.', role: '主句', phraseType: '句子', explanation: '说明她平时做什么。' }],
              explanations: [{ question: '为什么用 walks？', answer: '主语是 she，描述日常习惯时动词加 s。' }],
              pattern: 'She + 动词-s', usage: '描述她的日常习惯。',
              example: { english: 'He reads after dinner.', chinese: '他晚饭后阅读。' },
              learningReason: '练习一般现在时。'
            }
          };
          window.olderSentence = {
            id: 'older-feedback', dateKey: '2026-09-30', readAt: '2026-10-01T00:00:00.000Z', favorite: false,
            difficulty: 'EASY', difficultyTimestampReliable: false,
            content: {
              english: 'They walk to work.', chinese: '他们步行上班。', level: 'A1', focus: '用一般现在时说习惯',
              chunks: [{ text: 'They walk to work.', role: '主句', phraseType: '句子', explanation: '说明日常习惯。' }],
              explanations: [{ question: '为什么用 walk？', answer: '主语是 they，动词使用原形。' }],
              pattern: 'They + 动词原形', usage: '描述他们平时的习惯。',
              example: { english: 'We walk to school.', chinese: '我们步行上学。' },
              learningReason: '练习日常习惯。'
            }
          };
          window.reliableSentence = {
            ...window.olderSentence, id: 'reliable-feedback', dateKey: '2026-10-02', difficultyTimestampReliable: true,
            content: { ...window.olderSentence.content, english: 'He walks to work.' }
          };
          window.historyRequests = [];
          window.dailySentenceWrites = [];
          window.failFilteredHistoryOnce = true;
          window.feedbackRequests = [];
          window.dailyFeedbackFieldset = () => [...document.querySelectorAll('fieldset')].find(fieldset => fieldset.querySelector('legend')?.textContent.includes('这句对你来说怎么样？'));
          window.dailySentenceSpeech = { cancelCount: 0, spoken: [], utterances: [], noEnglishVoice: window.noEnglishVoice };
          Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; this.onend = null; this.onerror = null; } } });
          Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
            getVoices: () => window.dailySentenceSpeech.noEnglishVoice ? [] : [{ lang: 'en-US' }],
            cancel: () => {
              window.dailySentenceSpeech.cancelCount += 1;
              const previous = window.dailySentenceSpeech.utterances.at(-1);
              if (previous) setTimeout(() => previous.onend?.(), 0);
            },
            speak: utterance => {
              window.dailySentenceSpeech.utterances.push(utterance);
              window.dailySentenceSpeech.spoken.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate, voice: utterance.voice?.lang ?? null });
            },
            addEventListener: (type, listener) => {
              if (type === 'voiceschanged') window.dailySentenceSpeech.voicesChanged = listener;
            },
            removeEventListener: (type, listener) => {
              if (type === 'voiceschanged' && window.dailySentenceSpeech.voicesChanged === listener) window.dailySentenceSpeech.voicesChanged = null;
            },
            dispatchEvent: event => {
              window.dailySentenceSpeech.voicesChanged?.(event);
              return true;
            }
          } });
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (path.includes('/api/v1/daily-sentences/') && options.method && options.method !== 'GET') {
              window.dailySentenceWrites.push({ method: options.method, path });
            }
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'fixture' });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 1, todayActive: true });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 0, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'READY', item: window.legacySentence, canRetry: false });
            if (path.includes('/api/v1/daily-sentences?page=')) {
              const url = new URL(path, location.origin);
              const needsReview = url.searchParams.get('needsDifficultyReview') === 'true';
              window.historyRequests.push(path);
              if (needsReview && window.failFilteredHistoryOnce) {
                window.failFilteredHistoryOnce = false;
                return Response.json({ message: 'Fixture history failure' }, { status: 500 });
              }
              const entries = [window.olderSentence, window.reliableSentence];
              return Response.json({ items: needsReview ? entries.filter(entry => entry.difficulty && !entry.difficultyTimestampReliable) : entries, hasMore: false });
            }
            if (path.endsWith('/api/v1/daily-sentences/legacy-sentence/read')) {
              window.legacySentence = { ...window.legacySentence, readAt: '2026-10-27T00:00:00.000Z' };
              return Response.json(window.legacySentence);
            }
            if (path.endsWith('/api/v1/daily-sentences/older-feedback/read')) {
              window.olderSentence = { ...window.olderSentence, readAt: '2026-10-27T00:00:00.000Z' };
              return Response.json(window.olderSentence);
            }
            if (path.endsWith('/api/v1/daily-sentences/older-feedback') && options.method !== 'PATCH') return Response.json(window.olderSentence);
            if (path.endsWith('/api/v1/daily-sentences/legacy-sentence') && options.method === 'PATCH') {
              const patch = JSON.parse(options.body);
              window.feedbackRequests.push(patch);
              window.legacySentence = { ...window.legacySentence, ...patch, difficultyTimestampReliable: true };
              return Response.json(window.legacySentence);
            }
            if (path.endsWith('/api/v1/daily-sentences/older-feedback') && options.method === 'PATCH') {
              const patch = JSON.parse(options.body);
              window.olderSentence = { ...window.olderSentence, ...patch, difficultyTimestampReliable: true };
              return Response.json(window.olderSentence);
            }
            if (path.endsWith('/api/v1/daily-sentences/legacy-sentence')) return Response.json(window.legacySentence);
            if (path.includes('/api/v1/')) throw new Error('Unexpected API request: ' + path);
            return nativeFetch(url, options);
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector("#daily-sentence-heading")');
      await until(`document.querySelector('[aria-label^="查看每日一句解析"]')`);
      await evaluate(`document.querySelector('[aria-label^="查看每日一句解析"]').click()`);
      await until('document.querySelector("dialog button[aria-controls]")');
      const beforeReveal = await evaluate('document.querySelector("dialog").innerText');
      assert.ok(beforeReveal.includes('She walks home.'));
      assert.ok(!beforeReveal.includes('她步行回家。'));
      assert.ok(!beforeReveal.includes('说明她平时做什么。'));
      await until(
        'window.dailySentenceWrites.some((write) => write.path.endsWith("/legacy-sentence/read"))',
      );
      const writeCountBeforeReveal = await evaluate('window.dailySentenceWrites.length');
      await evaluate('document.querySelector(\'[aria-label="慢速播放每日一句"]\').click()');
      await until('window.dailySentenceSpeech.spoken.length === 1');
      assert.deepEqual(await evaluate('window.dailySentenceSpeech.spoken[0]'), {
        text: 'She walks home.',
        lang: 'en-US',
        rate: 0.8,
        voice: 'en-US',
      });
      assert.equal(
        await evaluate('document.querySelector("dialog").innerText.includes("她步行回家。")'),
        false,
      );
      await evaluate('document.querySelector(\'[aria-label="按正常速度播放每日一句"]\').click()');
      await evaluate('document.querySelector(\'[aria-label="慢速播放每日一句"]\').click()');
      await until('window.dailySentenceSpeech.spoken.length === 3');
      await delay(30);
      assert.equal(
        await evaluate('document.querySelector("[aria-live=polite]")?.textContent'),
        '正在慢速播放',
      );
      assert.equal(
        await evaluate('document.querySelector(\'[aria-label="停止播放每日一句"]\').disabled'),
        false,
      );
      await evaluate('document.querySelector(\'[aria-label="停止播放每日一句"]\').click()');
      await delay(30);
      assert.equal(await evaluate('window.dailySentenceSpeech.cancelCount'), 4);
      assert.equal(await evaluate('document.querySelector("[aria-live=polite]")?.textContent'), '');
      assert.equal(await evaluate('window.dailySentenceWrites.length'), writeCountBeforeReveal);
      await evaluate('document.querySelector("dialog button[aria-controls]").click()');
      await until('document.querySelector("dialog").innerText.includes("她步行回家。")');
      assert.equal(
        await evaluate('document.querySelector("dialog button[aria-expanded=true]")?.textContent'),
        '翻译与讲解已展开',
      );
      assert.equal(await evaluate('window.dailySentenceWrites.length'), writeCountBeforeReveal);
      await until(
        'window.dailyFeedbackFieldset()?.querySelector("p[role=status]")?.textContent.includes("无法确认当时的选择时间")',
      );
      assert.equal(
        await evaluate(
          'window.dailyFeedbackFieldset()?.querySelector("button[aria-pressed=true]")?.textContent',
        ),
        '有点难',
      );

      await evaluate(
        'window.dailyFeedbackFieldset()?.querySelector("button[aria-pressed=true]")?.click()',
      );
      await until(
        'window.feedbackRequests.length === 1 && !window.dailyFeedbackFieldset()?.querySelector("p[role=status]")',
      );
      assert.deepEqual(await evaluate('window.feedbackRequests[0]'), { difficulty: 'HARD' });
      assert.equal(await evaluate('window.legacySentence.difficultyTimestampReliable'), true);
      assert.equal(
        await evaluate(
          'window.dailyFeedbackFieldset()?.querySelector("button[aria-pressed=true]")?.textContent',
        ),
        '有点难',
      );

      await evaluate('document.querySelector(\'[aria-label="按正常速度播放每日一句"]\').click()');
      await until('window.dailySentenceSpeech.spoken.length === 4');
      const cancelCountBeforeLeaving = await evaluate('window.dailySentenceSpeech.cancelCount');
      await evaluate(
        `[...document.querySelectorAll('dialog button')].find(button => button.textContent.includes('回顾与收藏')).click()`,
      );
      await until('document.querySelector("dialog")?.textContent.includes("全部句子")');
      await until('window.dailySentenceSpeech.cancelCount > ' + cancelCountBeforeLeaving);
      await evaluate(
        `[...document.querySelectorAll('dialog button')].find(button => button.textContent.includes('待重新确认')).click()`,
      );
      await until(
        'document.querySelector("dialog [role=alert]")?.textContent.includes("服务暂时不可用")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("dialog").textContent.includes("没有待重新确认的旧难度反馈")',
        ),
        false,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("dialog").textContent.includes("They walk to work.")',
        ),
        false,
      );

      assert.equal(
        await evaluate('window.historyRequests.at(-1).includes("needsDifficultyReview=true")'),
        true,
      );
      await evaluate(
        `[...document.querySelectorAll('dialog button')].find(button => button.textContent.includes('重新加载')).click()`,
      );
      await until('document.querySelector("dialog").textContent.includes("待重新确认：太简单")');
      assert.equal(
        await evaluate(
          'document.querySelector("dialog").textContent.includes("He walks to work.")',
        ),
        false,
      );
      await evaluate(
        `[...document.querySelectorAll('dialog button')].find(button => button.textContent.includes('They walk to work.')).click()`,
      );
      await until('document.querySelector("dialog button[aria-controls]")');
      const otherSentenceBeforeReveal = await evaluate(
        'document.querySelector("dialog").innerText',
      );
      assert.ok(otherSentenceBeforeReveal.includes('They walk to work.'));
      assert.ok(!otherSentenceBeforeReveal.includes('他们步行上班。'));
      await evaluate('document.querySelector("dialog button[aria-controls]").click()');
      await until(
        'window.dailyFeedbackFieldset()?.querySelector("p[role=status]")?.textContent.includes("无法确认当时的选择时间")',
      );
      await evaluate(
        'window.dailyFeedbackFieldset()?.querySelector("button[aria-pressed=true]")?.click()',
      );
      await until(
        'window.olderSentence.difficultyTimestampReliable && !window.dailyFeedbackFieldset()?.querySelector("p[role=status]")',
      );
      await evaluate(
        `[...document.querySelectorAll('dialog button')].find(button => button.textContent.includes('回顾与收藏')).click()`,
      );
      await until(
        'document.querySelector("dialog").textContent.includes("没有待重新确认的旧难度反馈")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("dialog").textContent.includes("They walk to work.")',
        ),
        false,
      );

      await evaluate('document.querySelector(\'[aria-label="关闭每日一句"]\').click()');
      await until('!document.querySelector("dialog[open]")');
      await send('Page.navigate', {
        url: new URL('/dashboard?no-english=1&user=second', baseUrl).href,
      });
      await until('document.querySelector("#daily-sentence-heading")');
      await evaluate(`document.querySelector('[aria-label^="查看每日一句解析"]').click()`);
      await until('document.querySelector("dialog button[aria-controls]")');
      await until(
        'window.dailySentenceWrites.some(write => write.path.endsWith("/legacy-sentence/read"))',
      );
      const noVoiceWriteCount = await evaluate('window.dailySentenceWrites.length');
      await evaluate('document.querySelector(\'[aria-label="慢速播放每日一句"]\').click()');
      await until(
        'document.querySelector("[aria-live=polite]")?.textContent.includes("没有可用的英语语音")',
      );
      assert.equal(await evaluate('window.dailySentenceSpeech.spoken.length'), 0);
      assert.equal(
        await evaluate('document.querySelector("dialog").textContent.includes("She walks home.")'),
        true,
      );
      assert.equal(await evaluate('window.dailySentenceWrites.length'), noVoiceWriteCount);
      await evaluate(
        'window.dailySentenceSpeech.noEnglishVoice = false; window.speechSynthesis.dispatchEvent(new Event("voiceschanged"))',
      );
      await until(
        '!document.querySelector("[aria-live=polite]")?.textContent.includes("没有可用的英语语音")',
      );
      await evaluate('document.querySelector(\'[aria-label="按正常速度播放每日一句"]\').click()');
      await until('window.dailySentenceSpeech.spoken.length === 1');
      await evaluate('document.querySelector(\'[aria-label="关闭每日一句"]\').click()');
      await until('!document.querySelector("dialog[open]")');
      assert.ok(await evaluate('window.dailySentenceSpeech.cancelCount > 0'));
      assert.equal(await evaluate('document.querySelector("dialog[open]")'), null);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
