import { PROTOCOL_VERSION } from '../../packages/shared/dist/index.js';
import {
  createGroqStub,
  grantedCopy,
  say,
  startFixtures,
  toolCall,
  tools,
} from './agent-scenarios.mjs';
import { createChecks, createPageTools, launch, sleep } from './browser.mjs';

const FAKE_KEY = 'gsk_verifyOnlyNotARealKey000000000000abcd';

/**
 * Failure on purpose, in a real browser: hung requests, a frozen page, Stop at awkward
 * moments, the same safe workflow many times. Groq is stubbed and the internet is blocked.
 */
export async function verifyReliability(name, executable, extensionPath) {
  const copy = grantedCopy(extensionPath);
  const fixtures = await startFixtures();
  const browser = launch(executable, { blockNetwork: true });
  const { open, evaluate, waitFor, waitForTarget, clickButton, fill } = createPageTools(browser);
  const { check, allPassed } = createChecks();
  const host = fixtures.base.replace('http://', '');

  try {
    console.log(`\n${name}, reliability:`);
    const groq = await createGroqStub(browser);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: copy });
    await waitForTarget((target) => target.type === 'service_worker' && target.url.includes(id));
    const panel = await open(`chrome-extension://${id}/sidepanel/index.html`);
    await waitFor(panel, `document.body.innerText.includes('Dopilot')`);
    await evaluate(panel, `chrome.storage.local.set({ groqApiKey: ${JSON.stringify(FAKE_KEY)} })`);

    const send = (body) =>
      Promise.race([
        evaluate(
          panel,
          `chrome.runtime.sendMessage(${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body })})`,
        ),
        sleep(15000).then(() => {
          throw new Error(`No reply to ${body.type}`);
        }),
      ]);
    const state = async () => (await send({ type: 'panel.get_state' })).state;
    const waitForStatus = async (statuses, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const agent = (await state().catch(() => null))?.agent;
        if (agent && statuses.includes(agent.status)) return agent;
        await sleep(100);
      }
      return (await state().catch(() => null))?.agent ?? null;
    };
    const ENDED = ['completed', 'failed', 'cancelled'];
    const tabCount = async () => (await state()).tabs.length;
    const start = async (instruction, script = []) => {
      groq.script = script;
      groq.chatRequests.length = 0;
      await send({ type: 'panel.reset_conversation' });
      return send({ type: 'panel.start_agent', instruction });
    };

    // --- Workflow A: exactly one tab, verified, no AI ---
    let before = await tabCount();
    await start(`Open a new tab and go to ${host}/wiki.`);
    const simple = await waitForStatus(ENDED);
    check(
      'Workflow A: one new tab, no AI request',
      simple?.status === 'completed' &&
        (await tabCount()) === before + 1 &&
        groq.chatRequests.length === 0 &&
        (await state()).tabs.find((tab) => tab.active)?.url?.includes('/wiki'),
      `${simple?.metrics?.totalMs}ms`,
    );

    // --- Even a model trying to open two tabs gets one ---
    before = await tabCount();
    await start('Open a page for me please, the wiki one', [
      tools(toolCall('open_tab')),
      tools(toolCall('open_tab', { url: `${fixtures.base}/turing` })),
      tools(toolCall('open_tab', { url: `${fixtures.base}/turing` })),
      say('Opened it.'),
    ]);
    const doubled = await waitForStatus(ENDED);
    check(
      'A model asking for extra tabs still leaves one',
      doubled?.status === 'completed' && (await tabCount()) === before + 1,
      `${(await tabCount()) - before} tab(s)`,
    );

    // --- Workflow C: named tab, then back ---
    const githubTab = await open(`${fixtures.base}/github`);
    await waitFor(githubTab, `document.readyState === 'complete'`);
    const wikiTab = (await state()).tabs.find((tab) => tab.url?.includes('/turing'));
    await send({
      type: 'panel.execute',
      command: { action: 'tab.switch', target: { tabId: wikiTab.id } },
      confirmed: false,
    });
    await sleep(200);
    await start('Switch to GitHub, then return to the previous tab.');
    const tabs = await waitForStatus(ENDED);
    check(
      'Workflow C: switches to a named tab and back, no AI request',
      tabs?.status === 'completed' &&
        groq.chatRequests.length === 0 &&
        tabs.timeline.length === 2 &&
        (await state()).tabs.find((tab) => tab.active)?.id === wikiTab.id,
      tabs?.summary ?? tabs?.error,
    );

    // --- Workflow F: failures ---
    await start(`Open ${host}/wiki, read it and click something that does not exist`, [
      { status: 500, body: { error: { message: 'stubbed outage' } } },
      tools(toolCall('open_tab', { url: `${fixtures.base}/form-page` })),
      tools(toolCall('click_element', { ref: 'zz.99' })),
      say('I could not find that button.'),
    ]);
    const recovered = await waitForStatus(ENDED);
    check(
      'Workflow F: recovers from a failed request and a missing element',
      recovered?.status === 'completed' &&
        recovered.timeline.some((entry) => entry.status === 'failed') &&
        /could not/.test(recovered.summary ?? ''),
      recovered?.summary ?? recovered?.error,
    );

    await start('Do a thing that needs the AI', [
      { status: 500, body: { error: { message: 'stubbed outage' } } },
      { status: 500, body: { error: { message: 'stubbed outage' } } },
      { status: 500, body: { error: { message: 'stubbed outage' } } },
    ]);
    const outage = await waitForStatus(ENDED);
    check(
      'A Groq outage ends with a clear error, and says it is Groq',
      outage?.status === 'failed' &&
        outage.failureKind === 'model' &&
        /Groq/.test(outage.error ?? ''),
      outage?.error,
    );

    await start('Do another thing', [
      { status: 404, body: { error: { code: 'model_not_found', message: 'gone' } } },
      say('All clear with the other model.'),
    ]);
    const swapped = await waitForStatus(ENDED);
    check(
      'A retired model is replaced, and the timeline says so',
      swapped?.status === 'completed' &&
        swapped.timeline.some((entry) => /unavailable/.test(entry.label)),
      swapped?.model,
    );

    // --- A frozen page cannot freeze the task ---
    const busyStarted = Date.now();
    await start('Look at the busy page for me', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/busy` })),
      tools(toolCall('get_interactive_elements')),
      say('That page is not responding, so I could not read it.'),
    ]);
    const frozen = await waitForStatus(ENDED, 60000);
    check(
      'A frozen page ends in an explanation, not a hang',
      frozen?.status === 'completed' &&
        frozen.timeline.some((entry) => entry.status === 'failed') &&
        Date.now() - busyStarted < 45000,
      `${Math.round((Date.now() - busyStarted) / 1000)}s: ${frozen?.timeline.find((entry) => entry.status === 'failed')?.detail}`,
    );

    // --- Workflow G: Stop ---
    before = await tabCount();
    let releaseStub;
    const held = new Promise((done) => {
      releaseStub = done;
    });
    await start('A long multi-step task that needs thinking', [
      async () => {
        await held;
        return tools(toolCall('open_tab', { url: `${fixtures.base}/github?late` }));
      },
      tools(toolCall('open_tab', { url: `${fixtures.base}/github?later` })),
    ]);
    await waitForStatus(['thinking']);
    await sleep(400);
    const stopStarted = Date.now();
    await send({ type: 'panel.stop_agent' });
    const stopped = await waitForStatus(['cancelled'], 3000);
    const stopMs = Date.now() - stopStarted;
    check(
      'Workflow G: Stop ends a pending Groq request',
      stopped?.status === 'cancelled',
      `${stopMs}ms`,
    );

    // The bug this guards against: a new task could sit in Thinking forever after a Stop.
    const nextStart = await start(`Open a new tab and go to ${host}/turing.`);
    const next = await waitForStatus(ENDED, 10000);
    check(
      'A new task runs straight after Stop',
      nextStart.error === null && next?.status === 'completed',
      next?.error ?? `${next?.metrics?.totalMs}ms`,
    );
    releaseStub();
    await sleep(800);
    check(
      'The stopped task never acted, even when its request answered late',
      !(await state()).tabs.some(
        (tab) => /late/.test(tab.url ?? '') || /github\?/.test(tab.url ?? ''),
      ),
    );

    // Stop while a page is loading, in the middle of a plan.
    before = await tabCount();
    await start(`Open ${host}/busy, scroll down`);
    await sleep(150);
    await send({ type: 'panel.stop_agent' });
    const midPlan = await waitForStatus(['cancelled'], 3000);
    await sleep(1500);
    const planned = (await state()).agent;
    check(
      'Stop in the middle of a plan skips everything after it',
      midPlan?.status === 'cancelled' &&
        planned.timeline.filter((entry) => entry.status === 'done').length <= 1 &&
        !planned.timeline.some((entry) => /Scrolling/.test(entry.label) && entry.status === 'done'),
    );

    // --- Double submit ---
    groq.script = [say('One.')];
    const [first, second] = await Promise.all([
      send({ type: 'panel.start_agent', instruction: 'A task, twice' }),
      send({ type: 'panel.start_agent', instruction: 'A task, twice' }),
    ]);
    check(
      'A double submit starts one task',
      [first.error, second.error].filter((error) => error === null).length === 1,
    );
    await waitForStatus(ENDED);

    // --- Workflow H: repeated runs ---
    const repeated = [];
    for (let round = 0; round < 10; round += 1) {
      const count = await tabCount();
      await start(`Open a new tab and go to ${host}/wiki?round=${round}.`);
      const run = await waitForStatus(ENDED, 10000);
      repeated.push(
        run?.status === 'completed' && (await tabCount()) === count + 1
          ? run.metrics.totalMs
          : null,
      );
    }
    const good = repeated.filter((value) => value !== null);
    check(
      'Workflow H: the same workflow works ten times in a row',
      good.length === 10,
      `${good.length}/10, ${Math.min(...good)}-${Math.max(...good)}ms`,
    );

    // --- Page controls, against a page with a dialog, dropdown and late content ---
    await start('Use the controls on the form page', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/form-page` })),
      tools(toolCall('wait_for_element', { text: 'Late' })),
      tools(toolCall('get_interactive_elements')),
      (body) => {
        const text = JSON.stringify(body.messages).replace(/\\"/g, '"');
        const ref = /"ref":"([^"]+)","role":"combobox"/.exec(text)?.[1];
        return tools(toolCall('select_option', { ref, option: 'Blue' }));
      },
      (body) => {
        const text = JSON.stringify(body.messages).replace(/\\"/g, '"');
        const ref = /"ref":"([^"]+)","role":"button","name":"Open dialog"/.exec(text)?.[1];
        return tools(toolCall('click_element', { ref }));
      },
      tools(toolCall('get_interactive_elements', { query: 'Close dialog' })),
      (body) => {
        const text = JSON.stringify(body.messages).replace(/\\"/g, '"');
        const ref = /"ref":"([^"]+)","role":"button","name":"Close dialog"/.exec(text)?.[1];
        return tools(toolCall('click_element', { ref }));
      },
      say('Chose Blue and closed the dialog.'),
    ]);
    const controls = await waitForStatus(ENDED);
    check(
      'Dropdowns, modals and late content all work',
      controls?.status === 'completed' &&
        controls.timeline.every((entry) => entry.status === 'done') &&
        (await state()).tabs.some((tab) => tab.title === 'Dialog closed'),
      controls?.error ?? controls?.summary,
    );

    // --- The user moving tabs during a task ---
    await start('Work on the wiki page, while the user goes elsewhere', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/form-page` })),
      async () => {
        await send({
          type: 'panel.execute',
          command: { action: 'tab.switch', target: { tabId: wikiTab.id } },
          confirmed: false,
        });
        await sleep(200);
        return tools(toolCall('get_page_metadata'));
      },
      say('Read it.'),
    ]);
    const moved = await waitForStatus(ENDED);
    const lastTool = JSON.stringify(groq.chatRequests.at(-1)?.messages ?? []);
    check(
      'A task stays on its own tab when the user switches away',
      moved?.status === 'completed' &&
        lastTool.includes('Controls') &&
        !lastTool.includes('imitation'),
    );

    // --- Internal pages ---
    await start('Open the browser settings', [
      tools(toolCall('open_tab', { url: 'chrome://settings' })),
      say('I can’t open browser settings.'),
    ]);
    const internal = await waitForStatus(ENDED);
    check(
      'Internal pages stay out of reach',
      internal?.timeline.some((entry) => entry.status === 'failed') &&
        !(await state()).tabs.some((tab) => tab.url?.startsWith('chrome://settings')),
    );

    // --- Batches of tabs: real tabs in a real browser, counted by the browser itself ---
    const allTabIds = () =>
      evaluate(
        panel,
        `chrome.tabs.query({ windowType: 'normal' }).then((t) => t.map((x) => x.id))`,
      );
    const activeTabId = () =>
      evaluate(
        panel,
        `chrome.tabs.query({ active: true, windowType: 'normal' }).then((t) => t[0]?.id)`,
      );
    /** Runs an instruction, and returns the tabs it really added and how it ended. */
    const batch = async (instruction) => {
      const ids = new Set(await allTabIds());
      const failedBefore = groq.chatRequests.length;
      const started = await start(instruction);
      const run = await waitForStatus(ENDED, 60000);
      const added = (await allTabIds()).filter((id) => !ids.has(id));
      return { started, run, added, usedAi: groq.chatRequests.length > failedBefore };
    };
    const closeAll = (ids) => evaluate(panel, `chrome.tabs.remove(${JSON.stringify(ids)})`);

    for (const [instruction, count] of [
      ['Open 1 new tab.', 1],
      ['Create 5 blank tabs.', 5],
      ['Open 10 new tabs.', 10],
      ['Open 20 new tabs.', 20],
      ['open twelve empty tabs', 12],
      ['make a dozen new tabs', 12],
    ]) {
      const front = await activeTabId();
      const { run, added, usedAi } = await batch(instruction);
      check(
        `"${instruction}" creates exactly ${count}, with no AI`,
        run?.status === 'completed' && added.length === count && !usedAi,
        `${added.length} tabs in ${run?.metrics?.totalMs}ms: ${run?.summary}`,
      );
      if (count > 1) {
        check(`It leaves the current tab in front (${count})`, (await activeTabId()) === front);
      }
      await closeAll(added);
    }

    // Typed into the real side panel, watched as a person would see it.
    {
      const ids = new Set(await allTabIds());
      const seen = new Set();
      await fill(panel, 'textarea', 'Open 10 new tabs.');
      await clickButton(panel, 'Send');
      const deadline = Date.now() + 15000;
      let agent = null;
      while (Date.now() < deadline) {
        agent = (await state()).agent;
        for (const entry of agent?.timeline ?? []) {
          const match = /^Creating tab (\d+) of 10$/.exec(entry.label);
          if (match && agent.instruction === 'Open 10 new tabs.') seen.add(Number(match[1]));
        }
        if (agent?.instruction === 'Open 10 new tabs.' && ENDED.includes(agent.status)) break;
        await sleep(15);
      }
      const added = (await allTabIds()).filter((id) => !ids.has(id));
      check(
        'Open 10 new tabs, typed in the side panel: exactly 10',
        added.length === 10,
        `${added.length}`,
      );
      check(
        'It shows progress as "Creating tab N of 10"',
        seen.size > 0,
        `saw ${[...seen].sort((a, b) => a - b).join(',')}`,
      );
      check(
        'The conversation reports how many were created',
        await waitFor(panel, `document.body.innerText.includes('Opened 10 of 10 new tabs')`),
      );
      await closeAll(added);
    }

    {
      const { run, added } = await batch(
        `Open ${host}/wiki, ${host}/github, and ${host}/turing in separate tabs.`,
      );
      const urls = await evaluate(
        panel,
        `Promise.all(${JSON.stringify(added)}.map((id) => chrome.tabs.get(id).then((t) => t.pendingUrl || t.url)))`,
      );
      check(
        'Opens different addresses in separate tabs',
        run?.status === 'completed' &&
          added.length === 3 &&
          ['/wiki', '/github', '/turing'].every((path) => urls.some((url) => url.includes(path))),
        run?.summary,
      );
      await closeAll(added);
    }

    {
      const { run, added } = await batch(`Open 3 tabs and navigate each to ${host}/turing.`);
      const urls = await evaluate(
        panel,
        `Promise.all(${JSON.stringify(added)}.map((id) => chrome.tabs.get(id).then((t) => t.pendingUrl || t.url)))`,
      );
      check(
        'Opens several tabs at the same address, when asked',
        added.length === 3 && urls.every((url) => url.includes('/turing')),
        run?.summary,
      );
      await closeAll(added);
    }

    {
      const { run, added } = await batch('Create 10 tabs and switch to the last one.');
      check(
        'Creates tabs and switches to the last one',
        run?.status === 'completed' &&
          added.length === 10 &&
          (await activeTabId()) === added.at(-1),
        run?.summary,
      );
      await closeAll(added);
    }
    {
      const { added } = await batch('open five tabs, then go to the second one');
      check(
        'Creates tabs and switches to a requested one',
        added.length === 5 && (await activeTabId()) === added[1],
      );
      await closeAll(added);
    }

    for (const [instruction, why] of [
      ['Open 21 new tabs.', /at most 20/],
      ['open a thousand new tabs', /at most 20/],
      ['open 0 tabs', /no tabs/i],
    ]) {
      const { run, added, usedAi } = await batch(instruction);
      check(
        `"${instruction}" is refused clearly, opening nothing`,
        run?.status === 'failed' && why.test(run.error ?? '') && added.length === 0 && !usedAi,
        run?.error,
      );
    }

    // Stop halfway, on pages slow enough to catch it there.
    {
      const ids = new Set(await allTabIds());
      const list = Array.from({ length: 20 }, () => `${host}/slow`).join(', ');
      await start(`Open ${list} in separate tabs.`);
      const deadline = Date.now() + 20000;
      let reached = 0;
      while (Date.now() < deadline && reached < 6) {
        const label = (await state()).agent?.timeline.at(-1)?.label ?? '';
        reached = Number(/^Creating tab (\d+) of 20$/.exec(label)?.[1] ?? 0);
        await sleep(20);
      }
      await send({ type: 'panel.stop_agent' });
      const stopped = await waitForStatus(['cancelled'], 3000);
      await sleep(1200);
      const final = (await state()).agent;
      const added = (await allTabIds()).filter((id) => !ids.has(id));
      await sleep(1000);
      const later = (await allTabIds()).filter((id) => !ids.has(id));
      const stated = Number(/after opening (\d+) of 20/.exec(final?.summary ?? '')?.[1] ?? -1);
      check(
        'Cancelling halfway stops the batch, and nothing more opens',
        stopped?.status === 'cancelled' &&
          added.length >= 5 &&
          added.length < 20 &&
          later.length === added.length,
        `${added.length} tabs`,
      );
      check('It reports exactly how many were opened', stated === added.length, final?.summary);
      await closeAll(later);
    }

    // The same request sent twice at once.
    {
      const ids = new Set(await allTabIds());
      await send({ type: 'panel.reset_conversation' });
      const [first, second] = await Promise.all([
        send({ type: 'panel.start_agent', instruction: 'Open 5 new tabs.' }),
        send({ type: 'panel.start_agent', instruction: 'Open 5 new tabs.' }),
      ]);
      await waitForStatus(ENDED, 15000);
      const added = (await allTabIds()).filter((id) => !ids.has(id));
      check(
        'A duplicate request does not double the tabs',
        [first.error, second.error].filter((error) => error === null).length === 1 &&
          added.length === 5,
        `${added.length} tabs`,
      );
      await closeAll(added);
    }

    // The same batch asked for twice, and more than the limit in pieces, by a model.
    {
      const { run, added } = await (async () => {
        const ids = new Set(await allTabIds());
        await start('Please make me lots of tabs for work', [
          tools(toolCall('open_tabs', { count: 4 })),
          tools(toolCall('open_tabs', { count: 4 })),
          tools(toolCall('open_tabs', { count: 18 })),
          say('I could only open some of them, not all.'),
        ]);
        const ended = await waitForStatus(ENDED, 15000);
        return { run: ended, added: (await allTabIds()).filter((id) => !ids.has(id)) };
      })();
      check(
        'A model cannot repeat a batch or go past the limit in pieces',
        run?.status === 'completed' && added.length === 4,
        `${added.length} tabs`,
      );
      await closeAll(added);
    }

    // Existing single-tab behaviour.
    {
      const { run, added } = await batch(`Open a new tab and go to ${host}/wiki.`);
      check(
        'A single new tab still opens in front, as before',
        run?.status === 'completed' && added.length === 1 && (await activeTabId()) === added[0],
        run?.summary,
      );
      await closeAll(added);
    }

    check('Nothing reached the real Groq API', groq.unstubbed === 0, `${groq.unstubbed} requests`);
  } catch (error) {
    check('Reliability verification completed', false, error.message);
  } finally {
    await browser.close();
    fixtures.server.close();
  }
  return allPassed();
}
