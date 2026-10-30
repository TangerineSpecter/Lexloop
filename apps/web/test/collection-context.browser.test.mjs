import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
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
    browser.on('error', (error) => {
      launchError = error;
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
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate(`Boolean(${expression})`)) return;
          await delay(100);
        }
        const pageState = await evaluate(
          `JSON.stringify({ url: location.href, body: document.body?.innerText, apiRequests: window.apiRequests })`,
        ).catch((error) => String(error));
        assert.fail(`Timed out waiting for ${expression}; page=${pageState}`);
      };
      const clickVisible = async (selector) => {
        await evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`,
        );
        const point = await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { x, y, visible: rect.width > 0 && rect.height > 0, enabled: !element.disabled, hit: hit === element || element.contains(hit), hitDescription: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().replace(/\\s+/g, '.') : '') : null };
        })()`);
        assert.ok(point?.visible, `Expected visible control: ${selector}`);
        assert.equal(point.enabled, true, `Expected enabled control: ${selector}`);
        assert.equal(
          point.hit,
          true,
          `Expected unobstructed control: ${selector}; hit=${point.hitDescription}`,
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
        fixture: Array.from({ length: 21 }, (_, index) =>
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
                  'Small habits matter in the long run. In the long run, simple routines help.',
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
      window.importRequests = [];
      window.importResolvers = [];
      window.importResult = { imported: 2, restored: 0, duplicates: 1 };
      window.failImportOnce = false;
      window.deferImportOnce = false;
      window.apiRequests = [];
      window.failNotebookPageTwoOnce = false;
      window.failFavoritePageTwoOnce = false;
      window.notebookSpeechAudit = [];
      window.notebookSpeechVoices = [{ lang: 'en-US', localService: true }];
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: function(text) { this.text = text; },
      });
      if (!window.speechSynthesis) throw new Error('SpeechSynthesis fixture is unavailable');
      Object.defineProperty(window.speechSynthesis, 'getVoices', {
        configurable: true,
        value: () => window.notebookSpeechVoices,
      });
      Object.defineProperty(window.speechSynthesis, 'cancel', {
        configurable: true,
        value() {},
      });
      Object.defineProperty(window.speechSynthesis, 'speak', {
        configurable: true,
        value(utterance) { window.notebookSpeechAudit.push(utterance.text); },
      });
      const notebookPages = ${JSON.stringify(notebookPages)};
      const nativeFetch = window.fetch;
      window.fetch = async (url, options) => {
        const path = String(url);
        if (path.includes('/api/v1/')) window.apiRequests.push(path);
        const userId = JSON.parse(localStorage.getItem('lexloop.session') || '{}').user?.id || 'fixture';
        if (path.includes('/api/v1/auth/me')) return Response.json({ id: userId });
        if (path.includes('/api/v1/learning-lab/lessons?')) return Response.json(${JSON.stringify(history)});
        if (path.includes('/api/v1/vocabulary/notebook')) {
          const params = new URL(path, location.origin).searchParams;
          const search = params.get('search')?.toLowerCase() || '';
          const page = Number(params.get('page') || 1);
          if (page === 2 && window.failNotebookPageTwoOnce) {
            window.failNotebookPageTwoOnce = false;
            return Response.json({ message: '模拟生词本分页失败' }, { status: 503 });
          }
          const items = notebookPages[userId] || [];
          const filtered = search ? items.filter(item => item.text.toLowerCase().includes(search)) : items;
          return Response.json({ items: filtered.slice((page - 1) * 20, page * 20), page, pageSize: 20, total: filtered.length, hasMore: page * 20 < filtered.length });
        }
        if (path.includes('/api/v1/daily-sentences?')) {
          const params = new URL(path, location.origin).searchParams;
          const page = Number(params.get('page') || 1);
          if (params.get('favorites') === 'true' && page === 2 && window.failFavoritePageTwoOnce) {
            window.failFavoritePageTwoOnce = false;
            return Response.json({ message: '模拟句子收藏分页失败' }, { status: 503 });
          }
          if (params.get('favorites') === 'true') {
            const id = userId + '-favorite-page-' + page;
            return Response.json({ items: [{
              id, dateKey: '2026-10-' + (page === 1 ? '28' : '29'),
              content: { english: 'Fixture sentence page ' + page + '.', chinese: '第 ' + page + ' 页译文', focus: 'daily practice' },
              readAt: null, favorite: true, difficulty: null, difficultyTimestampReliable: false,
            }], hasMore: page === 1 });
          }
        }
        if (path.includes('/api/v1/vocabulary/personal/items')) {
          const body = JSON.parse(options.body);
          if (path.endsWith('/import')) {
            window.importRequests.push(body);
            if (window.failImportOnce) {
              window.failImportOnce = false;
              return Response.json({ message: '服务暂时不可用' }, { status: 503 });
            }
            if (window.deferImportOnce) {
              window.deferImportOnce = false;
              return await new Promise(resolve => window.importResolvers.push(() => resolve(Response.json(window.importResult))));
            }
            return Response.json(window.importResult);
          }
          window.collectionRequests.push(body);
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

      const notebookPageReadsBeforeFailure = await evaluate(
        'window.apiRequests.filter((path) => path.includes("/api/v1/vocabulary/notebook")).length',
      );
      await evaluate(`(() => {
        window.failNotebookPageTwoOnce = true;
        document.querySelector('[aria-label="生词本分页"] button:last-child').click();
      })()`);
      await until(
        'document.querySelector("[role=alert]")?.innerText.includes("模拟生词本分页失败")',
      );
      assert.equal(
        await evaluate('document.querySelectorAll("article[data-notebook-word]").length'),
        0,
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("你的生词本还是空白的")'),
        false,
      );
      assert.equal(await evaluate('document.body.innerText.includes("第 2 页")'), true);
      assert.equal(
        await evaluate(
          'window.apiRequests.filter((path) => path.includes("/api/v1/vocabulary/notebook")).length',
        ),
        notebookPageReadsBeforeFailure + 1,
      );
      await evaluate('document.querySelector("[role=alert] button").click()');
      await until(
        'document.querySelector("[data-notebook-target]")?.textContent === "phrase number 21"',
      );
      assert.equal(
        await evaluate('document.querySelectorAll("article[data-notebook-word]").length'),
        1,
      );
      assert.equal(
        await evaluate(
          'window.apiRequests.filter((path) => path.includes("/api/v1/vocabulary/notebook")).length',
        ),
        notebookPageReadsBeforeFailure + 2,
      );
      await evaluate(
        'document.querySelector("[aria-label=生词本分页] button:first-child").click()',
      );
      await until('document.querySelectorAll("article[data-notebook-word]").length === 20');

      const importDetails = 'document.querySelector("[data-personal-vocabulary-import]")';
      await evaluate(`${importDetails}.querySelector('summary').click()`);
      const importInput = `${importDetails}.querySelector('[data-import-vocabulary-input]')`;
      const importSubmit = `${importDetails}.querySelector('[data-import-vocabulary-submit]')`;
      await evaluate(`(() => {
        const input = ${importInput};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'river\\t河流\\tThe river is wide.\\nnotice\\t注意到\\nRIVER\\t河流\\tThe river is wide.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(
        `${importDetails}.querySelector('[data-import-vocabulary-preview]')?.innerText.includes('识别 2 个不同词条')`,
      );
      assert.equal(await evaluate(`${importSubmit}.disabled`), false);
      assert.equal(await evaluate(`${importDetails}.innerText.includes('表内重复 1 项')`), true);
      const importsBeforeConflict = await evaluate('window.importRequests.length');
      await evaluate(`(() => {
        const input = ${importInput};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'river\\t河流\\tThe river is wide.\\nRIVER\\t河床\\tThe river is wide.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(
        `${importSubmit}.disabled && ${importDetails}.querySelector('[data-import-vocabulary-preview]')?.innerText.includes('第 2 行')`,
      );
      const conflictPreview = await evaluate(`(() => ({
        preview: ${importDetails}.querySelector('[data-import-vocabulary-preview]').innerText,
        source: ${importInput}.value,
      }))()`);
      assert.match(conflictPreview.preview, /第 2 行：.*第 1 行.*释义或例句不同/);
      assert.equal(
        conflictPreview.source.includes('RIVER') && conflictPreview.source.includes('河床'),
        true,
      );
      assert.equal(await evaluate('window.importRequests.length'), importsBeforeConflict);
      await evaluate(`(() => {
        const input = ${importInput};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'malformed row');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(`${importSubmit}.disabled`);
      assert.equal(await evaluate(`${importDetails}.innerText.includes('每行格式应为')`), true);
      await evaluate(`(() => {
        const input = ${importInput};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'river\\t河流\\tThe river is wide.\\nnotice\\t注意到\\nRIVER\\t河流\\tThe river is wide.');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.failImportOnce = true;
      })()`);
      await until(`!${importSubmit}.disabled`);
      await evaluate(`${importSubmit}.scrollIntoView({ block: 'center' })`);
      const importButtonBounds = await evaluate(
        `(() => { const box = ${importSubmit}.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
      );
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: importButtonBounds.x,
        y: importButtonBounds.y,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: importButtonBounds.x,
        y: importButtonBounds.y,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: importButtonBounds.x,
        y: importButtonBounds.y,
        button: 'left',
        clickCount: 1,
      });
      await until(
        'window.importRequests.length === 1 && document.querySelector("[data-personal-vocabulary-import] [role=status]")?.textContent.includes("服务暂时不可用")',
      );
      assert.equal(await evaluate(`${importInput}.value.includes('The river is wide.')`), true);
      assert.equal(await evaluate(`${importSubmit}.disabled`), false);
      assert.deepEqual(await evaluate('window.importRequests[0]'), {
        items: [
          { text: 'river', meaning: '河流', example: 'The river is wide.' },
          { text: 'notice', meaning: '注意到' },
        ],
      });
      await evaluate(`${importSubmit}.focus()`);
      await evaluate('window.deferImportOnce = true');
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
      await until(
        'window.importRequests.length === 2 && document.querySelector("[data-import-vocabulary-submit]").disabled',
      );
      assert.equal(await evaluate(`${importInput}.disabled`), true);
      await evaluate(`${importSubmit}.click()`);
      assert.equal(await evaluate('window.importRequests.length'), 2);
      await evaluate('window.importResolvers.shift()()');
      await until(
        'window.importRequests.length === 2 && document.querySelector("[data-personal-vocabulary-import] [role=status]")?.textContent.includes("已加入 2 个新词")',
      );
      assert.equal(
        await evaluate(
          `${importDetails}.querySelector('[role=status]').textContent.includes('表内重复 1 项、已有词条 1 项已跳过')`,
        ),
        true,
      );
      assert.equal(await evaluate(`${importInput}.value`), '');
      assert.equal(
        await evaluate(
          'window.apiRequests.some(path => path.includes("/vocabulary/personal/items/import"))',
        ),
        true,
      );

      await evaluate(`(() => {
        window.importResult = { imported: 0, restored: 1, duplicates: 0 };
        const input = ${importInput};
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'river\t新的释义');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(`!${importSubmit}.disabled`);
      await evaluate(`${importSubmit}.click()`);
      await until(
        'window.importRequests.length === 3 && document.querySelector("[data-personal-vocabulary-import] [role=status]")?.textContent.includes("恢复 1 个原词条")',
      );
      assert.equal(
        await evaluate(
          `${importDetails}.querySelector('[role=status]').textContent.includes('已有词条 0 项已跳过。新词加入复习；已有词条的释义和进度保留。')`,
        ),
        true,
      );

      const apiRequestsBeforeSpelling = await evaluate('window.apiRequests.length');
      await evaluate('window.originalNotebookRandom = Math.random; Math.random = () => 0');
      await evaluate('document.querySelector("[data-spelling-start]").click()');
      await until('document.activeElement?.matches("[data-spelling-answer-input]")');
      assert.equal(await evaluate('document.querySelector("[data-spelling-difference]")'), null);
      const firstSpellingDesktop = await evaluate(`(() => {
        const practice = document.querySelector('[data-notebook-spelling-practice]');
        const box = practice.getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, left: box.left, right: box.right, collectionHidden: document.querySelector('[data-notebook-collection-content]').hidden, visibleTarget: document.body.innerText.includes('take it for granted'), content: practice.innerText };
      })()`);
      assert.equal(firstSpellingDesktop.viewport, 1440);
      assert.ok(firstSpellingDesktop.page <= firstSpellingDesktop.viewport);
      assert.ok(
        firstSpellingDesktop.left >= 0 &&
          firstSpellingDesktop.right <= firstSpellingDesktop.viewport,
      );
      assert.equal(firstSpellingDesktop.collectionHidden, true);
      assert.equal(firstSpellingDesktop.visibleTarget, false);
      assert.equal(firstSpellingDesktop.content.includes('take it for granted'), false);
      assert.equal(firstSpellingDesktop.content.includes('认为……理所当然'), true);
      await evaluate('document.querySelector("[data-spelling-answer-input]").form.requestSubmit()');
      await until(
        'document.querySelector("[data-spelling-notice]")?.textContent.includes("先写下听到的拼写")',
      );
      assert.equal(await evaluate('document.querySelector("[data-spelling-result]")'), null);
      assert.equal(await evaluate('document.querySelector("[data-spelling-difference]")'), null);
      assert.equal(
        await evaluate('document.body.innerText.includes("take it for granted")'),
        false,
      );
      await evaluate('document.querySelector("[data-spelling-play]").click()');
      assert.equal(await evaluate('window.notebookSpeechAudit.at(-1)'), 'take it for granted');
      assert.equal(
        await evaluate(
          'document.querySelector("[data-notebook-spelling-practice]").innerText.includes("take it for granted")',
        ),
        false,
      );
      await evaluate(`(() => {
        const input = document.querySelector('[data-spelling-answer-input]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ' TAKE   IT FOR GRANTED ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate('document.querySelector("[data-spelling-answer-input]").form.requestSubmit()');
      await until(
        'document.querySelector("[data-spelling-result]")?.textContent.includes("拼写与目标词一致")',
      );
      assert.equal(
        await evaluate('document.querySelector("[data-spelling-revealed]").textContent'),
        'take it for granted',
      );
      assert.equal(await evaluate('document.querySelector("[data-spelling-difference]")'), null);
      const requestsAfterCorrectSpelling = await evaluate('window.apiRequests.length');
      assert.equal(requestsAfterCorrectSpelling, apiRequestsBeforeSpelling);

      await evaluate('document.querySelector("[data-spelling-start]").click()');
      await until(
        'document.querySelector("[data-notebook-spelling-practice]").innerText.includes("从长远来看")',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-notebook-spelling-practice]").innerText.includes("in the long run")',
        ),
        false,
      );
      await evaluate('document.querySelector("[data-spelling-play]").click()');
      assert.equal(await evaluate('window.notebookSpeechAudit.at(-1)'), 'in the long run');
      await evaluate(`(() => {
        const input = document.querySelector('[data-spelling-answer-input]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'in the long runn');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate('document.querySelector("[data-spelling-answer-input]").form.requestSubmit()');
      await until(
        'document.querySelector("[data-spelling-result]")?.textContent.includes("拼写不一致")',
      );
      assert.equal(
        await evaluate('document.querySelector("[data-spelling-revealed]").textContent'),
        'in the long run',
      );
      assert.deepEqual(
        await evaluate(
          'Array.from(document.querySelectorAll("[data-spelling-issue-kind=extra] code"), node => node.textContent)',
        ),
        ['n'],
      );
      assert.equal(
        await evaluate('document.querySelector("[data-spelling-diff-kind=extra]").textContent'),
        'n',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-spelling-result]").textContent.includes("橙色删除线标记多写")',
        ),
        true,
      );

      await evaluate('document.querySelector("[data-spelling-start]").click()');
      await until(
        'document.querySelector("[data-notebook-spelling-practice]").innerText.includes("认为……理所当然")',
      );
      await evaluate('window.notebookSpeechVoices = []');
      await evaluate('document.querySelector("[data-spelling-play]").click()');
      await until(
        'document.querySelector("[data-spelling-notice]")?.textContent.includes("标记为本地服务")',
      );
      await evaluate('document.querySelector("[data-spelling-reveal]").click()');
      assert.equal(
        await evaluate('document.querySelector("[data-spelling-revealed]").textContent'),
        'take it for granted',
      );
      assert.equal(await evaluate('window.apiRequests.length'), apiRequestsBeforeSpelling);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileSpellingLayout = await evaluate(`(() => {
        const practice = document.querySelector('[data-notebook-spelling-practice]');
        const input = document.querySelector('[data-spelling-answer-input]').getBoundingClientRect();
        const button = document.querySelector('[data-spelling-end]').getBoundingClientRect();
        const box = practice.getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, left: box.left, right: box.right, inputLeft: input.left, inputRight: input.right, buttonLeft: button.left, buttonRight: button.right };
      })()`);
      assert.equal(mobileSpellingLayout.viewport, 390);
      assert.ok(mobileSpellingLayout.page <= mobileSpellingLayout.viewport);
      assert.ok(
        mobileSpellingLayout.left >= 0 &&
          mobileSpellingLayout.right <= mobileSpellingLayout.viewport,
      );
      assert.ok(
        mobileSpellingLayout.inputLeft >= 0 &&
          mobileSpellingLayout.inputRight <= mobileSpellingLayout.viewport,
      );
      assert.ok(
        mobileSpellingLayout.buttonLeft >= 0 &&
          mobileSpellingLayout.buttonRight <= mobileSpellingLayout.viewport,
      );
      await evaluate('document.querySelector("[data-spelling-start]").click()');
      await until('document.activeElement?.matches("[data-spelling-answer-input]")');
      await evaluate(`(() => {
        const input = document.querySelector('[data-spelling-answer-input]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'clearly incorrect answer');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate('document.querySelector("[data-spelling-answer-input]").form.requestSubmit()');
      await until('document.querySelector("[data-spelling-difference]")');
      const mobileDifferenceLayout = await evaluate(`(() => {
        const practice = document.querySelector('[data-notebook-spelling-practice]');
        const difference = document.querySelector('[data-spelling-difference]').getBoundingClientRect();
        return { page: document.documentElement.scrollWidth, viewport: innerWidth, left: difference.left, right: difference.right, practiceRight: practice.getBoundingClientRect().right, limited: !!document.querySelector('[data-spelling-difference-limit]') };
      })()`);
      assert.equal(mobileDifferenceLayout.viewport, 390);
      assert.ok(mobileDifferenceLayout.page <= mobileDifferenceLayout.viewport);
      assert.ok(mobileDifferenceLayout.left >= 0);
      assert.ok(mobileDifferenceLayout.right <= mobileDifferenceLayout.viewport);
      assert.ok(mobileDifferenceLayout.right <= mobileDifferenceLayout.practiceRight);
      assert.equal(mobileDifferenceLayout.limited, false);
      await evaluate('document.querySelector("[data-spelling-start]").click()');
      await until('document.activeElement?.matches("[data-spelling-answer-input]")');
      await evaluate(`(() => {
        const input = document.querySelector('[data-spelling-answer-input]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'x'.repeat(241));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate('document.querySelector("[data-spelling-answer-input]").form.requestSubmit()');
      await until('document.querySelector("[data-spelling-difference-limit]")');
      assert.equal(
        await evaluate('document.querySelector("[data-spelling-difference] mark")'),
        null,
      );
      assert.equal(await evaluate('window.apiRequests.length'), apiRequestsBeforeSpelling);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
      await evaluate('document.querySelector("[data-spelling-end]").focus()');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await until(
        '!document.querySelector("[data-notebook-collection-content]").hidden && document.activeElement?.matches("[data-spelling-start]")',
      );
      assert.equal(
        await evaluate('document.querySelectorAll("article[data-notebook-word]").length'),
        20,
      );
      assert.equal(
        await evaluate('document.activeElement?.matches("[data-spelling-start]")'),
        true,
      );
      await evaluate('Math.random = window.originalNotebookRandom');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const largePaste = Array.from(
        { length: 40 },
        (_, index) => `bounded${index}\t释义${index}`,
      ).join('\n');
      const previewFrameMs = await evaluate(`(async () => {
        const input = ${importInput};
        const started = performance.now();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(largePaste)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started))));
      })()`);
      assert.ok(
        previewFrameMs < 500,
        `40-row import preview exceeded the 500 ms frame budget: ${previewFrameMs.toFixed(1)} ms`,
      );
      await until(
        `${importDetails}.querySelector('[data-import-vocabulary-preview]')?.innerText.includes('识别 40 个不同词条')`,
      );
      const desktopImportLayout = await evaluate(`(() => {
        const detail = ${importDetails};
        const input = ${importInput}.getBoundingClientRect();
        const button = ${importSubmit}.getBoundingClientRect();
        return { page: document.documentElement.scrollWidth, viewport: innerWidth, inputRight: input.right, buttonRight: button.right, inputVisible: input.width > 0 && input.height > 0 };
      })()`);
      assert.equal(desktopImportLayout.viewport, 1440);
      assert.equal(desktopImportLayout.inputVisible, true);
      assert.ok(desktopImportLayout.page <= desktopImportLayout.viewport);
      assert.ok(desktopImportLayout.inputRight <= desktopImportLayout.viewport);
      assert.ok(desktopImportLayout.buttonRight <= desktopImportLayout.viewport);
      console.log(`notebook import preview: 40 rows rendered in ${previewFrameMs.toFixed(1)} ms`);

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
        const importInput = document.querySelector('[data-import-vocabulary-input]')?.getBoundingClientRect();
        const importButton = document.querySelector('[data-import-vocabulary-submit]')?.getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, cardRight: cardBox?.right, buttonLeft: buttonBox?.left, buttonRight: buttonBox?.right, visible: Boolean(buttonBox && buttonBox.width > 0 && buttonBox.height > 0), importInputRight: importInput?.right, importButtonRight: importButton?.right, importVisible: Boolean(importInput && importInput.width > 0 && importInput.height > 0) };
      })()`);
      assert.equal(mobileLayout.viewport, 390);
      assert.equal(mobileLayout.visible, true);
      assert.ok(mobileLayout.page <= mobileLayout.viewport);
      assert.ok(mobileLayout.cardRight <= mobileLayout.viewport);
      assert.ok(mobileLayout.buttonLeft >= 0 && mobileLayout.buttonRight <= mobileLayout.viewport);
      assert.equal(mobileLayout.importVisible, true);
      assert.ok(mobileLayout.importInputRight <= mobileLayout.viewport);
      assert.ok(mobileLayout.importButtonRight <= mobileLayout.viewport);

      await evaluate(`(() => {
        const form = document.querySelector('[data-notebook-filters]');
        const input = form.querySelector('input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'phrase number 3');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        form.requestSubmit();
      })()`);
      await until(
        'document.querySelector("[data-notebook-target]")?.textContent === "phrase number 3"',
      );
      assert.equal(await evaluate('document.querySelector("[data-context-start]").disabled'), true);
      assert.equal(
        await evaluate('document.querySelector("[data-context-unavailable]") !== null'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("[data-spelling-start]").disabled'),
        false,
      );

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

      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(100);
      const contextRequestsBefore = await evaluate('window.apiRequests.length');
      const contextStorageBefore = await evaluate(
        'JSON.stringify(Object.keys(localStorage).sort())',
      );
      const contextStartTime = await evaluate('performance.now()');
      await clickVisible('[data-context-start]');
      await until(
        'document.querySelector("[data-practice-mode]")?.dataset.practiceMode === "context"',
      );
      const contextPromptBeforeAnswer = await evaluate(`(() => {
        const prompt = document.querySelector('[data-context-prompt]');
        const practice = document.querySelector('[data-notebook-spelling-practice]');
        const box = practice.getBoundingClientRect();
        return { prompt: prompt.textContent, blanks: prompt.querySelectorAll('[data-context-blank]').length, viewport: innerWidth, page: document.documentElement.scrollWidth, left: box.left, right: box.right, collectionHidden: document.querySelector('[data-notebook-collection-content]').hidden, elapsedMs: performance.now() - ${contextStartTime} };
      })()`);
      assert.equal(contextPromptBeforeAnswer.blanks, 2);
      assert.equal(contextPromptBeforeAnswer.prompt.includes('in the long run'), false);
      assert.equal(contextPromptBeforeAnswer.viewport, 1440);
      assert.ok(contextPromptBeforeAnswer.page <= contextPromptBeforeAnswer.viewport);
      assert.ok(contextPromptBeforeAnswer.left >= 0 && contextPromptBeforeAnswer.right <= 1440);
      assert.equal(contextPromptBeforeAnswer.collectionHidden, true);
      assert.ok(contextPromptBeforeAnswer.elapsedMs < 500);
      assert.equal(await evaluate('document.body.innerText.includes("in the long run")'), false);

      await clickVisible('[data-spelling-submit]');
      await until(
        'document.querySelector("[data-spelling-notice]")?.textContent.includes("句中缺失")',
      );
      assert.equal(await evaluate('document.querySelector("[data-spelling-result]")'), null);
      assert.equal(
        await evaluate(
          'document.querySelector("[data-context-prompt]").textContent.includes("in the long run")',
        ),
        false,
      );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await until(
        '!document.querySelector("[data-notebook-collection-content]").hidden && document.activeElement?.matches("[data-spelling-start]")',
      );
      assert.equal(await evaluate('document.querySelector("[data-practice-mode]")'), null);

      await clickVisible('[data-context-start]');
      await until(
        'document.querySelector("[data-practice-mode]")?.dataset.practiceMode === "context"',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[data-context-prompt]").textContent.includes("in the long run")',
        ),
        false,
      );

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until('document.querySelector(".study-sidebar").getBoundingClientRect().right <= 0');
      const contextMobileLayout = await evaluate(`(() => {
        const practice = document.querySelector('[data-notebook-spelling-practice]').getBoundingClientRect();
        const prompt = document.querySelector('[data-context-prompt]').getBoundingClientRect();
        const input = document.querySelector('[data-spelling-answer-input]').getBoundingClientRect();
        const button = document.querySelector('[data-spelling-submit]').getBoundingClientRect();
        return { viewport: innerWidth, page: document.documentElement.scrollWidth, practiceLeft: practice.left, practiceRight: practice.right, promptLeft: prompt.left, promptRight: prompt.right, inputRight: input.right, buttonRight: button.right };
      })()`);
      assert.equal(contextMobileLayout.viewport, 390);
      assert.ok(contextMobileLayout.page <= 390);
      assert.ok(contextMobileLayout.practiceLeft >= 0 && contextMobileLayout.practiceRight <= 390);
      assert.ok(contextMobileLayout.promptLeft >= 0 && contextMobileLayout.promptRight <= 390);
      assert.ok(contextMobileLayout.inputRight <= 390 && contextMobileLayout.buttonRight <= 390);

      await send('Input.insertText', { text: 'IN THE LONG RUN' });
      await clickVisible('[data-spelling-submit]');
      await until(
        'document.querySelector("[data-spelling-result]")?.textContent.includes("拼写与原句中的目标表达一致")',
      );
      assert.equal(
        await evaluate('document.querySelector("[data-context-prompt]").textContent'),
        'Small habits matter in the long run. In the long run, simple routines help.',
      );
      assert.match(
        await evaluate('document.querySelector("[data-spelling-result]").textContent'),
        /本练习不计成绩，也不改变复习状态/,
      );
      assert.equal(await evaluate('window.apiRequests.length'), contextRequestsBefore);
      assert.equal(
        await evaluate('JSON.stringify(Object.keys(localStorage).sort())'),
        contextStorageBefore,
      );
      await clickVisible('[data-spelling-end]');
      await until('!document.querySelector("[data-notebook-collection-content]").hidden');

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
      assert.equal(
        await evaluate('document.querySelector("[data-import-vocabulary-input]").value'),
        '',
      );
      assert.equal(await evaluate('document.body.innerText.includes("认为……理所当然")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("in the long run")'), false);

      await send('Page.navigate', {
        url: new URL('/dashboard/notebook?tab=sentences', baseUrl).href,
      });
      await until('document.body?.innerText.includes("Fixture sentence page 1.") ?? false');
      const favoritePageReadsBeforeFailure = await evaluate(
        'window.apiRequests.filter((path) => path.includes("/api/v1/daily-sentences?")).length',
      );
      await evaluate(`(() => {
        window.failFavoritePageTwoOnce = true;
        document.querySelector('[aria-label="句子收藏分页"] button:last-child').click();
      })()`);
      await until(
        'document.querySelector("[role=alert]")?.innerText.includes("模拟句子收藏分页失败")',
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("Fixture sentence page 1.")'),
        false,
      );
      assert.equal(await evaluate('document.body.innerText.includes("还没有收藏的句子")'), false);
      assert.equal(await evaluate('document.body.innerText.includes("第 2 页")'), true);
      assert.equal(
        await evaluate(
          'window.apiRequests.filter((path) => path.includes("/api/v1/daily-sentences?")).length',
        ),
        favoritePageReadsBeforeFailure + 1,
      );
      const failedFavoritesLayout = await evaluate(
        `({ viewport: innerWidth, page: document.documentElement.scrollWidth })`,
      );
      assert.ok(failedFavoritesLayout.page <= failedFavoritesLayout.viewport);
      await evaluate('document.querySelector("[role=alert] button").click()');
      await until('document.body.innerText.includes("Fixture sentence page 2.")');
      assert.equal(
        await evaluate('document.body.innerText.includes("Fixture sentence page 1.")'),
        false,
      );
      assert.equal(
        await evaluate(
          'window.apiRequests.filter((path) => path.includes("/api/v1/daily-sentences?")).length',
        ),
        favoritePageReadsBeforeFailure + 2,
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
