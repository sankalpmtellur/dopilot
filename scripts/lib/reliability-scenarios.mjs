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
  const { open, evaluate, waitFor, waitForTarget } = createPageTools(browser);
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

    check('Nothing reached the real Groq API', groq.unstubbed === 0, `${groq.unstubbed} requests`);
  } catch (error) {
    check('Reliability verification completed', false, error.message);
  } finally {
    await browser.close();
    fixtures.server.close();
  }
  return allPassed();
}
