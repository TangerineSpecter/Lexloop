import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'dungeon route lets learners choose a persisted, responsive practice focus',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'lexloop-adventure-focus-test-'));
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
    let socket;
    let launchError;
    let sequence = 0;
    const waiting = new Map();
    const browserErrors = [];
    browser.on('error', (error) => {
      launchError = error;
    });

    try {
      let port;
      for (let attempt = 0; attempt < 100; attempt += 1) {
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
          if (message.method === 'Runtime.exceptionThrown')
            browserErrors.push(
              message.params.exceptionDetails.exception?.description ??
                message.params.exceptionDetails.text,
            );
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
          throw new Error(result.result?.description ?? result.exceptionDetails.text);
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (await evaluate(`Boolean(${expression})`)) return;
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };
      const clickSelector = async (selector) => {
        const rect = await evaluate(`(() => {
          const item = document.querySelector(${JSON.stringify(selector)});
          if (!item) return null;
          item.scrollIntoView({ block: 'center', inline: 'nearest' });
          const { x, y, width, height } = item.getBoundingClientRect();
          const pointX = x + width / 2;
          const pointY = y + height / 2;
          const hit = document.elementFromPoint(pointX, pointY);
          return { x: pointX, y: pointY, visible: pointX >= 0 && pointX <= innerWidth && pointY >= 0 && pointY <= innerHeight, hit: hit === item || item.contains(hit) };
        })()`);
        assert.ok(rect, `Missing click target: ${selector}`);
        assert.equal(rect.visible, true, `Expected visible click target: ${selector}`);
        assert.equal(rect.hit, true, `Expected unobstructed click target: ${selector}`);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: rect.x,
          y: rect.y,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: rect.x,
          y: rect.y,
          button: 'left',
          clickCount: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: rect.x,
          y: rect.y,
          button: 'left',
          clickCount: 1,
        });
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          localStorage.setItem('lexloop.session', JSON.stringify({
            accessToken: 'fixture-token',
            user: { id: 'learner-focus', email: 'focus@example.invalid', displayName: 'Focus Learner', role: 'USER' },
          }));
          window.focusFixture = { startBody: null };
          const floor = { id: 'floor-focus', floorNumber: 1, title: '词义回廊', cefrLevel: 'A1', targetCount: 12, exploration: 0, mastery: 0, bossUnlocked: false, completed: false, locked: false };
          const profile = {
            id: 'profile-focus', level: 1, experience: 0, experienceToNextLevel: 100, gold: 0, materials: 0,
            skillPoints: 1, highestFloor: 0, soundEnabled: false,
            currentClass: { id: 'class-warrior', key: 'warrior', name: '战士', description: '', combatRole: 'VANGUARD', tier: 0, requiredLevel: 1, parentId: null, available: true, current: true },
            availableClasses: [], skills: [],
          };
          const nativeFetch = window.fetch;
          window.fetch = async (input, options = {}) => {
            const path = new URL(String(input), location.href).pathname;
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'learner-focus' });
            if (path.endsWith('/adventure/profile')) return Response.json(profile);
            if (path.endsWith('/adventure/dungeons')) return Response.json({ book: { id: 'book-focus', title: '练习路线测试词书' }, floors: [floor] });
            if (path.endsWith('/adventure/runs/active')) return Response.json(null);
            if (path.endsWith('/adventure/inventory')) return Response.json({ items: [], equipped: {} });
            if (path.endsWith('/adventure/daily-quests')) return Response.json([]);
            if (path.endsWith('/adventure/runs') && options.method === 'POST') {
              window.focusFixture.startBody = JSON.parse(options.body);
              const focus = window.focusFixture.startBody.practiceFocus;
              return Response.json({
                id: 'run-focus', status: 'ACTIVE', durationMinutes: window.focusFixture.startBody.durationMinutes,
                practiceFocus: focus, currentRoom: 0, roomCount: 3, playerHp: 100, playerMaxHp: 100,
                resource: 3, experienceEarned: 0, goldEarned: 0, materialsEarned: 0, floor,
                rooms: [{ id: 'room-focus', position: 0, type: 'COMBAT', status: 'ACTIVE', enemyName: '词义史莱姆', enemyHp: 34, enemyMaxHp: 34 }],
                loot: [], challenge: { id: 'challenge-focus', type: 'SPELLING', phase: 'ATTACK', prompt: '请拼写：有耐心的', hint: '7 个字母', inputPlaceholder: '输入英文单词' },
                lastAction: null, availableSkills: [], canRetreat: false,
              });
            }
            return nativeFetch(input, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard/adventure', baseUrl).href });
      await until('document.querySelector("[class*=floorTrail] button")');
      const returnBounds = await evaluate(`(() => {
        const button = document.querySelector('[class*=topbar] .dashboard-return-button');
        const text = button.querySelector('span');
        const range = document.createRange();
        range.selectNodeContents(text);
        return { width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, textLines: range.getClientRects().length };
      })()`);
      assert.ok(returnBounds.width >= 120, JSON.stringify(returnBounds));
      assert.equal(returnBounds.textLines, 1, JSON.stringify(returnBounds));
      await clickSelector('[class*=floorTrail] button');
      await until('document.querySelector("[class*=practiceFocus]")');
      const desktopBounds = await evaluate(`(() => {
        const modal = document.querySelector('[class*=routePicker]');
        const rect = modal.getBoundingClientRect();
        const durations = [...modal.querySelectorAll('[class*=routeDurations] button')].map(button => {
          const item = button.getBoundingClientRect();
          return { top: item.top, bottom: item.bottom };
        });
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight, durations };
      })()`);
      assert.ok(desktopBounds.left >= 0 && desktopBounds.right <= 1440);
      assert.ok(desktopBounds.scrollHeight <= desktopBounds.clientHeight + 1);
      assert.ok(
        desktopBounds.durations.every(
          (item) => item.top >= desktopBounds.top && item.bottom <= desktopBounds.bottom,
        ),
      );
      assert.equal(await evaluate('document.body.innerText.includes("语境组句")'), true);
      assert.equal(
        await evaluate('document.body.innerText.includes("不改变楼层进度、复习排期或掌握判定")'),
        true,
      );
      await evaluate('document.querySelector("input[value=BALANCED]").focus()');
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
      });
      assert.equal(
        await evaluate('document.querySelector("input[value=RECALL]").checked'),
        true,
        'native radio keyboard navigation must change the selected route',
      );
      await clickSelector('[class*=practiceFocus] input[value=RECALL]');
      assert.equal(await evaluate('document.querySelector("input[value=RECALL]").checked'), true);
      await until(
        'Array.from(document.getAnimations()).every(animation => animation.playState !== "running" && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)',
      );
      const desktopShot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        '/tmp/lexloop-adventure-focus-desktop.png',
        Buffer.from(desktopShot.data, 'base64'),
      );

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(150);
      const modalBounds = await evaluate(`(() => {
        const modal = document.querySelector('[class*=routePicker]');
        const rect = modal.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, scrollHeight: modal.scrollHeight };
      })()`);
      assert.ok(modalBounds.left >= 0 && modalBounds.right <= 390, JSON.stringify(modalBounds));
      assert.ok(modalBounds.height <= 812, JSON.stringify(modalBounds));
      await until(
        'Array.from(document.getAnimations()).every(animation => animation.playState !== "running" && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)',
      );
      const mobileShot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        '/tmp/lexloop-adventure-focus-mobile.png',
        Buffer.from(mobileShot.data, 'base64'),
      );
      await evaluate(
        'document.querySelector("[class*=routeDurations] button").scrollIntoView({ block: "center" })',
      );
      await clickSelector('[class*=routeDurations] button');
      await until('window.focusFixture.startBody?.practiceFocus === "RECALL"');
      await until('document.body.innerText.includes("本局：主动回想")');
      assert.deepEqual(await evaluate('window.focusFixture.startBody'), {
        floorId: 'floor-focus',
        durationMinutes: 5,
        practiceFocus: 'RECALL',
      });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'), true);
      await until(
        'Array.from(document.getAnimations()).every(animation => animation.playState !== "running" && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)',
      );
      const battleShot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        '/tmp/lexloop-adventure-focus-battle-mobile.png',
        Buffer.from(battleShot.data, 'base64'),
      );
      const battleReturn = await evaluate(`(() => {
        const button = document.querySelector('[class*=battlePage] .dashboard-return-button');
        if (!button) return null;
        const label = button.querySelector('span');
        const header = button.closest('header');
        const title = header.querySelector('div strong');
        if (!label || !title) return { missingBattleHeaderContent: true };
        const range = document.createRange();
        range.selectNodeContents(label);
        const rect = button.getBoundingClientRect();
        return {
          label: label.textContent.trim(),
          width: rect.width,
          right: rect.right,
          textLines: range.getClientRects().length,
          titleLeft: title.getBoundingClientRect().left,
        };
      })()`);
      assert.ok(battleReturn, 'battle screen must use the shared return button');
      assert.equal(battleReturn.label, '返回学习进度');
      assert.ok(
        battleReturn.width >= 120 && battleReturn.right <= 390,
        JSON.stringify(battleReturn),
      );
      assert.equal(battleReturn.textLines, 1, JSON.stringify(battleReturn));
      assert.ok(battleReturn.titleLeft - battleReturn.right >= 7, JSON.stringify(battleReturn));
      await clickSelector('[class*=battlePage] .dashboard-return-button');
      await until('location.pathname === "/dashboard"');
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profileDir);
      await rm(profileDir, { recursive: true, force: true });
    }
  },
);
