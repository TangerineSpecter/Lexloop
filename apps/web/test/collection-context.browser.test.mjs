import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

// Opt in against a running Web build. Only API fixtures are used, never a real
// account or database. Chromium is isolated in a temporary browser profile.
test(
  'switching reading history replaces collection drafts and saves the current source',
  {
    skip: !baseUrl,
    timeout: 30_000,
  },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-collection-test-'));
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
    browser.on('error', (error) => {
      launchError = error;
    });
    let socket;
    let closed = false;
    browser.on('close', () => {
      closed = true;
    });
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
          if (await evaluate(`Boolean(${expression})`)) return;
          await delay(100);
        }
        const pageState = await evaluate(
          `JSON.stringify({ url: location.href, body: document.body?.innerText, apiRequests: window.apiRequests })`,
        ).catch((error) => String(error));
        assert.fail(`Timed out waiting for ${expression}; page=${pageState}`);
      };
      const lesson = (id) => ({
        id,
        kind: 'READING',
        status: 'READY',
        evidence: [],
        answers: null,
        score: null,
        error: null,
        createdAt: '2026-10-22T00:00:00.000Z',
        submittedAt: null,
        content: {
          title: `Lesson ${id}`,
          introduction: 'Fixture reading',
          targets: [],
          topics: [],
          sentences: [{ english: `${id} original sentence.`, chinese: '译文', note: '讲解' }],
          questions: [{ id: 'q1', prompt: 'Choose one', options: ['a', 'b', 'c'] }],
        },
      });
      const history = { items: [lesson('A'), lesson('B')], hasMore: false };
      const makeNotebookWord = (userId, index, text, meaning, example) => ({
        id: `${userId}-word-${index}`,
        wordId: `${userId}-vocabulary-${index}`,
        text,
        type: 'PHRASE',
        meaning,
        example,
        sourceScenario: '精读收藏',
        sourceType: 'READING',
        state: 'REVIEWING',
        nextReviewAt: null,
      });
      const notebookPages = {
        fixture: Array.from({ length: 20 }, (_, index) =>
          index === 0
            ? makeNotebookWord(
                'fixture',
                index,
                'take it for granted',
                '认为……理所当然',
                'We often take our good health for granted.',
              )
            : index === 1
              ? makeNotebookWord(
                  'fixture',
                  index,
                  'in the long run',
                  '从长远来看',
                  'Small habits matter in the long run.',
                )
              : makeNotebookWord(
                  'fixture',
                  index,
                  `phrase number ${index + 1}`,
                  `第 ${index + 1} 条收藏释义`,
                  `This is example number ${index + 1}.`,
                ),
        ),
        'fixture-b': [
          makeNotebookWord(
            'fixture-b',
            0,
            'on the other hand',
            '另一方面',
            'On the other hand, we can wait.',
          ),
        ],
      };
      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
      if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'fixture', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
      window.collectionRequests = [];
      window.apiRequests = [];
      const notebookPages = ${JSON.stringify(notebookPages)};
      const nativeFetch = window.fetch;
      window.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/api/v1/')) window.apiRequests.push(path);
        const userId = JSON.parse(localStorage.getItem('lexloop.session') || '{}').user?.id || 'fixture';
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: userId });
        if (path.includes('/api/v1/learning-lab/lessons?')) return Response.json(${JSON.stringify(history)});
        if (path.includes('/api/v1/vocabulary/notebook')) {
          const search = new URL(path, location.origin).searchParams.get('search')?.toLowerCase() || '';
          const items = notebookPages[userId] || [];
          const filtered = search ? items.filter(item => item.text.toLowerCase().includes(search)) : items;
          return Response.json({ items: filtered, page: 1, pageSize: 20, total: filtered.length, hasMore: false });
        }
        if (path.includes('/api/v1/vocabulary/personal/items')) {
          window.collectionRequests.push(JSON.parse(options.body));
          return Response.json({ id: 'captured' });
        }
        if (path.includes('/api/v1/')) throw new Error('Unexpected API request in browser fixture');
        return nativeFetch(url, options);
      };
    `,
      });
      await send('Page.navigate', {
        url: new URL('/dashboard/notebook?tab=reading', baseUrl).href,
      });
      await until('document.body && document.querySelector("textarea")');
      assert.equal(
        await evaluate('document.querySelector("textarea").value'),
        'A original sentence.',
      );
      // A real typed draft must also be discarded when switching source context.
      await evaluate(`(() => {
      const textarea = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Draft for A');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('button')].find(button => button.textContent.includes('Lesson B')).click();
    })()`);
      await until('document.querySelector("h3").textContent === "Lesson B"');
      assert.equal(
        await evaluate('document.querySelector("textarea").value'),
        'B original sentence.',
      );
      await evaluate(`(() => {
      const form = document.querySelector('details form');
      form.closest('details').open = true;
      [...form.querySelectorAll('input')].forEach((input, index) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, index ? '语境词义' : 'river');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    })()`);
      await evaluate(`document.querySelector('details form button').click()`);
      await until('window.collectionRequests.length === 1');
      assert.deepEqual(await evaluate('window.collectionRequests[0]'), {
        text: 'river',
        type: 'WORD',
        meaning: '语境词义',
        example: 'B original sentence.',
        sourceScenario: 'Lesson B',
        sourceType: 'READING',
      });

      await send('Page.navigate', {
        url: new URL('/dashboard/notebook?tab=words', baseUrl).href,
      });
      await until('document.querySelectorAll("article[data-notebook-word]").length === 20');
      const desktopLayout = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('article[data-notebook-word]')];
        const first = cards[0]?.getBoundingClientRect();
        const last = cards.at(-1)?.getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, cards: cards.length, firstLeft: first?.left, lastRight: last?.right };
      })()`);
      assert.equal(desktopLayout.viewport, 1440);
      assert.equal(desktopLayout.cards, 20);
      assert.ok(desktopLayout.page <= desktopLayout.viewport);
      assert.ok(desktopLayout.firstLeft >= 0 && desktopLayout.lastRight <= desktopLayout.viewport);

      const requestsBeforeRecall = await evaluate('window.apiRequests.length');
      const firstCard = 'document.querySelector("article[data-notebook-word]")';
      assert.equal(await evaluate(`${firstCard}.innerText.includes('认为……理所当然')`), true);
      await evaluate(`(() => {
        window.notebookRecallPaintMs = null;
        document.querySelector('[data-notebook-recall-mode]').addEventListener('click', () => {
          const startedAt = performance.now();
          requestAnimationFrame(() => { window.notebookRecallPaintMs = performance.now() - startedAt; });
        }, { once: true });
      })()`);
      await evaluate('document.querySelector("[data-notebook-recall-mode]").focus()');
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
      await until('Number.isFinite(window.notebookRecallPaintMs)');
      const recallPaintMs = await evaluate('window.notebookRecallPaintMs');
      assert.ok(
        recallPaintMs < 250,
        `20-item recall toggle missed the 250 ms frame budget: ${recallPaintMs} ms`,
      );
      console.log(
        `notebook recall mode: 20 cards, click-to-next-paint ${recallPaintMs.toFixed(1)} ms`,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-notebook-recall-mode]").getAttribute("aria-pressed")',
        ),
        'true',
      );
      assert.equal(await evaluate(`${firstCard}.innerText.includes('认为……理所当然')`), false);
      assert.equal(
        await evaluate('document.querySelectorAll("[data-notebook-meaning]").length'),
        20,
      );
      assert.equal(
        await evaluate(`${firstCard}.querySelector('[data-notebook-meaning]').textContent`),
        '释义已隐藏。先在心里回想，再揭晓。',
      );
      await evaluate(`${firstCard}.querySelector('[data-meaning-recall]').click()`);
      assert.equal(
        await evaluate(
          `${firstCard}.querySelector('[data-meaning-recall]').getAttribute('aria-expanded')`,
        ),
        'true',
      );
      assert.equal(
        await evaluate(`${firstCard}.querySelector('[data-notebook-meaning]').textContent`),
        '认为……理所当然',
      );
      assert.equal(await evaluate('window.apiRequests.length'), requestsBeforeRecall);

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const mobileLayout = await evaluate(`(() => {
        const button = document.querySelector('article[data-notebook-word] [data-meaning-recall]');
        const card = button?.closest('article');
        const cardBox = card?.getBoundingClientRect();
        const buttonBox = button?.getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, cardRight: cardBox?.right, buttonLeft: buttonBox?.left, buttonRight: buttonBox?.right, visible: Boolean(buttonBox && buttonBox.width > 0 && buttonBox.height > 0) };
      })()`);
      assert.equal(mobileLayout.viewport, 390);
      assert.equal(mobileLayout.visible, true);
      assert.ok(mobileLayout.page <= mobileLayout.viewport);
      assert.ok(mobileLayout.cardRight <= mobileLayout.viewport);
      assert.ok(mobileLayout.buttonLeft >= 0 && mobileLayout.buttonRight <= mobileLayout.viewport);

      await evaluate(`(() => {
        const form = document.querySelector('[data-notebook-filters]');
        const input = form.querySelector('input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'run');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        form.requestSubmit();
      })()`);
      await until(
        'document.querySelector("[data-notebook-target]")?.textContent === "in the long run"',
      );
      assert.equal(
        await evaluate('document.querySelectorAll("article[data-notebook-word]").length'),
        1,
      );
      assert.equal(
        await evaluate('document.querySelector("[data-notebook-meaning]").textContent'),
        '释义已隐藏。先在心里回想，再揭晓。',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-meaning-recall]").getAttribute("aria-expanded")',
        ),
        'false',
      );

      await evaluate(`(() => {
        const session = JSON.parse(localStorage.getItem('lexloop.session'));
        session.accessToken = 'fixture-b-token';
        session.user = { id: 'fixture-b', email: 'b@example.invalid', displayName: 'Fixture B', role: 'USER' };
        localStorage.setItem('lexloop.session', JSON.stringify(session));
        location.reload();
      })()`);
      await until(
        'document.querySelector("[data-notebook-target]")?.textContent === "on the other hand"',
      );
      assert.equal(
        await evaluate('document.querySelectorAll("article[data-notebook-word]").length'),
        1,
      );
      assert.equal(
        await evaluate('document.querySelector("[data-notebook-meaning]").textContent'),
        '另一方面',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-notebook-recall-mode]").getAttribute("aria-pressed")',
        ),
        'false',
      );
      assert.equal(await evaluate('document.body.innerText.includes("认为……理所当然")'), false);
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
