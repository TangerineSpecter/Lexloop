import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'travel scenarios resume saved turns and retry the same pending message without crossing accounts',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-travel-resume-test-'));
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
    let socket;
    let closed = false;
    const waiting = new Map();
    const browserErrors = [];
    let sequence = 0;
    browser.on('error', (error) => (launchError = error));
    browser.on('close', () => (closed = true));

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
          } else if (
            message.method === 'Runtime.consoleAPICalled' &&
            message.params.type === 'error'
          ) {
            browserErrors.push(
              message.params.args
                .map((argument) => argument.value ?? argument.description)
                .join(' '),
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
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
          );
        }
        return result.result.value;
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A navigation can replace the execution context briefly.
          }
          await delay(100);
        }
        const state = await evaluate(
          `JSON.stringify({ path: location.pathname, text: document.body.innerText.slice(-700), fixture: window.travelResumeFixture, errors: browserErrors })`,
        ).catch(() => 'unavailable');
        assert.fail(
          `Timed out waiting for ${expression}; state=${state}; browserErrors=${JSON.stringify(browserErrors)}`,
        );
      };

      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          const initialSession = {
            accessToken: 'fixture-a',
            user: { id: 'travel-user-a', email: 'a@example.invalid', displayName: 'Learner A', role: 'USER' }
          };
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify(initialSession));
          const scenario = {
            id: 'resume-hotel', category: 'HOTEL', categoryLabel: '酒店', title: '酒店入住练习',
            description: 'Confirm an existing reservation.', userRole: 'traveller', aiRole: 'receptionist',
            minTurns: 1, maxTurns: 6, objectives: ['Confirm a reservation'], starterPhrases: ['I have a reservation.'],
            grammarFrames: [{ intent: 'Confirm a reservation', natural: 'I have a reservation under…', frame: 'I have a reservation under + name', explanation: 'Use under for the booking name.' }],
            completedCount: 0, bestOutcome: null,
          };
          const savedState = JSON.parse(sessionStorage.getItem('travel-resume-fixture') || 'null');
          const initialTurns = [
            { id: 'turn-opening', role: 'assistant', content: 'Welcome. How can I help?' },
            { id: 'turn-user-answered', role: 'user', content: 'I want check in.' },
            { id: 'turn-assistant-feedback', role: 'assistant', content: 'Certainly. May I have the name on the reservation?', evaluation: {
              taskProgress: [{ objective: 'Confirm a reservation', completed: false }], blockingCorrection: null,
              deferredFeedback: [{ type: 'politeness', original: 'I want check in.', natural: 'I’d like to check in.', explanation: 'Would like to makes a request more polite.' }],
              vocabulary: [], sessionShouldEnd: false,
            } },
            { id: 'turn-user-pending', role: 'user', content: 'Could you repeat the name?' },
          ];
          const activeA = savedState?.activeA ?? {
            session: { id: 'session-a', templateId: scenario.id, level: 'A1', status: 'ACTIVE', turnCount: 1 },
            template: { ...scenario, title: 'A_PRIVATE_RECOVERY_SCENARIO' },
            turns: initialTurns,
            pendingRetry: { clientMessageId: 'pending-message-123', content: 'Could you repeat the name?' },
          };
          window.travelResumeFixture = savedState ?? { activeA, turnCalls: [], activeReads: [], completionCalls: [], latestReport: null, historyReads: [], historyCursors: [], historyReadFailuresRemaining: 0, historyDetailReads: [], reportHistory: { items: [], nextCursor: null }, reportHistoryOlder: { items: [], nextCursor: null }, olderReport: null };
          const persistFixture = () => sessionStorage.setItem('travel-resume-fixture', JSON.stringify(window.travelResumeFixture));
          const currentUser = () => JSON.parse(localStorage.getItem('lexloop.session'));
          window.fetch = async (input, options = {}) => {
            const path = String(input);
            const method = options.method ?? 'GET';
            const userId = currentUser().user.id;
            if (path.includes('/api/v1/auth/me')) return Response.json({ id: userId });
            if (path.includes('/api/v1/reports/streak')) return Response.json({ currentStreak: 0, todayActive: false });
            if (path.includes('/api/v1/vocabulary/default')) return Response.json(null);
            if (path.includes('/api/v1/vocabulary/progress-summary')) return Response.json({ totalWords: 0, masteredWords: 0, progress: 0 });
            if (path.includes('/api/v1/vocabulary/dashboard-words')) return Response.json({ defaultNewWordCount: 0, reviewWords: [], newWords: [] });
            if (path.includes('/api/v1/study/plans')) return Response.json([]);
            if (path.includes('/api/v1/daily-sentences/current')) return Response.json({ state: 'DISABLED', item: null, canRetry: false });
            if (path.includes('/api/v1/proficiency/profile')) return Response.json({ overallLevel: 'A1', confidence: 'LOW', provisional: true, assessedAt: null, dimensions: { vocabulary: 0, grammar: 0, sentenceBuilding: 0, taskCompletion: 0, naturalness: 0, pronunciation: null, listening: null, fluency: null } });
            if (path.includes('/api/v1/practice/today')) return Response.json({ id: 'daily-plan', totalMinutes: 15, items: [] });
            if (path.includes('/api/v1/scenarios')) return Response.json([scenario]);
            if (path.includes('/api/v1/vocabulary/notebook')) return Response.json({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false });
            if (path.endsWith('/api/v1/scenario-sessions/active')) {
              window.travelResumeFixture.activeReads.push(userId);
              persistFixture();
              return Response.json(userId === 'travel-user-a' ? window.travelResumeFixture.activeA : null);
            }
            if (new URL(path, location.origin).pathname.endsWith('/api/v1/scenario-sessions/reports')) {
              window.travelResumeFixture.historyReads.push(userId);
              const cursor = new URL(path, location.origin).searchParams.get('cursor');
              window.travelResumeFixture.historyCursors.push(cursor);
              if (userId === 'travel-user-a' && window.travelResumeFixture.historyReadFailuresRemaining > 0) {
                window.travelResumeFixture.historyReadFailuresRemaining -= 1;
                persistFixture();
                return Response.json({ message: 'temporary history failure' }, { status: 503 });
              }
              persistFixture();
              if (userId !== 'travel-user-a') return Response.json({ items: [], nextCursor: null });
              return Response.json(cursor ? window.travelResumeFixture.reportHistoryOlder : window.travelResumeFixture.reportHistory);
            }
            if (path.endsWith('/api/v1/scenario-sessions/session-a/report')) {
              window.travelResumeFixture.historyDetailReads.push(userId);
              persistFixture();
              return userId === 'travel-user-a'
                ? Response.json(window.travelResumeFixture.latestReport)
                : Response.json({ message: 'not found' }, { status: 404 });
            }
            if (path.endsWith('/api/v1/scenario-sessions/old-session-a/report')) {
              window.travelResumeFixture.historyDetailReads.push(userId);
              persistFixture();
              return userId === 'travel-user-a'
                ? Response.json(window.travelResumeFixture.olderReport)
                : Response.json({ message: 'not found' }, { status: 404 });
            }
            if (path.endsWith('/api/v1/scenario-sessions/session-a/turns') && method === 'POST') {
              const body = JSON.parse(options.body);
              window.travelResumeFixture.turnCalls.push({ userId, body });
              const evaluation = {
                taskProgress: [{ objective: 'Confirm a reservation', completed: true }], blockingCorrection: null,
                deferredFeedback: [{ type: 'grammar', original: 'Could you repeat the name?', natural: 'Could you repeat the name for me?', explanation: 'A short addition makes this request clearer.' }],
                vocabulary: [], sessionShouldEnd: false,
              };
              const newTurn = { id: 'turn-assistant-retried', role: 'assistant', content: 'Certainly, I said your reservation is under Lee.', evaluation };
              window.travelResumeFixture.activeA = {
                ...window.travelResumeFixture.activeA,
                session: { ...window.travelResumeFixture.activeA.session, turnCount: 2 },
                turns: [...window.travelResumeFixture.activeA.turns, newTurn],
                pendingRetry: null,
              };
              persistFixture();
              return Response.json({ turn: newTurn, evaluation, session: window.travelResumeFixture.activeA.session });
            }
            if (path.endsWith('/api/v1/scenario-sessions/session-a/complete') && method === 'POST') {
              window.travelResumeFixture.completionCalls.push(userId);
              window.travelResumeFixture.activeA = null;
              window.travelResumeFixture.historyReadFailuresRemaining = 1;
              window.travelResumeFixture.latestReport = {
                session: { id: 'session-a', templateId: scenario.id, level: 'A1', status: 'COMPLETED', turnCount: 2 },
                completedAt: '2026-10-28T09:00:00.000Z', template: scenario,
                report: {
                  outcome: 'PARTIAL',
                  dimensions: { vocabulary: 60, grammar: 61, sentenceBuilding: 62, taskCompletion: 63, naturalness: 64 },
                  rewrites: [{ type: 'grammar', original: 'A_PRIVATE_COMPLETED_EXPRESSION', natural: 'Could you help me with this?', explanation: '礼貌求助时用 could 提出请求。' }],
                  grammarFrames: scenario.grammarFrames,
                  evidence: [{ objective: 'Confirm a reservation', completed: true }],
                  vocabulary: [], recommendation: '换一个相近情境再说一遍。',
                },
              };
              window.travelResumeFixture.olderReport = {
                session: { id: 'old-session-a', templateId: scenario.id, level: 'A1', status: 'COMPLETED', turnCount: 2 },
                completedAt: '2026-10-27T09:00:00.000Z',
                template: { ...scenario, title: '旧酒店入住练习' },
                report: {
                  outcome: 'SUCCESS',
                  dimensions: { vocabulary: 70, grammar: 71, sentenceBuilding: 72, taskCompletion: 73, naturalness: 74 },
                  rewrites: [{ type: 'grammar', original: 'A_PRIVATE_OLDER_EXPRESSION', natural: 'Could I check in, please?', explanation: '用 Could I ...? 提出礼貌请求。' }],
                  grammarFrames: scenario.grammarFrames,
                  evidence: [{ objective: 'Confirm a reservation', completed: true }],
                  vocabulary: [], recommendation: '下次试着补充预订姓名。',
                },
              };
              window.travelResumeFixture.reportHistory = {
                items: [
                  { sessionId: 'session-a', completedAt: '2026-10-28T09:00:00.000Z', level: 'A1', template: { id: scenario.id, title: scenario.title, category: 'HOTEL', categoryLabel: '酒店' }, outcome: 'PARTIAL' },
                  { sessionId: 'old-session-a', completedAt: '2026-10-27T09:00:00.000Z', level: 'A1', template: { id: scenario.id, title: '旧酒店入住练习', category: 'HOTEL', categoryLabel: '酒店' }, outcome: 'SUCCESS' },
                ],
                nextCursor: 'history-cursor-a',
              };
              window.travelResumeFixture.reportHistoryOlder = {
                items: [
                  { sessionId: 'oldest-session-a', completedAt: '2026-10-26T09:00:00.000Z', level: 'A1', template: { id: scenario.id, title: '更早的酒店练习', category: 'HOTEL', categoryLabel: '酒店' }, outcome: 'PARTIAL' },
                ],
                nextCursor: null,
              };
              persistFixture();
              return Response.json({ message: 'response lost after commit' }, { status: 503 });
            }
            if (path.includes('/api/v1/')) return Response.json([]);
            return new Response('Not found', { status: 404 });
          };
        `,
      });

      const openTravel = async () => {
        await until(
          '[...document.querySelectorAll("button")].some(button => button.textContent.includes("场景口语"))',
        );
        await evaluate(
          '[...document.querySelectorAll("button")].find(button => button.textContent.includes("场景口语")).click()',
        );
        await until(
          'document.querySelector(".travel-session-resume") || document.body.innerText.includes("CHOOSE YOUR NEXT STOP")',
        );
      };

      await send('Page.navigate', { url: new URL('/dashboard', baseUrl).href });
      await openTravel();
      assert.equal(await evaluate('Boolean(document.querySelector(".conversation-page"))'), false);
      assert.equal(
        await evaluate('document.querySelector(".travel-session-resume h2").textContent'),
        'A_PRIVATE_RECOVERY_SCENARIO',
      );
      assert.equal(await evaluate('window.travelResumeFixture.activeReads.length'), 1);

      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileLayout = await evaluate(`(() => {
        const card = document.querySelector('.travel-session-resume');
        card.scrollIntoView({ block: 'center' });
        const button = card.querySelector('button').getBoundingClientRect();
        return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, buttonWidth: button.width, buttonRight: button.right };
      })()`);
      assert.equal(mobileLayout.scrollWidth, mobileLayout.viewport, JSON.stringify(mobileLayout));
      assert.ok(
        mobileLayout.buttonWidth > 0 && mobileLayout.buttonRight <= mobileLayout.viewport,
        JSON.stringify(mobileLayout),
      );
      await send('Emulation.clearDeviceMetricsOverride');

      await evaluate(
        '[...document.querySelectorAll(".travel-session-resume button")].find(button => button.textContent.includes("继续上次场景")).click()',
      );
      await until('document.querySelector(".scene-retry-notice button")');
      assert.equal(
        await evaluate('document.body.innerText.includes("A_PRIVATE_RECOVERY_SCENARIO")'),
        true,
      );
      assert.deepEqual(
        await evaluate(`(() => {
          const feedback = document.querySelector('.travel-deferred-feedback');
          return {
            restored: Boolean(feedback),
            startsCollapsed: feedback ? !feedback.open : false,
            contentRetained: feedback?.textContent.includes('I’d like to check in.') ?? false,
            collapsedContentHidden: feedback ? getComputedStyle(feedback.querySelector('[data-feedback-list]')).display === 'none' : false,
          };
        })()`),
        {
          restored: true,
          startsCollapsed: true,
          contentRetained: true,
          collapsedContentHidden: true,
        },
      );
      assert.equal(
        await evaluate('document.querySelector(".scene-composer textarea").disabled'),
        true,
      );
      assert.equal(await evaluate('document.querySelectorAll(".dialogue-turn.user").length'), 2);

      await evaluate('document.querySelector(".scene-retry-notice button").click()');
      await until('window.travelResumeFixture.turnCalls.length === 1');
      await until(
        'document.querySelector(".dialogue-turn.assistant:nth-last-child(1)")?.textContent.includes("reservation is under Lee")',
      );
      const retryEvidence = await evaluate(`({
        callCount: window.travelResumeFixture.turnCalls.length,
        userId: window.travelResumeFixture.turnCalls[0].userId,
        message: window.travelResumeFixture.turnCalls[0].body.message,
        clientMessageId: window.travelResumeFixture.turnCalls[0].body.clientMessageId,
        visibleUserTurnCount: document.querySelectorAll('.dialogue-turn.user').length,
        composerEnabled: !document.querySelector('.scene-composer textarea').disabled,
      })`);
      assert.deepEqual(retryEvidence, {
        callCount: 1,
        userId: 'travel-user-a',
        message: 'Could you repeat the name?',
        clientMessageId: 'pending-message-123',
        visibleUserTurnCount: 2,
        composerEnabled: true,
      });

      await evaluate(
        '[...document.querySelectorAll(".conversation-actions button")].find(button => button.textContent.includes("完成场景")).click()',
      );
      await until('window.travelResumeFixture.completionCalls.length === 1');
      await until(
        'document.querySelector(".scene-retry-notice")?.textContent.includes("服务暂时不可用")',
      );
      assert.equal(
        await evaluate('window.travelResumeFixture.latestReport.session.id'),
        'session-a',
      );

      await evaluate('location.reload()');
      await openTravel();
      await until(
        'document.querySelector(".travel-report-recovery h2")?.textContent.includes("暂时无法读取")',
      );
      assert.equal(await evaluate('document.body.innerText.includes("没有历史复盘")'), false);
      assert.equal(
        await evaluate(
          'Boolean([...document.querySelectorAll(".travel-report-recovery button")].find(button => button.textContent.includes("查看复盘")))',
        ),
        false,
      );
      await evaluate(
        '[...document.querySelectorAll(".travel-report-recovery button")].find(button => button.textContent.includes("重试读取")).click()',
      );
      await until(
        '[...document.querySelectorAll(".travel-report-recovery button")].some(button => button.textContent.includes("查看复盘"))',
      );
      const desktopReportCardLayout = await evaluate(`(() => {
        const card = document.querySelector('.travel-report-recovery');
        card.scrollIntoView({ block: 'center' });
        const button = card.querySelector('button').getBoundingClientRect();
        return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, buttonWidth: button.width, buttonRight: button.right };
      })()`);
      assert.equal(
        desktopReportCardLayout.scrollWidth,
        desktopReportCardLayout.viewport,
        JSON.stringify(desktopReportCardLayout),
      );
      assert.ok(
        desktopReportCardLayout.buttonWidth > 0 &&
          desktopReportCardLayout.buttonRight <= desktopReportCardLayout.viewport,
        JSON.stringify(desktopReportCardLayout),
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileReportCardLayout = await evaluate(`(() => {
        const card = document.querySelector('.travel-report-recovery');
        card.scrollIntoView({ block: 'center' });
        const button = card.querySelector('button').getBoundingClientRect();
        return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, buttonWidth: button.width, buttonRight: button.right };
      })()`);
      assert.equal(
        mobileReportCardLayout.scrollWidth,
        mobileReportCardLayout.viewport,
        JSON.stringify(mobileReportCardLayout),
      );
      assert.ok(
        mobileReportCardLayout.buttonWidth > 0 &&
          mobileReportCardLayout.buttonRight <= mobileReportCardLayout.viewport,
        JSON.stringify(mobileReportCardLayout),
      );
      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate(
        '[...document.querySelectorAll(".travel-report-recovery button")].find(button => button.textContent.includes("查看复盘")).click()',
      );
      await until('document.querySelector(".travel-report-page")');
      assert.equal(
        await evaluate('document.body.innerText.includes("A_PRIVATE_COMPLETED_EXPRESSION")'),
        true,
      );
      assert.equal(await evaluate('window.travelResumeFixture.completionCalls.length'), 1);

      await evaluate(
        '[...document.querySelectorAll(".travel-report-page footer button")].find(button => button.textContent.includes("回到场景地图")).click()',
      );
      await until('document.querySelector(".travel-report-history h2")');
      assert.equal(
        await evaluate('document.body.innerText.includes("A_PRIVATE_OLDER_EXPRESSION")'),
        false,
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const historyLayout = await evaluate(`(() => {
        const section = document.querySelector('.travel-report-history');
        section.scrollIntoView({ block: 'center' });
        const item = section.querySelector('li').getBoundingClientRect();
        const button = section.querySelector('li button').getBoundingClientRect();
        return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, itemRight: item.right, buttonRight: button.right };
      })()`);
      assert.equal(
        historyLayout.scrollWidth,
        historyLayout.viewport,
        JSON.stringify(historyLayout),
      );
      assert.ok(historyLayout.itemRight <= historyLayout.viewport, JSON.stringify(historyLayout));
      assert.ok(historyLayout.buttonRight <= historyLayout.viewport, JSON.stringify(historyLayout));
      await evaluate(
        '[...document.querySelectorAll(".travel-report-history button")].find(button => button.textContent.includes("加载更早复盘")).click()',
      );
      await until('document.querySelectorAll(".travel-report-history li").length === 2');
      assert.equal(
        await evaluate('window.travelResumeFixture.historyCursors.at(-1)'),
        'history-cursor-a',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      const mobileHistoryLayout = await evaluate(`(() => {
        const section = document.querySelector('.travel-report-history');
        section.scrollIntoView({ block: 'center' });
        const item = section.querySelector('li').getBoundingClientRect();
        const button = section.querySelector('li button').getBoundingClientRect();
        return { viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, itemRight: item.right, buttonRight: button.right };
      })()`);
      assert.equal(
        mobileHistoryLayout.scrollWidth,
        mobileHistoryLayout.viewport,
        JSON.stringify(mobileHistoryLayout),
      );
      assert.ok(
        mobileHistoryLayout.itemRight <= mobileHistoryLayout.viewport,
        JSON.stringify(mobileHistoryLayout),
      );
      assert.ok(
        mobileHistoryLayout.buttonRight <= mobileHistoryLayout.viewport,
        JSON.stringify(mobileHistoryLayout),
      );
      await send('Emulation.clearDeviceMetricsOverride');
      await evaluate(
        '[...document.querySelectorAll(".travel-report-history button")].find(button => button.getAttribute("aria-label") === "查看 旧酒店入住练习 的复盘").click()',
      );
      await until(
        'document.querySelector(".travel-report-page")?.innerText.includes("A_PRIVATE_OLDER_EXPRESSION")',
      );
      assert.equal(
        await evaluate('window.travelResumeFixture.historyDetailReads.at(-1)'),
        'travel-user-a',
      );
      await evaluate(
        '[...document.querySelectorAll(".travel-report-page footer button")].find(button => button.textContent.includes("回到场景地图")).click()',
      );
      await until('document.querySelector(".travel-report-history h2")');

      await evaluate(
        `(() => {
        const saved = JSON.parse(localStorage.getItem('lexloop.session'));
        localStorage.setItem('lexloop.session', JSON.stringify({ ...saved, accessToken: 'fixture-b', user: { id: 'travel-user-b', email: 'b@example.invalid', displayName: 'Learner B', role: 'USER' } }));
        location.reload();
      })()`,
      );
      await openTravel();
      assert.equal(
        await evaluate('document.querySelector(".travel-session-resume") === null'),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector(".travel-report-recovery") === null'),
        true,
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("A_PRIVATE_RECOVERY_SCENARIO")'),
        false,
      );
      assert.equal(
        await evaluate('document.body.innerText.includes("Could you repeat the name?")'),
        false,
      );
      assert.equal(await evaluate('document.body.innerText.includes("旧酒店入住练习")'), false);
      assert.equal(
        await evaluate('window.travelResumeFixture.activeReads.at(-1)'),
        'travel-user-b',
      );
      assert.equal(
        await evaluate('window.travelResumeFixture.historyReads.at(-1)'),
        'travel-user-b',
      );
      assert.deepEqual(browserErrors, []);
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      if (!closed) await new Promise((resolve) => browser.once('close', resolve)).catch(() => {});
      await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  },
);
