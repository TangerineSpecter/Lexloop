import assert from 'node:assert/strict';
import { closeChromium, spawnChromium } from './browser-process.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'dungeon route carries a selected focus through battle, completion, and recovery',
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
        const state = await evaluate(`({
          page: location.pathname + location.search,
          challengeTitle: document.querySelector('[class*=challengeCard] h1')?.textContent.trim() ?? null,
          challenge: window.focusFixture?.run?.challenge ?? null,
          runStatus: window.focusFixture?.run?.status ?? null,
          currentRoom: window.focusFixture?.run?.currentRoom ?? null,
          actionCount: window.focusFixture?.actions?.length ?? null,
          bodyText: document.body.innerText.slice(0, 1200),
          orderMarkup: document.querySelector('[class*=challengeCard] [class*=order]')?.outerHTML.slice(0, 1600) ?? null,
          browserErrors: window.focusFixture?.errors ?? [],
        })`).catch((error) => ({ diagnosticError: String(error) }));
        assert.fail(`Timed out waiting for ${expression}; state: ${JSON.stringify(state)}`);
      };
      const clickSelector = async (selector) => {
        const rect = await evaluate(`(() => {
          const item = document.querySelector(${JSON.stringify(selector)});
          if (!item) return null;
          item.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
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
      const clickText = async (selector, text) => {
        const point = await evaluate(`(() => {
          const item = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
          if (!item) return {
            missing: true,
            title: document.querySelector('[class*=challengeCard] h1')?.textContent.trim() ?? null,
            challenge: window.focusFixture?.run?.challenge ?? null,
            actionCount: window.focusFixture?.actions?.length ?? null,
            buttons: [...document.querySelectorAll('[class*=challengeCard] button')].map(button => ({ text: button.textContent.trim(), className: String(button.className), disabled: button.disabled })),
          };
          item.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          const rect = item.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return {
            x, y,
            visible: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
            hit: hit === item || item.contains(hit),
            disabled: item.disabled,
            hitTag: hit?.tagName ?? null,
            hitClass: String(hit?.className ?? ''),
            hitText: hit?.textContent?.trim() ?? null,
            pointerEvents: getComputedStyle(item).pointerEvents,
          };
        })()`);
        assert.ok(
          point && !point.missing,
          `Missing button with text ${text} in ${selector}: ${JSON.stringify(point)}`,
        );
        assert.equal(point.visible, true, `Expected ${text} in the viewport`);
        assert.equal(point.hit, true, `Expected ${text} to receive pointer input`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
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
          const fixtureKey = 'adventure-focus-e2e';
          window.focusFixture = JSON.parse(sessionStorage.getItem(fixtureKey) || '{"startBody":null,"run":null,"actions":[],"recoveries":0}');
          window.focusFixture.requests ??= [];
          const persistFocusFixture = () => sessionStorage.setItem(fixtureKey, JSON.stringify(window.focusFixture));
          window.holdNextActionResponse = false;
          window.releasePendingActionResponse = null;
          window.failNextActionBeforeSave = false;
          const floor = { id: 'floor-focus', floorNumber: 1, title: '词义回廊', cefrLevel: 'A1', targetCount: 12, exploration: 0, mastery: 0, bossUnlocked: false, completed: false, locked: false };
          const passives = {
            warrior: { key: 'VANGUARD', title: '稳守', description: '答对格挡且仍会受伤时，额外减免最多 4 点伤害。' },
            mage: { key: 'BURST', title: '精准施法', description: '消耗至少 1 点资源发动技能并完美命中，额外造成 6 点战斗伤害。' },
            ranger: { key: 'STRIKER', title: '连续出击', description: '同房间连续答对后，本次答对攻击额外造成 6 点战斗伤害；答错会重置连击。' },
            cleric: { key: 'SUPPORT', title: '温和疗愈', description: '生产类题目有效答对时，每个房间最多恢复 4 点生命。' },
          };
          const availableClasses = [
            ['warrior', '战士', 'VANGUARD', '用稳定命中积累护盾与反击。'],
            ['mage', '法师', 'BURST', '消耗专注强化精准回答的爆发。'],
            ['ranger', '游侠', 'STRIKER', '连续正确时获得暴击与额外探索。'],
            ['cleric', '牧师', 'SUPPORT', '通过清晰表达恢复生命并维持增益。'],
          ].map(([key, name, combatRole, description]) => ({
            id: 'class-' + key, key, name, combatRole, description, tier: 0, requiredLevel: 1,
            parentId: null, available: true, current: false, combatPassive: passives[key],
          }));
          const selectedClassKey = window.focusFixture.selectedClassKey ?? null;
          for (const item of availableClasses) item.current = item.key === selectedClassKey;
          const profile = {
            id: 'profile-focus', level: 1, experience: 0, experienceToNextLevel: 100, gold: 0, materials: 0,
            skillPoints: 1, highestFloor: 0, soundEnabled: false,
            currentClass: availableClasses.find(item => item.key === selectedClassKey) ?? null,
            availableClasses, skills: [],
          };
          const roomTypes = ['COMBAT', 'EVENT', 'ELITE', 'CAMP', 'COMBAT', 'TREASURE'];
          const targetWords = ['patient', 'steady', 'calm', 'bright', 'quiet', 'gentle'];
          const actionSteps = [
            { room: 0, phase: 'ATTACK', type: 'SENTENCE_ORDER', target: 0, clearsRoom: true },
            { room: 1, phase: 'ATTACK', type: 'SENTENCE_ORDER', target: 1, clearsRoom: true },
            { room: 2, phase: 'ATTACK', type: 'SPELLING', target: 2, clearsRoom: false },
            { room: 2, phase: 'BLOCK', type: 'MATCHING', target: 3, clearsRoom: false },
            { room: 2, phase: 'ATTACK', type: 'SENTENCE_ORDER', target: 3, clearsRoom: true },
            { room: 3, phase: 'ATTACK', type: 'SENTENCE_ORDER', target: 3, clearsRoom: true },
            { room: 4, phase: 'ATTACK', type: 'MATCHING', target: 4, clearsRoom: true },
            { room: 5, phase: 'ATTACK', type: 'SENTENCE_ORDER', target: 5, clearsRoom: true },
          ];
          const expectedAnswers = actionSteps.map(step => {
            const word = targetWords[step.target];
            return step.type === 'SENTENCE_ORDER' ? 'We can use ' + word + ' today.' : word;
          });
          window.focusFixture.expectedAnswers = expectedAnswers;
          const makeChallenge = index => {
            const step = actionSteps[index];
            const type = step.type;
            const phase = step.phase;
            const word = targetWords[step.target];
            const expected = expectedAnswers[index];
            if (type === 'SENTENCE_ORDER') {
              return {
                id: 'challenge-focus-' + index, type, phase,
                prompt: '把词块排列成完整句子', hint: '句子中包含 ' + word,
                tokens: [word, 'today.', 'We', 'can', 'use'],
              };
            }
            if (type === 'MATCHING') {
              return {
                id: 'challenge-focus-' + index, type, phase,
                prompt: '选择“' + (word === 'bright' ? '明亮的' : '安静的') + '”对应的英文', hint: '选择只能提供识别证据',
                options: [word, 'rapid', 'steady'],
              };
            }
            return {
              id: 'challenge-focus-' + index, type, phase,
              prompt: '请拼写：平静的', hint: word.length + ' 个字母', inputPlaceholder: '输入英文单词',
            };
          };
          const makeRun = body => ({
            id: 'run-focus', status: 'ACTIVE', durationMinutes: body.durationMinutes,
            combatRulesVersion: 1, combatPassive: profile.currentClass?.combatPassive ?? null,
            practiceFocus: body.practiceFocus, currentRoom: 0, roomCount: 6,
            playerHp: 100, playerMaxHp: 100, resource: 3,
            experienceEarned: 0, goldEarned: 0, materialsEarned: 0, floor,
            rooms: roomTypes.map((type, position) => ({
              id: 'room-focus-' + position, position, type,
              status: position === 0 ? 'ACTIVE' : 'PENDING',
              enemyName: '词义守关者 ' + (position + 1),
              enemyHp: [34, 34, 62, 28, 34, 34][position],
              enemyMaxHp: [34, 34, 62, 28, 34, 34][position],
            })),
            loot: [], challenge: makeChallenge(0), lastAction: null,
            availableSkills: [{ id: 'skill-focus', key: 'warrior-1', name: '战士·基础技', description: '答对后提高本次伤害。', target: 'ENEMY', cost: 1, requiredLevel: 1, unlocked: true }], canRetreat: false,
          });
          const nativeFetch = window.fetch;
          window.fetch = async (input, options = {}) => {
            const path = new URL(String(input), location.href).pathname;
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: 'learner-focus' });
            if (path.endsWith('/adventure/profile')) return Response.json(profile);
            if (path.endsWith('/adventure/profile/class') && options.method === 'POST') {
              const selected = JSON.parse(options.body).classKey;
              window.focusFixture.selectedClassKey = selected;
              persistFocusFixture();
              profile.currentClass = availableClasses.find(item => item.key === selected);
              profile.availableClasses = availableClasses.map(item => ({ ...item, current: item.key === selected }));
              return Response.json(profile);
            }
            if (path.endsWith('/adventure/dungeons')) return Response.json({ book: { id: 'book-focus', title: '练习路线测试词书' }, floors: [floor] });
            if (path.endsWith('/adventure/runs/active'))
              return Response.json(window.focusFixture.run?.status === 'ACTIVE' ? window.focusFixture.run : null);
            if (path.includes('/adventure/runs/recover/')) {
              window.focusFixture.recoveries += 1;
              persistFocusFixture();
              return Response.json(window.focusFixture.run);
            }
            if (path.endsWith('/adventure/inventory')) return Response.json({ items: [], equipped: {} });
            if (path.endsWith('/adventure/daily-quests')) return Response.json([]);
            if (path.endsWith('/adventure/runs') && options.method === 'POST') {
              window.focusFixture.startBody = JSON.parse(options.body);
              window.focusFixture.run = makeRun(window.focusFixture.startBody);
              persistFocusFixture();
              return Response.json(window.focusFixture.run);
            }
            if (path.endsWith('/adventure/runs/run-focus/actions') && options.method === 'POST') {
              const body = JSON.parse(options.body);
              window.focusFixture.requests.push({ answer: body.answer, clientActionId: body.clientActionId, skillId: body.skillId ?? null });
              persistFocusFixture();
              if (window.failNextActionBeforeSave) {
                window.failNextActionBeforeSave = false;
                return Response.json({ message: '测试模拟的暂时失败' }, { status: 503 });
              }
              const index = window.focusFixture.actions.length;
              const current = window.focusFixture.run;
              const step = actionSteps[index];
              if (!step) return Response.json({ message: 'No fixture action remains' }, { status: 409 });
              const challenge = current.challenge;
              const expected = expectedAnswers[index];
              const submitted = challenge.type === 'SENTENCE_ORDER' ? body.answer.join(' ') : body.answer[0];
              const correct = submitted === expected;
              const passiveTrigger = correct && challenge.phase === 'ATTACK' && body.skillId && current.combatPassive?.key === 'BURST'
                ? '精准施法：技能完美命中，额外造成 6 点战斗伤害。'
                : undefined;
              const damageDealt = correct ? 40 + (passiveTrigger ? 6 : 0) : 0;
              window.focusFixture.actions.push({
                answer: body.answer, challengeType: challenge.type, clientActionId: body.clientActionId,
                correct, practiceFocus: current.practiceFocus, phase: challenge.phase, skillId: body.skillId ?? null,
              });
              const next = JSON.parse(JSON.stringify(current));
              next.lastAction = {
                challengeType: challenge.type, phase: challenge.phase, prompt: challenge.prompt,
                answer: body.answer, score: correct ? 100 : 0, grade: correct ? 'PERFECT' : 'MISS',
                damageDealt, damageReceived: 0,
                feedback: { correct, message: correct ? '表达命中，攻击生效。' : '答案与本题不一致。', answer: expected, provisional: false, ...(passiveTrigger ? { passiveTrigger } : {}) },
              };
              if (challenge.phase === 'ATTACK') {
                next.rooms[step.room].enemyHp = Math.max(0, next.rooms[step.room].enemyHp - damageDealt);
              }
              if (correct && step.clearsRoom) {
                next.rooms[step.room].status = 'CLEARED';
                next.experienceEarned += [18, 18, 36, 18, 18, 18][step.room];
                next.goldEarned += [8, 8, 16, 8, 8, 8][step.room];
                if (step.room === 2) next.materialsEarned += 2;
                if (step.room < roomTypes.length - 1) {
                  next.currentRoom = step.room + 1;
                  next.rooms[next.currentRoom].status = 'ACTIVE';
                  next.challenge = makeChallenge(index + 1);
                } else {
                  next.status = 'COMPLETED';
                  next.challenge = null;
                }
              } else {
                next.challenge = makeChallenge(index + 1);
              }
              window.focusFixture.run = next;
              persistFocusFixture();
              const response = Response.json({
                repeated: false, score: correct ? 100 : 0,
                grade: correct ? 'PERFECT' : 'MISS', damageDealt,
                damageReceived: 0, feedback: next.lastAction.feedback, run: next,
              });
              if (window.holdNextActionResponse) {
                window.holdNextActionResponse = false;
                await new Promise(resolve => { window.releasePendingActionResponse = resolve; });
                window.releasePendingActionResponse = null;
              }
              return response;
            }
            return nativeFetch(input, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard/adventure', baseUrl).href });
      await until('document.querySelectorAll("[class*=classGrid] button").length === 4');
      const classCards = await evaluate(
        "(() => [...document.querySelectorAll('[class*=classGrid] button')].map(card => ({ title: card.querySelector('h2')?.textContent.trim(), passive: card.querySelector('[class*=passivePreview]')?.innerText.trim(), right: card.getBoundingClientRect().right })))()",
      );
      assert.deepEqual(
        classCards.map((card) => card.title),
        ['战士', '法师', '游侠', '牧师'],
      );
      assert.deepEqual(
        classCards.map((card) => card.passive?.match(/被动 · ([^\n]+)/)?.[1]),
        ['稳守', '精准施法', '连续出击', '温和疗愈'],
      );
      assert.ok(classCards.every((card) => card.right <= 1440));
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await delay(100);
      const mobileClassLayout = await evaluate(
        "(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('[class*=classGrid] button')].map(card => { const box = card.getBoundingClientRect(); const passive = card.querySelector('[class*=passivePreview]').getBoundingClientRect(); return { left: box.left, right: box.right, passiveLeft: passive.left, passiveRight: passive.right }; }) }))()",
      );
      assert.equal(mobileClassLayout.document, 390, JSON.stringify(mobileClassLayout));
      assert.ok(
        mobileClassLayout.cards.every(
          (card) =>
            card.left >= 0 &&
            card.right <= 390 &&
            card.passiveLeft >= card.left &&
            card.passiveRight <= card.right,
        ),
        JSON.stringify(mobileClassLayout),
      );
      await clickSelector('[class*=classGrid] button:nth-child(2)');
      await until('document.querySelector("[class*=floorTrail] button")');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
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
      await clickSelector('[class*=practiceFocus] input[value=CONTEXT]');
      assert.equal(await evaluate('document.querySelector("input[value=CONTEXT]").checked'), true);
      await until(
        'Array.from(document.getAnimations()).every(animation => animation.playState !== "running" && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)',
      );
      const desktopShot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        join(profileDir, 'route-picker-desktop.png'),
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
        join(profileDir, 'route-picker-mobile.png'),
        Buffer.from(mobileShot.data, 'base64'),
      );
      await evaluate(
        'document.querySelector("[class*=routeDurations] button:nth-child(2)").scrollIntoView({ block: "center" })',
      );
      await clickSelector('[class*=routeDurations] button:nth-child(2)');
      await until('window.focusFixture.startBody?.practiceFocus === "CONTEXT"');
      await until('document.body.innerText.includes("本局：语境组句")');
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      assert.deepEqual(await evaluate('window.focusFixture.startBody'), {
        floorId: 'floor-focus',
        durationMinutes: 10,
        practiceFocus: 'CONTEXT',
      });
      assert.equal(await evaluate('window.focusFixture.run.roomCount'), 6);
      assert.equal(
        await evaluate(
          'document.querySelector("[class*=combatPassiveBanner]")?.innerText.includes("精准施法")',
        ),
        true,
        'battle screen should explain the snapshotted class passive',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("[class*=combatPassiveBanner]")?.getClientRects().length > 0',
        ),
        true,
        'passive explanation should remain visible with reduced motion enabled',
      );
      assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'), true);
      await until(
        'Array.from(document.getAnimations()).every(animation => animation.playState !== "running" && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)',
      );
      const battleShot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        join(profileDir, 'battle-mobile.png'),
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

      const expectedTypes = [
        'SENTENCE_ORDER',
        'SENTENCE_ORDER',
        'SPELLING',
        'MATCHING',
        'SENTENCE_ORDER',
        'SENTENCE_ORDER',
        'MATCHING',
        'SENTENCE_ORDER',
      ];
      for (let index = 0; index < expectedTypes.length; index += 1) {
        await until(
          `document.querySelector('[class*=challengeCard] h1')?.textContent.trim() === window.focusFixture.run.challenge.prompt && document.querySelector('[class*=challengeCard] header small')?.textContent.trim() === window.focusFixture.run.challenge.hint`,
        );
        await until(
          'Array.from(document.getAnimations()).every(animation => animation.playState !== "running" && !animation.pending || animation.effect?.getComputedTiming().iterations === Infinity)',
        );
        const challengeType = await evaluate('window.focusFixture.run.challenge.type');
        const expectedAnswer = await evaluate(`window.focusFixture.expectedAnswers[${index}]`);
        assert.equal(challengeType, expectedTypes[index]);
        if (challengeType === 'SENTENCE_ORDER') {
          await until(
            'document.querySelectorAll("[class*=challengeCard] [class*=order] > div:first-child button").length === 0',
          );
          const selectedTokens = [];
          for (const token of expectedAnswer.split(' ')) {
            selectedTokens.push(token);
            await clickText('[class*=challengeCard] [class*=order] > div:last-child button', token);
            await until(
              `Array.from(document.querySelectorAll('[class*=challengeCard] [class*=order] > div:first-child button')).map(button => button.textContent.trim()).join(' ') === ${JSON.stringify(selectedTokens.join(' '))}`,
            );
          }
        } else if (challengeType === 'SPELLING') {
          await until('document.querySelector("[class*=challengeCard] input")?.value === ""');
          await clickSelector('[class*=challengeCard] input');
          await send('Input.insertText', { text: expectedAnswer });
        } else {
          await until(
            '!Array.from(document.querySelectorAll("[class*=challengeCard] [class*=options] button")).some(button => String(button.className).includes("selected"))',
          );
          await clickText('[class*=challengeCard] [class*=options] button', expectedAnswer);
        }
        if (index < 2)
          await evaluate(
            '[...document.querySelectorAll("[class*=skillBar] button")].find(button => button.textContent.includes("基础技")).click()',
          );
        if (index === 0) await evaluate('window.holdNextActionResponse = true');
        if (index === 1) await evaluate('window.failNextActionBeforeSave = true');
        await clickSelector('[class*=challengeCard] button[class*=strike]');
        if (index === 0) {
          await until('typeof window.releasePendingActionResponse === "function"');
          const pending = await evaluate(`(() => {
            const form = document.querySelector('[class*=challengeCard]');
            const answerControls = [...form.querySelectorAll('[class*=order] button, [class*=options] button, input')];
            const skillControls = [...form.querySelectorAll('[class*=skillBar] button')];
            return {
              ariaBusy: form.getAttribute('aria-busy'),
              answerLocked: answerControls.length > 0 && answerControls.every(button => button.disabled),
              skillsLocked: skillControls.length > 0 && skillControls.every(button => button.disabled),
              submitDisabled: form.querySelector('[class*=strike]').disabled,
              selectedSkill: form.querySelector('[class*=skillBar] button[class*=selected]')?.textContent.trim(),
              sentAnswer: window.focusFixture.actions[0].answer.join(' '),
              sentSkill: window.focusFixture.actions[0].skillId,
            };
          })()`);
          assert.deepEqual(pending, {
            ariaBusy: 'true',
            answerLocked: true,
            skillsLocked: true,
            submitDisabled: true,
            selectedSkill: '基础技1 点专注',
            sentAnswer: expectedAnswer,
            sentSkill: 'skill-focus',
          });
          await evaluate('window.releasePendingActionResponse()');
        }
        if (index === 1) {
          await until(
            'document.querySelector("[class*=strike]")?.textContent.includes("重试本次结算")',
          );
          const failed = await evaluate(`(() => {
            const form = document.querySelector('[class*=challengeCard]');
            const controls = [...form.querySelectorAll('[class*=order] button, [class*=options] button, input, [class*=skillBar] button')];
            return {
              controlsLocked: controls.length > 0 && controls.every(button => button.disabled),
              submitDisabled: form.querySelector('[class*=strike]').disabled,
              answer: window.focusFixture.requests[1].answer.join(' '),
              committedActions: window.focusFixture.actions.length,
            };
          })()`);
          assert.deepEqual(failed, {
            controlsLocked: true,
            submitDisabled: false,
            answer: expectedAnswer,
            committedActions: 1,
          });
          await clickSelector('[class*=challengeCard] button[class*=strike]');
        }
        await until(`window.focusFixture.actions.length === ${index + 1}`);
        assert.equal(
          await evaluate(`window.focusFixture.actions[${index}].correct`),
          true,
          `fixture should receive the correct ${challengeType} answer: ${JSON.stringify(await evaluate(`window.focusFixture.actions[${index}]`))}; expected ${JSON.stringify(expectedAnswer)}`,
        );
        if (index === 1) {
          assert.deepEqual(
            await evaluate('[window.focusFixture.requests[1], window.focusFixture.requests[2]]'),
            await evaluate('[window.focusFixture.requests[1], window.focusFixture.requests[1]]'),
            'retry must reuse the same answer, skill, and idempotency key after an uncertain response',
          );
          assert.equal(await evaluate('window.focusFixture.actions[1].skillId'), 'skill-focus');
        }
        if (index === 0) {
          await until(
            'document.querySelector("[class*=passiveTrigger]")?.textContent.includes("精准施法")',
          );
          assert.equal(
            await evaluate(
              'window.focusFixture.run.lastAction.feedback.passiveTrigger.includes("额外造成 6 点")',
            ),
            true,
          );
        }
        if (index === 3)
          await until(
            'document.querySelector("[class*=previousFeedback] strong")?.textContent.includes("词义匹配")',
          );
      }
      assert.deepEqual(
        await evaluate('window.focusFixture.actions.map(item => item.challengeType)'),
        expectedTypes,
      );
      assert.deepEqual(await evaluate('window.focusFixture.actions.map(item => item.phase)'), [
        'ATTACK',
        'ATTACK',
        'ATTACK',
        'BLOCK',
        'ATTACK',
        'ATTACK',
        'ATTACK',
        'ATTACK',
      ]);
      assert.equal(
        await evaluate(
          'new Set(window.focusFixture.actions.map(item => item.clientActionId)).size',
        ),
        8,
      );
      assert.equal(
        await evaluate(
          'window.focusFixture.actions.every(item => item.practiceFocus === "CONTEXT")',
        ),
        true,
      );
      await until('document.body.innerText.includes("探索完成！")');
      await until('document.body.innerText.includes("+126 EXP")');
      await evaluate('location.reload()');
      await until('document.body.innerText.includes("探索完成！")');
      await until('window.focusFixture.recoveries === 1');
      assert.equal(await evaluate('window.focusFixture.run.status'), 'COMPLETED');
      assert.equal(await evaluate('window.focusFixture.actions.length'), 8);
      await clickSelector('button');
      await until('document.body.innerText.includes("第 1 层远征准备")');
      assert.equal(
        await evaluate('localStorage.getItem("lexloop.adventureRun.learner-focus")'),
        null,
      );
      assert.deepEqual(browserErrors, []);
    } finally {
      if (socket?.readyState === WebSocket.OPEN) socket.close();
      await closeChromium(browser, profileDir);
      await rm(profileDir, { recursive: true, force: true });
    }
  },
);
