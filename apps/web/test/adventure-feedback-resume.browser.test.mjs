import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'adventure restores the previous saved question and answer after a page refresh',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-adventure-feedback-test-'));
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
    const browserErrors = [];
    browser.on('error', (error) => {
      launchError = error;
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
            result.result?.description ??
              result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text,
          );
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A reload briefly replaces the JavaScript execution context.
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
          localStorage.setItem('lexloop.session', JSON.stringify({
            accessToken: 'fixture-token',
            user: { id: 'learner-a', email: 'learner-a@example.invalid', displayName: 'Learner A', role: 'USER' },
          }));
          window.adventureFixture = JSON.parse(sessionStorage.getItem('adventure-fixture') || '{"activeReads":0,"writes":[]}');
          const previousRun = {
            id: 'run-a', status: 'ACTIVE', durationMinutes: 5, currentRoom: 0, roomCount: 3,
            playerHp: 82, playerMaxHp: 100, resource: 3, experienceEarned: 0, goldEarned: 0, materialsEarned: 0,
            floor: { id: 'floor-a', floorNumber: 1, title: '墨迹入口', cefrLevel: 'A1', targetCount: 12, exploration: 0, mastery: 0, bossUnlocked: false, completed: false, locked: false },
            rooms: [{ id: 'room-a', position: 0, type: 'COMBAT', status: 'ACTIVE', enemyName: '漏墨史莱姆', enemyHp: 34, enemyMaxHp: 34 }],
            loot: [],
            challenge: { id: 'challenge-next', type: 'CHOICE', phase: 'BLOCK', prompt: '选择“耐心的”对应的英文', options: ['patient', 'impatient'], hint: '选择只能提供识别证据，之后还需要主动召回。' },
            lastAction: {
              challengeType: 'CHOICE', phase: 'ATTACK', prompt: '选择“稳定的”对应的英文', answer: ['steady'],
              score: 0, grade: 'MISS', damageDealt: 0, damageReceived: 0,
              feedback: { correct: false, message: 'AI 评分暂不可用；已找到目标词的完整拼写，但无法确认句子语法、搭配或语义，本次不计为正确。', answer: 'I can be steady.', provisional: true },
            },
            availableSkills: [], canRetreat: false,
          };
          const profile = {
            id: 'profile-a', level: 1, experience: 0, experienceToNextLevel: 100, gold: 0, materials: 0,
            skillPoints: 1, highestFloor: 0, soundEnabled: false,
            currentClass: { id: 'class-warrior', key: 'warrior', name: '战士', description: '', combatRole: 'VANGUARD', tier: 0, requiredLevel: 1, parentId: null, available: true, current: true },
            availableClasses: [], skills: [],
          };
          const floor = previousRun.floor;
          const nativeFetch = window.fetch;
          window.fetch = async (input, options = {}) => {
            const path = String(input);
            const method = options.method ?? 'GET';
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'learner-a' });
            if (path.includes('/api/v1/adventure/profile')) return Response.json(profile);
            if (path.includes('/api/v1/adventure/dungeons')) return Response.json({ book: { id: 'book-a', title: '测试词书' }, floors: [floor] });
            if (path.includes('/api/v1/adventure/runs/active')) {
              window.adventureFixture.activeReads += 1;
              sessionStorage.setItem('adventure-fixture', JSON.stringify(window.adventureFixture));
              return Response.json(previousRun);
            }
            if (path.includes('/api/v1/adventure/inventory')) return Response.json({ items: [], equipped: {} });
            if (path.includes('/api/v1/adventure/daily-quests')) return Response.json([]);
            if (path.includes('/api/v1/')) {
              window.adventureFixture.writes.push({ path, method });
              sessionStorage.setItem('adventure-fixture', JSON.stringify(window.adventureFixture));
              throw new Error('Unexpected API request: ' + method + ' ' + path);
            }
            return nativeFetch(input, options);
          };
        `,
      });

      await send('Page.navigate', { url: new URL('/dashboard/adventure', baseUrl).href });
      const assertRecovered = async () => {
        await until('document.querySelector("aside[aria-label]")');
        assert.equal(
          await evaluate(
            'document.querySelector("aside[aria-label]").innerText.includes("选择“稳定的”对应的英文")',
          ),
          true,
        );
        assert.equal(
          await evaluate(
            'document.querySelector("aside[aria-label]").innerText.includes("你的回答：steady")',
          ),
          true,
        );
        assert.equal(
          await evaluate(
            'document.querySelector("aside[aria-label]").innerText.includes("参考：I can be steady.")',
          ),
          true,
        );
        assert.equal(
          await evaluate(
            'document.querySelector("aside[aria-label] p[class*=provisional]").textContent.includes("不计为正确")',
          ),
          true,
        );
        assert.equal(
          await evaluate(
            'document.querySelector("aside[aria-label] small").textContent.includes("无法确认语法、搭配或语义")',
          ),
          true,
        );
        assert.notEqual(
          await evaluate(
            'getComputedStyle(document.querySelector("aside[aria-label] p[class*=provisional]")).backgroundColor',
          ),
          'rgb(255, 240, 232)',
        );
        assert.equal(
          await evaluate('document.querySelector("form h1").textContent'),
          '选择“耐心的”对应的英文',
        );
      };
      await assertRecovered();
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(150);
      assert.equal(
        await evaluate(
          'document.querySelector("aside[aria-label]").getBoundingClientRect().right <= innerWidth',
        ),
        true,
      );
      await evaluate('location.reload()');
      await assertRecovered();
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await delay(150);
      assert.equal(
        await evaluate(
          'document.querySelector("aside[aria-label]").getBoundingClientRect().right <= innerWidth',
        ),
        true,
      );
      await until('window.adventureFixture.activeReads >= 2');
      assert.equal(await evaluate('window.adventureFixture.writes.length'), 0);
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profile);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
