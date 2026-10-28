import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'word accuracy rankings show their sample size without calling it stable mastery',
  { skip: !baseUrl, timeout: 30_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-statistics-sample-test-'));
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
    const waiting = new Map();
    let sequence = 0;
    browser.on('error', (error) => (launchError = error));
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
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A page transition may briefly replace the current execution context.
          }
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };

      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1425,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture', user: { id: 'learner-a', email: 'fixture@example.invalid', displayName: 'Fixture', role: 'USER' } }));
          window.statisticsFixture = {
            activeDays: 1, activity: Array.from({ length: 7 }, (_, index) => ({ label: '10 月 ' + (21 + index) + ' 日', words: index === 6 ? 1 : 0, questions: index === 6 ? 3 : 0, studySeconds: 0, scenarios: 0, assessments: 0, today: index === 6 })),
            chart: Array.from({ length: 7 }, (_, index) => ({ label: index === 6 ? '今天' : '周' + (index + 1), words: index === 6 ? 1 : 0, completed: index === 6, today: index === 6 })),
            currentStreak: 1, learnedWords: 2, masteredWords: 0, newWords: 1, reviewWords: 3, attemptCount: 3, accuracy: 67, averageResponseMs: 900, studySeconds: 3, completedPlans: 0, completedScenarios: 0, completedAssessments: 0,
            summary: '本期有 1 天留下学习记录，共完成 3 道题和 0 次场景练习。', suggestion: '继续复习。', versusPrevious: 100,
            rankings: {
              reviews: [], unfamiliar: [],
              errorRate: [{ word: 'mixed', rate: 50, count: 2 }],
              accuracy: [{ word: 'single', rate: 100, count: 1 }, { word: 'mixed', rate: 50, count: 2 }]
            }
          };
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'learner-a' });
            if (path.includes('/api/v1/reports/statistics')) return Response.json(window.statisticsFixture);
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 1, todayActive: true });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 2, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.includes('/api/v1/')) return Response.json([]);
            return nativeFetch(url, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await until('document.querySelector(".streak-count b")?.textContent === "1"');
      await until(
        '[...document.querySelectorAll("button")].some(button => button.textContent.includes("学习统计"))',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find(button => button.textContent.includes("学习统计")).click()',
      );
      await until('document.querySelector(".statistics-ranking-card.is-accuracy li")');

      const result = await evaluate(`(() => {
        const accuracy = document.querySelector('.statistics-ranking-card.is-accuracy');
        const errorRate = document.querySelector('.statistics-ranking-card.is-error-rate');
        return {
          accuracyValues: [...accuracy.querySelectorAll('li em')].map(node => node.innerText),
          errorValues: [...errorRate.querySelectorAll('li em')].map(node => node.innerText),
          accuracyHint: accuracy.querySelector('p').innerText,
          errorHint: errorRate.querySelector('p').innerText
        };
      })()`);
      assert.match(result.accuracyValues[0], /100\.0%[\s\S]*1 题/);
      assert.match(result.accuracyValues[1], /50\.0%[\s\S]*2 题/);
      assert.match(result.errorValues[0], /50\.0%[\s\S]*2 题/);
      assert.match(result.accuracyHint, /不代表稳定掌握/);
      assert.match(result.errorHint, /题数较少时仅作线索/);
      assert.doesNotMatch(`${result.accuracyHint} ${result.errorHint}`, /说明掌握得越稳定/);

      const assertStatisticsLayout = async (width) => {
        const layout = await evaluate(`(() => {
          const selectors = ['.statistics-page', '.statistics-heading', '.statistics-history-link', '.statistics-range', '.statistics-chart', '.statistics-ranking-grid'];
          const elements = selectors.map(selector => {
            const element = document.querySelector(selector);
            if (!element) return { selector, missing: true };
            const rect = element.getBoundingClientRect();
            return { selector, left: rect.left, right: rect.right, width: rect.width, height: rect.height, display: getComputedStyle(element).display };
          });
          return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, elements };
        })()`);
        assert.equal(layout.viewport, width);
        assert.ok(
          layout.documentWidth <= width,
          `${width}px statistics page overflows horizontally: ${JSON.stringify(layout)}`,
        );
        for (const element of layout.elements) {
          assert.ok(!element.missing, `${width}px layout is missing ${element.selector}`);
          assert.ok(
            element.width > 0 && element.height > 0,
            `${width}px ${element.selector} is not visible`,
          );
          assert.ok(
            element.left >= -1 && element.right <= width + 1,
            `${width}px ${element.selector} crosses the viewport: ${JSON.stringify(element)}`,
          );
        }
        return layout;
      };

      const desktopLayout = await assertStatisticsLayout(1425);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileLayout = await assertStatisticsLayout(390);
      process.stdout.write(
        `statistics layout: desktop ${desktopLayout.documentWidth}/${desktopLayout.viewport}px, mobile ${mobileLayout.documentWidth}/${mobileLayout.viewport}px; key regions visible\n`,
      );
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
