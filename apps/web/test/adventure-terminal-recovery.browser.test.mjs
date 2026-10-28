import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'a lost terminal response recovers by account and can be dismissed safely',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'lexloop-adventure-terminal-test-'));
    const browser = spawnChromium(
      process.env.LAB_BROWSER_EXECUTABLE ?? 'chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', detached: process.platform !== 'win32' },
    );
    let launchError;
    let socket;
    const waiting = new Map();
    const browserErrors = [];
    let sequence = 0;
    browser.on('error', (error) => {
      launchError = error;
    });

    try {
      let port;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        try {
          port = Number(
            (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
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
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
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
          if (!localStorage.getItem('lexloop.session')) {
            localStorage.setItem('lexloop.session', JSON.stringify({
              accessToken: 'fixture-a',
              user: { id: 'learner-a', email: 'learner-a@example.invalid', displayName: 'Learner A', role: 'USER' },
            }));
            localStorage.setItem('lexloop.adventureRun.learner-a', 'run-ended-a');
          }
          window.recoveryFixture = JSON.parse(sessionStorage.getItem('adventure-terminal-fixture') || '{"reads":{},"writes":[]}');
          const terminalRun = {
            id: 'run-ended-a', status: 'COMPLETED', durationMinutes: 5, currentRoom: 0, roomCount: 1,
            playerHp: 100, playerMaxHp: 100, resource: 4, experienceEarned: 18, goldEarned: 8, materialsEarned: 0,
            floor: { id: 'floor-a', floorNumber: 1, title: '墨迹入口', cefrLevel: 'A1', targetCount: 2, exploration: 50, mastery: 0, bossUnlocked: false, completed: false, locked: false },
            rooms: [{ id: 'room-a', position: 0, type: 'COMBAT', status: 'CLEARED', enemyName: '漏墨史莱姆', enemyHp: 0, enemyMaxHp: 34 }],
            loot: [], challenge: null,
            lastAction: { challengeType: 'CHOICE', phase: 'ATTACK', prompt: '选择“稳定的”对应的英文', answer: ['steady'], score: 100, grade: 'PERFECT', damageDealt: 40, damageReceived: 0, feedback: { correct: true, message: '表达命中，攻击生效。', answer: 'steady', provisional: false } },
            availableSkills: [], canRetreat: false,
          };
          const floor = { id: 'floor-a', floorNumber: 1, title: '墨迹入口', cefrLevel: 'A1', targetCount: 2, exploration: 50, mastery: 0, bossUnlocked: false, completed: false, locked: false };
          const nativeFetch = window.fetch;
          window.fetch = async (input, options = {}) => {
            const path = String(input);
            const method = options.method ?? 'GET';
            const session = JSON.parse(localStorage.getItem('lexloop.session'));
            const userId = session.user.id;
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: userId });
            if (path.includes('/api/v1/adventure/profile')) return Response.json({
              id: 'profile-' + userId, level: 1, experience: 0, experienceToNextLevel: 100, gold: 0, materials: 0,
              skillPoints: 1, highestFloor: 0, soundEnabled: false,
              currentClass: { id: 'class-warrior', key: 'warrior', name: '战士', description: '', combatRole: 'VANGUARD', tier: 0, requiredLevel: 1, parentId: null, available: true, current: true },
              availableClasses: [], skills: [],
            });
            if (path.includes('/api/v1/adventure/dungeons')) return Response.json({ book: { id: 'book-a', title: '测试词书' }, floors: [floor] });
            if (path.includes('/api/v1/adventure/runs/active')) return Response.json(null);
            if (path.includes('/api/v1/adventure/runs/recover/')) {
              window.recoveryFixture.reads[userId] = (window.recoveryFixture.reads[userId] ?? 0) + 1;
              sessionStorage.setItem('adventure-terminal-fixture', JSON.stringify(window.recoveryFixture));
              if (userId !== 'learner-a') return Response.json({ message: '探索不存在' }, { status: 404 });
              if (window.recoveryFixture.reads[userId] <= 2) return Response.json({ message: '临时读取失败' }, { status: 503 });
              return Response.json(terminalRun);
            }
            if (path.includes('/api/v1/adventure/inventory')) return Response.json({ items: [], equipped: {} });
            if (path.includes('/api/v1/adventure/daily-quests')) return Response.json([]);
            if (path.includes('/api/v1/')) {
              window.recoveryFixture.writes.push({ path, method });
              sessionStorage.setItem('adventure-terminal-fixture', JSON.stringify(window.recoveryFixture));
              throw new Error('Unexpected API request: ' + method + ' ' + path);
            }
            return nativeFetch(input, options);
          };
        `,
      });

      const navigate = async () =>
        send('Page.navigate', { url: new URL('/dashboard/adventure', baseUrl).href });
      const reload = async () => evaluate('location.reload()');
      const expectMap = async () => {
        await until('document.body.innerText.includes("第 1 层远征准备")');
        assert.equal(await evaluate('document.body.innerText.includes("探索完成！")'), false);
      };

      await navigate();
      await expectMap();
      await until('document.body.innerText.includes("重试找回上次探索")');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.adventureRun.learner-a")'),
        'run-ended-a',
        'a temporary recovery error must retain the account-scoped run ID',
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("墨迹入口") && button.textContent.includes("2 个学习目标")).disabled',
        ),
        true,
        'starting another run must not overwrite a result whose recovery has not succeeded',
      );

      assert.equal(
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('重试找回上次探索'));
          button.focus();
          return button === document.activeElement && button.tabIndex === 0;
        })()`),
        true,
        'the recovery retry must be a keyboard-focusable native button',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("重试找回上次探索")).click()',
      );
      await until('window.recoveryFixture.reads["learner-a"] === 2');
      assert.equal(await evaluate('window.recoveryFixture.reads["learner-a"]'), 2);
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.adventureRun.learner-a")'),
        'run-ended-a',
        'a failed retry must retain the saved run so the learner can try again',
      );
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("墨迹入口") && button.textContent.includes("2 个学习目标")).disabled',
        ),
        true,
        'a failed retry must continue to prevent starting an unrelated run',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("重试找回上次探索")).click()',
      );
      await until('document.body.innerText.includes("探索完成！")');
      assert.equal(await evaluate('document.body.innerText.includes("+18 EXP")'), true);
      assert.equal(await evaluate('window.recoveryFixture.reads["learner-a"]'), 3);

      await reload();
      await until('document.body.innerText.includes("探索完成！")');
      assert.equal(await evaluate('window.recoveryFixture.reads["learner-a"]'), 4);

      await evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-b', user: { id: 'learner-b', email: 'learner-b@example.invalid', displayName: 'Learner B', role: 'USER' },
      }))`);
      await reload();
      await expectMap();
      assert.equal(await evaluate('window.recoveryFixture.reads["learner-b"] ?? 0'), 0);
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.adventureRun.learner-a")'),
        'run-ended-a',
      );

      await evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-a', user: { id: 'learner-a', email: 'learner-a@example.invalid', displayName: 'Learner A', role: 'USER' },
      }))`);
      await reload();
      await until('document.body.innerText.includes("探索完成！")');
      assert.equal(await evaluate('window.recoveryFixture.reads["learner-a"]'), 5);
      await evaluate(
        '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("返回地牢地图")).click()',
      );
      await expectMap();
      assert.equal(await evaluate('localStorage.getItem("lexloop.adventureRun.learner-a")'), null);

      await evaluate(`localStorage.setItem('lexloop.session', JSON.stringify({
        accessToken: 'fixture-c', user: { id: 'learner-c', email: 'learner-c@example.invalid', displayName: 'Learner C', role: 'USER' },
      }));
      localStorage.setItem('lexloop.adventureRun.learner-c', 'run-missing-c')`);
      await reload();
      await until('document.body.innerText.includes("上次探索记录已不存在")');
      assert.equal(await evaluate('window.recoveryFixture.reads["learner-c"]'), 1);
      assert.equal(await evaluate('localStorage.getItem("lexloop.adventureRun.learner-c")'), null);
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("button")].find((button) => button.textContent.includes("墨迹入口") && button.textContent.includes("2 个学习目标")).disabled',
        ),
        false,
        'a confirmed missing result must clear the stale marker and allow a new run',
      );
      assert.equal(await evaluate('window.recoveryFixture.writes.length'), 0);
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profileDir);
      await rm(profileDir, { recursive: true, force: true });
    }
  },
);
