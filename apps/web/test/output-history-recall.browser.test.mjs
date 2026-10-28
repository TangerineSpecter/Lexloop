import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const baseUrl = process.env.LAB_BROWSER_TEST_URL;

test(
  'practice feedback preserves recall privacy and confusion answers recover after interruption',
  { skip: !baseUrl, timeout: 60_000 },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'lexloop-output-history-test-'));
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
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            if (await evaluate(`Boolean(${expression})`)) return;
          } catch {
            // A navigation can briefly replace the page's JavaScript context.
          }
          await delay(100);
        }
        assert.fail(`Timed out waiting for ${expression}`);
      };
      const target = (word, meaning, bookWordId) => ({ word, meaning, bookWordId });
      const feedback = (bookWordId, correctedText, missingWordId, additionalWordIds = []) => ({
        score: 72,
        grammarScore: 80,
        coherenceScore: 68,
        correctedText,
        comments: ['试着让句子里的因果关系更清楚。'],
        words: [
          { bookWordId, used: true, correct: true, feedback: '这个词在当前语境中使用恰当。' },
          ...(missingWordId
            ? [
                {
                  bookWordId: missingWordId,
                  used: false,
                  correct: false,
                  feedback: '请把目标词作为完整单词放进句子。',
                },
              ]
            : []),
          ...additionalWordIds.map((id) => ({
            bookWordId: id,
            used: true,
            correct: true,
            feedback: '这个短语完整出现在表达中。',
          })),
        ],
      });
      const makeHistoryItem = (id, answer, correctedText) => ({
        id,
        date: '2026-10-26',
        prompt: '写一段关于如何解决小问题的英文。',
        targets: [
          target('approach', '方法', `${id}-word`),
          target('carefully', '仔细地', `${id}-carefully`),
        ],
        answer,
        status: 'COMPLETED',
        feedback: feedback(`${id}-word`, correctedText, `${id}-carefully`),
        error: null,
        createdAt: '2026-10-26T09:30:00.000Z',
      });
      const userAItems = [
        makeHistoryItem(
          'history-a',
          'I will approach the problem slowly.',
          'I will approach the problem more carefully.',
        ),
        makeHistoryItem(
          'history-a-second',
          'I need another approach for this issue.',
          'I need a different approach to this issue.',
        ),
      ];
      const userBItems = [
        makeHistoryItem(
          'history-b',
          'Account B has its own approach.',
          'Account B uses a careful approach.',
        ),
      ];
      const daily = {
        id: 'today-challenge',
        date: '2026-10-27',
        prompt: '写一段关于一次旅行的英文。',
        targets: [
          target('journey', '旅程', 'today-word'),
          target('art', '艺术；技艺', 'today-art-word'),
          target('miss the bus', '没赶上公交车', 'today-phrase-word'),
        ],
        remaining: 3,
        submissions: [
          {
            id: 'today-submission',
            answer:
              'The party started early. We might MISS the bus, then continue. Our journey lasted for two days.',
            status: 'COMPLETED',
            feedback: feedback(
              'today-word',
              'We might miss the bus, then our journey began after the party.',
              'today-art-word',
              ['today-phrase-word'],
            ),
            error: null,
            createdAt: '2026-10-27T09:30:00.000Z',
          },
        ],
      };
      const confusionGroups = [
        {
          id: 'confusion-a',
          title: '到达地点',
          note: 'arrive at 用于具体地点，arrive in 用于城市或国家。',
          words: [],
          questions: [
            {
              id: 'confusion-a-q1',
              sentence: 'We ___ the station at eight.',
              options: ['arrived at', 'arrived in'],
            },
            {
              id: 'confusion-a-q2',
              sentence: 'They ___ the city before sunset.',
              options: ['arrived at', 'arrived in'],
            },
          ],
          recommendation: '按语境辨析',
          practiced: false,
        },
        {
          id: 'confusion-b',
          title: '借入与借出',
          note: 'borrow 表示借入，lend 表示借出。',
          words: [],
          questions: [
            {
              id: 'confusion-b-q1',
              sentence: 'Could I ___ your pen for a minute?',
              options: ['borrow', 'lend'],
            },
          ],
          recommendation: '换一组练习',
          practiced: false,
        },
      ];

      await send('Page.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          if (!localStorage.getItem('lexloop.session')) localStorage.setItem('lexloop.session', JSON.stringify({ accessToken: 'fixture-a', user: { id: 'user-a', email: 'fixture-a@example.invalid', displayName: 'Fixture A', role: 'USER' } }));
          window.outputApiWrites = [];
          window.confusionFailNext = true;
          const nativeFetch = window.fetch;
          window.fetch = async (url, options = {}) => {
            const path = String(url);
            const method = options.method ?? 'GET';
            if (path.includes('/api/v1/')) {
              if (method !== 'GET') {
                window.outputApiWrites.push({ method, path });
                if (path.includes('/api/v1/practice/confusion/') && path.endsWith('/attempts')) {
                  if (window.confusionFailNext) {
                    window.confusionFailNext = false;
                    return Response.json({ message: 'Fixture submission failure' }, { status: 500 });
                  }
                  const payload = JSON.parse(options.body);
                  return Response.json({
                    id: 'confusion-attempt',
                    groupId: 'confusion-a',
                    correctCount: payload.answers.length,
                    total: payload.answers.length,
                    results: payload.answers.map((answer) => ({
                      questionId: answer.questionId,
                      selected: answer.selected,
                      answer: answer.selected,
                      correct: true,
                      explanation: 'Fixture explanation',
                    })),
                  });
                }
                return Response.json({ message: 'Unexpected write in history recall fixture' }, { status: 500 });
              }
              if (path.includes('/api/v1/auth/me')) {
                const user = JSON.parse(localStorage.getItem('lexloop.session') ?? '{}').user;
                return Response.json({ id: user?.id });
              }
              if (path.includes('/api/v1/practice/output/today')) {
                const user = JSON.parse(localStorage.getItem('lexloop.session') ?? '{}').user;
                return Response.json(user?.id === 'user-b' ? { ...${JSON.stringify(daily)}, submissions: [] } : ${JSON.stringify(daily)});
              }
              if (path.includes('/api/v1/practice/output/history')) {
                const user = JSON.parse(localStorage.getItem('lexloop.session') ?? '{}').user;
                return Response.json({ items: user?.id === 'user-b' ? ${JSON.stringify(userBItems)} : ${JSON.stringify(userAItems)}, hasMore: false });
              }
              if (path.includes('/api/v1/practice/confusion/history')) return Response.json([]);
              if (path.includes('/api/v1/practice/confusion')) return Response.json(${JSON.stringify(confusionGroups)});
              throw new Error('Unexpected API request in history recall fixture: ' + path);
            }
            return nativeFetch(url, options);
          };
        `,
      });
      await send('Page.navigate', { url: new URL('/dashboard/practice?tab=output', baseUrl).href });
      await until('document.querySelector("#output-answer")');
      await until('document.querySelector("[aria-label=\\"表达对照\\"]")');
      const currentComparison = await evaluate(
        'document.querySelector("[aria-label=\\"表达对照\\"]").innerText',
      );
      assert.ok(currentComparison.includes('写一段关于一次旅行的英文。'));
      assert.ok(currentComparison.includes('目标词或短语：journey · art · miss the bus'));
      assert.ok(
        currentComparison.includes(
          'The party started early. We might MISS the bus, then continue. Our journey lasted for two days.',
        ),
      );
      assert.ok(
        currentComparison.includes(
          'We might miss the bus, then our journey began after the party.',
        ),
      );
      const targetJourneyEvidence = await evaluate(
        'document.querySelector("[data-target-word=journey]").innerText',
      );
      assert.ok(targetJourneyEvidence.includes('We might MISS the bus, then continue.'));
      assert.ok(targetJourneyEvidence.includes('首个完整拼写片段'));
      assert.equal(
        await evaluate('document.querySelector("[data-target-word=journey] mark")?.textContent'),
        'journey',
      );
      const phraseTarget = await evaluate(`(() => {
        const target = [...document.querySelectorAll('strong')].find((item) => item.textContent === 'miss the bus');
        return target?.parentElement?.innerText;
      })()`);
      assert.ok(phraseTarget.includes('miss the bus'));
      assert.ok(phraseTarget.includes('没赶上公交车'));
      const phraseEvidence = await evaluate(
        'document.querySelector("[data-target-word=\\"miss the bus\\"]")?.innerText',
      );
      assert.ok(phraseEvidence?.includes('这个短语完整出现在表达中。'));
      assert.equal(
        await evaluate(
          'document.querySelector("[data-target-word=\\"miss the bus\\"] mark")?.textContent',
        ),
        'MISS the bus',
      );
      const desktopPhraseLayout = await evaluate(`(() => {
        const target = [...document.querySelectorAll('strong')].find((item) => item.textContent === 'miss the bus');
        const card = target?.closest('section');
        const targetBox = target?.getBoundingClientRect();
        const cardBox = card?.getBoundingClientRect();
        return {
          viewport: innerWidth,
          page: document.documentElement.scrollWidth,
          targetRight: targetBox?.right,
          cardRight: cardBox?.right,
          visible: Boolean(targetBox && targetBox.width > 0 && targetBox.height > 0),
        };
      })()`);
      assert.equal(desktopPhraseLayout.viewport, 1440);
      assert.equal(desktopPhraseLayout.visible, true);
      assert.ok(desktopPhraseLayout.page <= desktopPhraseLayout.viewport);
      assert.ok(desktopPhraseLayout.targetRight <= desktopPhraseLayout.cardRight);
      const targetArtEvidence = await evaluate(
        'document.querySelector("[data-target-word=art]").innerText',
      );
      assert.ok(!targetArtEvidence.includes('party'));
      assert.ok(targetArtEvidence.includes('未找到完全一致的拼写；词形变化或标点写法可能未匹配。'));
      assert.equal(await evaluate('document.querySelector("[data-target-word=art] mark")'), null);
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("回到原文重写")).click()',
      );
      assert.equal(
        await evaluate('document.querySelector("#output-answer").value'),
        'The party started early. We might MISS the bus, then continue. Our journey lasted for two days.',
      );
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await until(
        'getComputedStyle(document.querySelector("[aria-label=\\"表达对照\\"] > div")).gridTemplateColumns.split(" ").length === 1',
      );
      const mobilePhraseLayout = await evaluate(`(() => {
        const target = [...document.querySelectorAll('strong')].find((item) => item.textContent === 'miss the bus');
        const card = target?.closest('section');
        const targetBox = target?.getBoundingClientRect();
        const cardBox = card?.getBoundingClientRect();
        return {
          viewport: innerWidth,
          page: document.documentElement.scrollWidth,
          targetRight: targetBox?.right,
          cardRight: cardBox?.right,
          visible: Boolean(targetBox && targetBox.width > 0 && targetBox.height > 0),
        };
      })()`);
      assert.equal(mobilePhraseLayout.visible, true);
      assert.ok(mobilePhraseLayout.page <= mobilePhraseLayout.viewport);
      assert.ok(mobilePhraseLayout.targetRight <= mobilePhraseLayout.cardRight);
      await evaluate(`(() => {
        const record = [...document.querySelectorAll('details')].find((item) => item.querySelector('summary')?.innerText.includes('查看回答与反馈'));
        if (record) record.open = true;
      })()`);
      const todayRecordComparison = await evaluate(
        '[...document.querySelectorAll("details")].find((item) => item.querySelector("summary")?.innerText.includes("查看回答与反馈")).querySelector("[aria-label=\\"表达对照\\"]").innerText',
      );
      assert.ok(todayRecordComparison.includes('写一段关于一次旅行的英文。'));
      assert.ok(
        todayRecordComparison.includes(
          'The party started early. We might MISS the bus, then continue. Our journey lasted for two days.',
        ),
      );
      assert.ok(
        todayRecordComparison.includes(
          'We might miss the bus, then our journey began after the party.',
        ),
      );
      await evaluate(`(() => {
        const record = [...document.querySelectorAll('details')].find((item) => item.querySelector('summary')?.innerText.includes('查看回答与反馈'));
        if (record) record.open = false;
      })()`);

      const openHistory = async () => {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('查看过去的输出记录'));
          button?.click();
        })()`);
        await until('document.querySelectorAll("details").length >= 1');
      };
      const openFirstRecord = async () => {
        await evaluate(`(() => {
          const record = [...document.querySelectorAll('details')].find((item) => item.querySelector('summary')?.innerText.includes('查看表达与反馈'));
          if (record) record.open = true;
        })()`);
        await until('document.querySelector("#output-history-attempt-history-a")');
      };
      const typeFirstAttempt = async (value) =>
        evaluate(`(() => {
          const textarea = document.querySelector('#output-history-attempt-history-a');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(value)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);

      await openHistory();
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll("details")].filter((item) => item.querySelector("summary")?.innerText.includes("查看表达与反馈")).length',
        ),
        2,
      );
      await openFirstRecord();
      assert.equal(
        await evaluate(
          'document.querySelector("#output-history-attempt-history-a").labels[0].textContent',
        ),
        '你的新版本',
      );
      const beforeReveal = await evaluate('document.body.innerText');
      assert.ok(beforeReveal.includes('写一段关于如何解决小问题的英文。'));
      assert.ok(beforeReveal.includes('approach'));
      assert.ok(!beforeReveal.includes('I will approach the problem slowly.'));
      assert.ok(!beforeReveal.includes('I will approach the problem more carefully.'));
      assert.ok(beforeReveal.includes('直接查看原记录'));

      await typeFirstAttempt('I could approach the problem from another side.');
      await until(
        '[...document.querySelectorAll("button")].some((item) => item.textContent.includes("试写后查看对照") && !item.disabled)',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("试写后查看对照")).click()',
      );
      await until('document.body.innerText.includes("I will approach the problem slowly.")');
      await until('document.activeElement.id === "output-history-answer-history-a"');
      const comparison = await evaluate('document.body.innerText');
      assert.ok(comparison.includes('I could approach the problem from another side.'));
      assert.ok(comparison.includes('I will approach the problem more carefully.'));
      const savedComparison = await evaluate(
        'document.querySelector("#output-history-answer-history-a").parentElement.querySelector("[aria-label=\\"表达对照\\"]").innerText',
      );
      assert.ok(savedComparison.includes('写一段关于如何解决小问题的英文。'));
      assert.ok(savedComparison.includes('目标词或短语：approach · carefully'));
      assert.ok(savedComparison.includes('I will approach the problem slowly.'));
      assert.ok(savedComparison.includes('I will approach the problem more carefully.'));
      const approachEvidence = await evaluate(
        'document.querySelector("#output-history-answer-history-a").parentElement.querySelector("[data-target-word=approach]").innerText',
      );
      assert.ok(approachEvidence.includes('I will approach the problem slowly.'));
      assert.ok(approachEvidence.includes('首个完整拼写片段'));
      const carefullyEvidence = await evaluate(
        'document.querySelector("#output-history-answer-history-a").parentElement.querySelector("[data-target-word=carefully]").innerText',
      );
      assert.ok(carefullyEvidence.includes('未找到完全一致的拼写；词形变化或标点写法可能未匹配。'));
      assert.ok(carefullyEvidence.includes('carefully'));
      assert.equal(
        await evaluate(
          'getComputedStyle(document.querySelector("#output-history-answer-history-a").parentElement.querySelector("[aria-label=\\"表达对照\\"] > div")).gridTemplateColumns.split(" ").length',
        ),
        1,
      );
      assert.equal(await evaluate('window.outputApiWrites.length'), 0);
      assert.equal(
        await evaluate(
          "Object.keys(localStorage).filter((key) => key.includes('output.history') || key.includes('output.recall')).length",
        ),
        0,
      );

      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("再试一次（先隐藏对照）")).click()',
      );
      await until('!document.body.innerText.includes("I will approach the problem slowly.")');
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-a").value'),
        '',
      );

      await typeFirstAttempt('This attempt should disappear after refresh.');
      await send('Page.reload');
      await until('document.querySelector("#output-answer")');
      await openHistory();
      await openFirstRecord();
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-a").value'),
        '',
      );
      const afterRefresh = await evaluate('document.body.innerText');
      assert.ok(!afterRefresh.includes('I will approach the problem slowly.'));
      assert.ok(!afterRefresh.includes('This attempt should disappear after refresh.'));

      await typeFirstAttempt('This attempt should disappear after navigation.');
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("易混词对比训练")).click()',
      );
      await until('document.querySelector("input[name=\\"confusion-a-q1\\"]")');
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("每日输出挑战")).click()',
      );
      await until('document.querySelector("#output-answer")');
      await openHistory();
      await openFirstRecord();
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-a").value'),
        '',
      );
      const afterNavigation = await evaluate('document.body.innerText');
      assert.ok(!afterNavigation.includes('I will approach the problem slowly.'));
      assert.ok(!afterNavigation.includes('This attempt should disappear after navigation.'));

      // An empty attempt can reveal the saved record directly; no typing is required.
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("直接查看原记录")).click()',
      );
      await until('document.body.innerText.includes("I will approach the problem slowly.")');

      // Unsubmitted confusion answers survive group switches, tab navigation, reloads, and a failed save.
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("易混词对比训练")).click()',
      );
      await until('document.querySelector("input[name=\\"confusion-a-q1\\"]")');
      const groupADraftKey = 'lexloop.confusion.draft.user-a.confusion-a';
      const groupBDraftKey = 'lexloop.confusion.draft.user-a.confusion-b';
      await evaluate(
        'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").click()',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked',
        ),
        true,
      );
      assert.ok(await evaluate(`localStorage.getItem(${JSON.stringify(groupADraftKey)})`));

      await evaluate(
        'document.querySelectorAll("aside[aria-label=\\"对比词组\\"] button")[1].click()',
      );
      await until('document.querySelector("input[name=\\"confusion-b-q1\\"]")');
      assert.equal(
        await evaluate(
          'document.querySelector("input[name=\\"confusion-b-q1\\"][value=\\"borrow\\"]").checked',
        ),
        false,
      );
      await evaluate(
        'document.querySelector("input[name=\\"confusion-b-q1\\"][value=\\"lend\\"]").click()',
      );
      assert.ok(await evaluate(`localStorage.getItem(${JSON.stringify(groupBDraftKey)})`));

      await evaluate(
        'document.querySelectorAll("aside[aria-label=\\"对比词组\\"] button")[0].click()',
      );
      await until(
        'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked',
        ),
        true,
      );
      assert.equal(
        await evaluate('document.querySelector("input[name=\\"confusion-a-q2\\"]:checked")'),
        null,
      );
      await evaluate(
        'document.querySelector("input[name=\\"confusion-a-q2\\"][value=\\"arrived in\\"]").click()',
      );
      const beforeConfusionSubmit = await evaluate('document.body.innerText');
      assert.ok(!beforeConfusionSubmit.includes('正确答案：'));
      assert.ok(!beforeConfusionSubmit.includes('Fixture explanation'));
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("提交并查看解析")).click()',
      );
      await until('window.outputApiWrites.some((item) => item.path.includes("/attempts"))');
      await until('document.querySelector("[role=\\"alert\\"]")');
      const afterFailedConfusionSubmit = await evaluate('document.body.innerText');
      assert.ok(!afterFailedConfusionSubmit.includes('正确答案：'));
      assert.ok(!afterFailedConfusionSubmit.includes('Fixture explanation'));
      const failedSubmitDraft = await evaluate(
        `JSON.parse(localStorage.getItem(${JSON.stringify(groupADraftKey)}))`,
      );
      assert.deepEqual(failedSubmitDraft.answers, {
        'confusion-a-q1': 'arrived at',
        'confusion-a-q2': 'arrived in',
      });

      await send('Page.reload');
      await until(
        'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked && document.querySelector("input[name=\\"confusion-a-q2\\"][value=\\"arrived in\\"]").checked',
      );
      assert.equal(
        await evaluate(
          'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector("input[name=\\"confusion-a-q2\\"][value=\\"arrived in\\"]").checked',
        ),
        true,
      );
      await evaluate(`(() => {
        const key = ${JSON.stringify(groupADraftKey)};
        const draft = JSON.parse(localStorage.getItem(key));
        draft.snapshotId = 'fixture-other-tab-snapshot';
        localStorage.setItem(key, JSON.stringify(draft));
      })()`);
      await evaluate('window.confusionFailNext = false');
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("提交并查看解析")).click()',
      );
      await until('document.body.innerText.includes("本组答对 2/2")');
      assert.ok((await evaluate('document.body.innerText')).includes('Fixture explanation'));
      assert.equal(
        (await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(groupADraftKey)}))`))
          .snapshotId,
        'fixture-other-tab-snapshot',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("再练一轮")).click()',
      );
      await until(
        'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked && document.querySelector("input[name=\\"confusion-a-q2\\"][value=\\"arrived in\\"]").checked',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("提交并查看解析")).click()',
      );
      await until('document.body.innerText.includes("本组答对 2/2")');
      assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(groupADraftKey)})`), null);

      await evaluate(
        'document.querySelectorAll("aside[aria-label=\\"对比词组\\"] button")[1].click()',
      );
      await until('document.querySelector("input[name=\\"confusion-b-q1\\"]:checked")');
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("清除本机草稿")).click()',
      );
      assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(groupBDraftKey)})`), null);
      await until(
        '!document.querySelector("input[name=\\"confusion-b-q1\\"][value=\\"lend\\"]").checked',
      );

      await evaluate(
        'document.querySelectorAll("aside[aria-label=\\"对比词组\\"] button")[0].click()',
      );
      await until('document.querySelector("input[name=\\"confusion-a-q1\\"]")');
      await evaluate(
        'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").click()',
      );

      await evaluate(`(() => {
        const session = JSON.parse(localStorage.getItem('lexloop.session'));
        localStorage.setItem('lexloop.session', JSON.stringify({ ...session, accessToken: 'fixture-b', user: { ...session.user, id: 'user-b', email: 'fixture-b@example.invalid', displayName: 'Fixture B' } }));
      })()`);
      await send('Page.reload');
      await until('document.querySelector("input[name=\\"confusion-a-q1\\"]")');
      assert.equal(
        await evaluate(
          'document.querySelector("input[name=\\"confusion-a-q1\\"][value=\\"arrived at\\"]").checked',
        ),
        false,
      );
      assert.ok(await evaluate(`localStorage.getItem(${JSON.stringify(groupADraftKey)})`));
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("每日输出挑战")).click()',
      );
      await until('document.querySelector("#output-answer")');
      await openHistory();
      await evaluate('document.querySelectorAll("details")[0].open = true');
      await until('document.querySelector("#output-history-attempt-history-b")');
      const userBBeforeReveal = await evaluate('document.body.innerText');
      assert.ok(!userBBeforeReveal.includes('I will approach the problem slowly.'));
      assert.ok(!userBBeforeReveal.includes('This attempt should disappear'));
      assert.equal(
        await evaluate('document.querySelector("#output-history-attempt-history-b").value'),
        '',
      );
      await evaluate(
        '[...document.querySelectorAll("button")].find((item) => item.textContent.includes("直接查看原记录")).click()',
      );
      await until('document.body.innerText.includes("Account B has its own approach.")');
      assert.ok(
        !(await evaluate('document.body.innerText')).includes(
          'I will approach the problem slowly.',
        ),
      );
      assert.ok(
        (await evaluate('document.body.innerText')).includes('Account B has its own approach.'),
      );
      assert.equal(await evaluate('window.outputApiWrites.length'), 0);
    } finally {
      socket?.close();
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 50 && !closed; attempt++) await delay(100);
      if (!closed) browser.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);
