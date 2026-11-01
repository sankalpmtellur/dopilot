import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '../../packages/shared/dist/index.js';
import { createChecks, createPageTools, launch, sleep } from './browser.mjs';

const FAKE_KEY = 'gsk_verifyOnlyNotARealKey000000000000abcd';

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title><style>body{margin:0;font:14px sans-serif}</style></head><body>${body}</body></html>`;

const ICON =
  '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="white"/></svg>';

function startFixtures() {
  const posts = [];
  const handler = (request, response) => {
    const url = new URL(request.url, 'http://x');
    response.setHeader('content-type', 'text/html');
    if (request.method === 'POST') {
      posts.push(url.pathname);
      return response.end(page('Done', 'Submitted'));
    }
    switch (url.pathname) {
      case '/icons':
        return response.end(
          page(
            'Icon page',
            `<button id="red" style="position:absolute;left:40px;top:40px;width:60px;height:60px;background:rgb(220,30,30);border:0" onclick="document.title='RED'">${ICON}</button>
             <button id="blue" style="position:absolute;left:200px;top:40px;width:60px;height:60px;background:rgb(30,90,240);border:0" onclick="document.title='BLUE'">${ICON}</button>
             <button style="position:absolute;left:400px;top:40px;width:120px;height:60px" onclick="document.title='DELETED'">Delete account</button>
             <label style="position:absolute;left:40px;top:200px">Password <input id="pw" type="password" value="hunter2" style="width:200px;height:40px;background:white"></label>`,
          ),
        );
      case '/canvas':
        return response.end(
          page(
            'Canvas page',
            `<canvas id="c" width="800" height="400" style="position:absolute;left:0;top:0;background:#eee"></canvas>
             <div style="height:3000px"></div>
             <script>window.hits=[];c.addEventListener('click',e=>{hits.push([e.clientX,e.clientY]);document.title='HIT'});</script>`,
          ),
        );
      case '/frame':
        return response.end(
          page(
            'Frame page',
            `<iframe title="Embedded" src="about:blank" style="position:absolute;left:0;top:0;width:600px;height:300px;border:0"></iframe>`,
          ),
        );
      case '/quiz':
        return response.end(
          page(
            'Week 3 Quiz',
            `<h1>Question 1</h1><form method="post" action="/grade"><button id="s" style="width:200px;height:60px">Submit answers</button></form>`,
          ),
        );
      case '/captcha':
        return response.end(
          page('Check', `<div class="g-recaptcha" style="width:300px;height:80px">captcha</div>`),
        );
      case '/checkout':
        return response.end(page('Checkout', '<h1>Pay now</h1>'));
      case '/other':
        return response.end(page('Other site', '<h1>Other</h1>'));
      default:
        response.statusCode = 404;
        return response.end(page('Missing', 'Missing'));
    }
  };
  const server = createServer(handler);
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({ server, posts, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

const toolCall = (name, args = {}) => ({
  id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const tools = (...calls) => ({ tool_calls: calls });
const say = (content) => ({ content });

function toolResults(body) {
  return body.messages
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content).replace(/\\"/g, '"'));
}

function lastData(body, key) {
  for (const text of toolResults(body).reverse()) {
    const match = text.match(new RegExp(`"${key}":"([^"]+)"`));
    if (match) return match[1];
  }
  throw new Error(
    `The scenario expected ${key} in a tool result. Last: ${String(toolResults(body).at(-1)).slice(0, 300)}`,
  );
}

const isVisionRequest = (body) =>
  body.messages.some((message) => Array.isArray(message.content)) ||
  (body.tools ?? []).length === 0;

async function createStub(browser) {
  const stub = {
    main: [],
    vision: [],
    speech: [],
    mainRequests: [],
    visionRequests: [],
    speechRequests: 0,
    speechType: '',
    otherHosts: 0,
    held: null,
  };

  const fulfil = (sessionId, requestId, status, body, headers = []) =>
    browser
      .send(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: status,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...headers],
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
        },
        sessionId,
      )
      .catch(() => undefined);

  async function answer(sessionId, { requestId, request }) {
    if (request.url.endsWith('/models')) {
      return fulfil(sessionId, requestId, 200, {
        object: 'list',
        data: [
          { id: 'llama-3.3-70b-versatile', active: true },
          { id: 'qwen/qwen3.8-27b', active: true },
          { id: 'whisper-large-v3-turbo', active: true },
        ],
      });
    }
    if (request.url.includes('/audio/transcriptions')) {
      stub.speechRequests += 1;
      stub.speechType = request.headers['Content-Type'] ?? request.headers['content-type'] ?? '';
      const step = stub.speech.shift() ?? { text: 'Script ended' };
      if (step.status)
        return fulfil(sessionId, requestId, step.status, { error: {} }, step.headers);
      return fulfil(sessionId, requestId, 200, step);
    }

    let raw = request.postData;
    if (!raw) raw = (await browser.send('Fetch.getRequestBody', { requestId }, sessionId)).body;
    const body = JSON.parse(raw);
    const vision = isVisionRequest(body);
    (vision ? stub.visionRequests : stub.mainRequests).push(body);

    const step = (vision ? stub.vision : stub.main).shift();
    if (!step) {
      return fulfil(sessionId, requestId, 200, {
        choices: [{ message: { role: 'assistant', content: 'Script ended.' } }],
      });
    }
    if (step.hold) {
      stub.held = { sessionId, requestId };
      step.onHold?.();
      return undefined;
    }
    if (step.status) {
      return fulfil(sessionId, requestId, step.status, step.body ?? { error: {} }, step.headers);
    }
    const message = typeof step === 'function' ? step(body) : step;
    return fulfil(sessionId, requestId, 200, {
      choices: [{ message: { role: 'assistant', content: null, ...message } }],
    });
  }

  browser.onEvent((event) => {
    if (event.method === 'Fetch.requestPaused') {
      void answer(event.sessionId, event.params).catch((error) => {
        console.log(`  NOTE  Scenario problem: ${error.message}`);
        return fulfil(event.sessionId, event.params.requestId, 500, { error: {} });
      });
    }
    if (event.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = event.params;
      if (targetInfo.type === 'service_worker') {
        void browser
          .send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.groq.com/*' }] }, sessionId)
          .catch(() => undefined);
      }
      void browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    }
  });
  await browser.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [
      { type: 'service_worker', exclude: false },
      { type: 'page', exclude: true },
    ],
  });
  return stub;
}

/** With <all_urls> as a browser permission, so the per-site rules are what gets tested. */
function buildCopy(extensionPath, hosts) {
  const copy = mkdtempSync(join(tmpdir(), 'dopilot-verify-copy-'));
  cpSync(extensionPath, copy, { recursive: true });
  const manifestPath = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions.push('tabs');
  manifest.host_permissions.push(...hosts);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return copy;
}

export async function verifyVoiceAndVision(name, executable, extensionPath) {
  const copy = buildCopy(extensionPath, ['<all_urls>']);
  const fixtures = await startFixtures();
  const browser = launch(executable, { blockNetwork: true, fakeMic: true });
  const tools_ = createPageTools(browser);
  const { open, evaluate, waitFor, waitForTarget, clickButton, screenshot } = tools_;
  const { check, allPassed } = createChecks();
  const gesture = { userGesture: true };

  try {
    console.log(`\n${name}, voice and vision:`);
    const stub = await createStub(browser);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: copy });
    await waitForTarget((target) => target.type === 'service_worker' && target.url.includes(id));

    const panel = await open(`chrome-extension://${id}/sidepanel/index.html`);
    await waitFor(panel, `document.body.innerText.includes('Dopilot')`);

    const send = (body) =>
      evaluate(
        panel,
        `chrome.runtime.sendMessage(${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body })})`,
      );
    const state = async () => (await send({ type: 'panel.get_state' })).state;
    const setStorage = (items) =>
      evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)})`);

    async function waitForStatus(statuses, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const agent = (await state()).agent;
        if (agent && statuses.includes(agent.status)) return agent;
        await sleep(100);
      }
      return (await state()).agent;
    }
    const finished = () => waitForStatus(['completed', 'failed', 'cancelled']);
    const paused = () =>
      waitForStatus(['waiting_for_approval', 'completed', 'failed', 'cancelled']);

    const allow = async () => {
      await waitFor(panel, `document.querySelector('[role=alertdialog]')`);
      return clickButton(panel, 'Allow', gesture);
    };

    /** Titles of every tab showing this page, since each scenario opens its own. */
    async function titlesOf(fragment) {
      const { targetInfos } = await browser.send('Target.getTargets');
      return targetInfos.filter((t) => t.url.includes(fragment)).map((t) => t.title);
    }

    async function start(instruction, main, vision = []) {
      stub.main = main;
      stub.vision = vision;
      stub.mainRequests.length = 0;
      stub.visionRequests.length = 0;
      await send({ type: 'panel.reset_conversation' });
      return send({ type: 'panel.start_agent', instruction });
    }

    /** Keeps approving until the task ends or hits a kind of approval it was not told to pass. */
    async function runApproving(kinds) {
      for (let step = 0; step < 8; step += 1) {
        const agent = await paused();
        if (agent?.status !== 'waiting_for_approval' || !kinds.includes(agent.approval?.kind)) {
          return agent;
        }
        await allow();
        await sleep(250);
      }
      return (await state()).agent;
    }

    await setStorage({ groqApiKey: FAKE_KEY });

    // --- Browser support, reported as found ---
    const support = JSON.parse(
      await evaluate(
        panel,
        `JSON.stringify({ speech: typeof (window.SpeechRecognition || window.webkitSpeechRecognition), recorder: typeof MediaRecorder, tts: typeof speechSynthesis, brave: Boolean(navigator.brave) })`,
      ),
    );
    check(
      'Browser has what voice needs',
      support.recorder === 'function' && support.tts === 'object',
      JSON.stringify(support),
    );

    // --- Voice, through the real microphone pipeline with a synthetic device ---
    const micButton = `[...document.querySelectorAll('button')].find((b) => /Speak a command|Finish speaking/.test(b.getAttribute('aria-label')))`;
    await send({ type: 'panel.reset_conversation' });

    const noConsent = await evaluate(
      panel,
      `(async () => {
      await chrome.storage.local.set({ preferences: { vision: true, speechFallback: false, voiceEngine: 'groq' } });
      return true;
    })()`,
    );
    await sleep(300);
    await evaluate(panel, `${micButton}.click()`);
    const refused = await waitFor(panel, `document.querySelector('[role=alert]')?.textContent`);
    check(
      'Voice through Groq needs agreement first',
      noConsent && /allow sending voice to Groq/.test(refused ?? '') && stub.speechRequests === 0,
      refused,
    );

    await setStorage({ preferences: { vision: true, speechFallback: true, voiceEngine: 'groq' } });
    await waitFor(panel, `true`);
    await sleep(500);

    stub.speech = [{ text: 'Dopilot, open a new tab.' }];
    const tabsBefore = (await state()).tabs.length;
    await evaluate(panel, `${micButton}.click()`);
    await waitFor(
      panel,
      `document.querySelector('[data-testid=voice-status]')?.textContent.includes('Listening')`,
    );
    const listening = await evaluate(
      panel,
      `document.querySelector('[data-testid=voice-status]')?.textContent`,
    );
    check(
      'Shows it is listening, and where the audio goes',
      /Listening/.test(listening ?? '') && /sent to Groq/.test(listening ?? ''),
      listening,
    );
    const pressed = await evaluate(panel, `${micButton}.getAttribute('aria-pressed')`);
    check('The microphone button shows it is active', pressed === 'true');

    await sleep(900);
    check('Nothing is sent while still recording', stub.speechRequests === 0);
    await evaluate(panel, `${micButton}.click()`);
    const typedResult = await waitFor(
      panel,
      `document.body.innerText.includes('Opened a new tab.')`,
      10000,
    );
    check(
      'A real recording reaches speech-to-text',
      stub.speechRequests === 1 && stub.speechType.startsWith('multipart/form-data'),
      stub.speechType.slice(0, 30),
    );
    const tabsAfterSpeech = (await state()).tabs.length;
    await browser.send('Page.bringToFront', {}, panel.sessionId);
    check(
      'Speech runs as a command, without the wake word',
      typedResult && tabsAfterSpeech === tabsBefore + 1,
    );
    check(
      'The microphone is released afterwards',
      await waitFor(panel, `!document.querySelector('[data-testid=voice-status]')`),
    );

    stub.speech = [{ text: 'Delete everything' }];
    const speechBefore = stub.speechRequests;
    await evaluate(panel, `${micButton}.click()`);
    await waitFor(
      panel,
      `document.querySelector('[data-testid=voice-status]')?.textContent.includes('Listening')`,
    );
    await sleep(500);
    await clickButton(panel, 'Cancel voice input');
    await sleep(800);
    check('Cancelling the microphone sends nothing', stub.speechRequests === speechBefore);

    stub.speech = [{ status: 429, headers: [{ name: 'retry-after', value: '60' }] }];
    await evaluate(panel, `${micButton}.click()`);
    await waitFor(
      panel,
      `document.querySelector('[data-testid=voice-status]')?.textContent.includes('Listening')`,
    );
    await sleep(500);
    await evaluate(panel, `${micButton}.click()`);
    const limited = await waitFor(panel, `document.querySelector('[role=alert]')?.textContent`);
    check('Explains the free-tier voice limit', /free-tier/.test(limited ?? ''), limited);

    // A spoken task goes through the same agent.
    stub.speech = [{ text: 'Open the other page.' }];
    stub.main = [
      tools(toolCall('open_tab', { url: `${fixtures.base}/other` })),
      say('Opened the other page.'),
    ];
    stub.mainRequests.length = 0;
    await evaluate(panel, `${micButton}.click()`);
    await waitFor(
      panel,
      `document.querySelector('[data-testid=voice-status]')?.textContent.includes('Listening')`,
    );
    await sleep(500);
    await evaluate(panel, `${micButton}.click()`);
    const spokenTask = await waitFor(
      panel,
      `document.body.innerText.includes('Opened the other page.')`,
      15000,
    );
    check(
      'A spoken instruction runs through the same agent',
      spokenTask && JSON.stringify(stub.mainRequests[0]?.messages).includes('Open the other page.'),
    );

    // Stop, spoken, while a task runs.
    let heldTask;
    const taskHeld = new Promise((done) => (heldTask = done));
    stub.main = [
      { hold: true, onHold: heldTask },
      tools(toolCall('open_tab', { url: `${fixtures.base}/other?never` })),
    ];
    await send({ type: 'panel.start_agent', instruction: 'A long task' });
    await taskHeld;
    stub.speech = [{ text: 'Stop.' }];
    const agentRequests = stub.mainRequests.length;
    await waitFor(panel, `document.querySelector('[aria-label="Stop task"]')`);
    await evaluate(panel, `${micButton}.click()`);
    await waitFor(
      panel,
      `document.querySelector('[data-testid=voice-status]')?.textContent.includes('Listening')`,
    );
    await sleep(500);
    await evaluate(panel, `${micButton}.click()`);
    const stopped = await finished();
    check(
      'Saying “stop” stops the task, without using the AI',
      stopped?.status === 'cancelled' && stub.mainRequests.length === agentRequests,
      stopped?.status === 'cancelled'
        ? ''
        : `${stopped?.status}, voice said: ${await evaluate(panel, `document.querySelector('[role=alert]')?.textContent ?? 'nothing'`)}`,
    );

    // --- Spoken replies, with the real speech API ---
    const spokenLog = await evaluate(
      panel,
      `(async () => {
      window.__spoken = [];
      const original = speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak = (utterance) => { window.__spoken.push(utterance.text); };
      return typeof original;
    })()`,
    );
    await setStorage({ authorizedSites: [fixtures.base] });
    await clickButton(panel, 'Turn on spoken replies');
    await sleep(200);
    await start('Open it', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/other` })),
      say('Opened the page. More detail here.'),
    ]);
    await finished();
    const said = await waitFor(
      panel,
      `window.__spoken.length >= 2 ? JSON.stringify(window.__spoken) : null`,
    );
    check(
      'Speaks a confirmation and short result, not every step',
      spokenLog && said?.includes('Opened the page.') && !said.includes('More detail'),
      said,
    );

    await evaluate(panel, `window.__spoken.length = 0`);
    await setStorage({ authorizedSites: [fixtures.base] });
    await start('Read it', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/other` })),
      tools(toolCall('get_visible_text')),
      say('Your secret balance is 500.'),
    ]);
    await finished();
    await sleep(400);
    const saidAfterReading = await evaluate(panel, `JSON.stringify(window.__spoken)`);
    check(
      'Never reads page content aloud automatically',
      !saidAfterReading.includes('balance') && saidAfterReading.includes('on your screen'),
      saidAfterReading,
    );
    await clickButton(panel, 'Mute spoken replies');

    // --- Site authorization, even though the browser permission allows everything ---
    await setStorage({ authorizedSites: [] });
    await start('What is on my screen?', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/icons` })),
      tools(toolCall('analyze_screenshot', { question: 'What is on my screen?' })),
      say('Done'),
    ]);
    const askedForSite = await paused();
    check(
      'Holding <all_urls> does not unlock a site: it asks first',
      askedForSite?.approval?.kind === 'site_access',
      askedForSite?.approval?.title,
    );
    check('Nothing was captured or sent yet', stub.visionRequests.length === 0);
    await allow();
    await sleep(300);
    const stored = await evaluate(
      panel,
      `chrome.storage.local.get('authorizedSites').then((r) => r.authorizedSites)`,
    );
    check(
      'Records exactly the approved site',
      stored?.length === 1 && stored[0] === fixtures.base,
      stored?.join(),
    );

    // --- Consent and preview ---
    const consent = await paused();
    check(
      'Asks before sending a screenshot, and says who processes it',
      consent?.approval?.kind === 'screenshot' &&
        /Groq/.test(consent.approval.title + consent.approval.detail),
      consent?.approval?.title,
    );
    check('Nothing is sent before agreeing', stub.visionRequests.length === 0);
    const preview = await waitFor(
      panel,
      `document.querySelector('img[alt="The screenshot that would be sent"]')?.naturalWidth`,
    );
    check('Shows a real preview of what will be sent', preview > 100, `${preview}px wide`);

    // The password field must be hidden in the image itself.
    const previewUrl = await evaluate(
      panel,
      `document.querySelector('img[alt="The screenshot that would be sent"]').src`,
    );
    const pageShot = await waitForTarget((t) => t.type === 'page' && t.url.includes('/icons'));
    const iconPage = await browser.send('Target.attachToTarget', {
      targetId: pageShot.targetId,
      flatten: true,
    });
    const iconSession = { targetId: pageShot.targetId, sessionId: iconPage.sessionId };
    await screenshot(panel, `${name}-screenshot-consent`, { width: 380, height: 760 });
    await browser.send('Page.bringToFront', {}, iconSession.sessionId);
    const pixels = await evaluate(
      panel,
      `(async () => {
      const box = ${JSON.stringify(await evaluate(iconSession, `(() => { const r = document.querySelector('#pw').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vw: innerWidth, vh: innerHeight }; })()`))};
      const img = new Image(); img.src = ${JSON.stringify(previewUrl)}; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const at = (x, y) => [...g.getImageData(x * img.width / box.vw, y * img.height / box.vh, 1, 1).data];
      return { secret: at(box.x, box.y), control: at(5, 5), size: [img.width, img.height], bytes: ${previewUrl.length} };
    })()`,
    );
    check(
      'Password fields are painted over in the image',
      pixels.secret[0] < 30 && pixels.secret[1] < 30 && pixels.control[0] > 200,
      JSON.stringify(pixels.secret),
    );
    check(
      'The image is resized and compressed',
      Math.max(...pixels.size) <= 1280 && pixels.bytes < 1_000_000,
      `${pixels.size.join('x')}, ${Math.round(pixels.bytes / 1024)} KB`,
    );

    stub.vision = [say('A page with two square buttons, one red and one blue.')];
    await allow();
    const seen = await finished();
    const visionBody = stub.visionRequests[0];
    const parts = visionBody?.messages.at(-1)?.content ?? [];
    check(
      'Sends a real image and text request to a vision model',
      visionBody?.model === 'qwen/qwen3.8-27b' &&
        parts.some(
          (part) =>
            part.type === 'image_url' &&
            part.image_url.url.startsWith('data:image/jpeg;base64,/9j/'),
        ) &&
        parts.some((part) => part.type === 'text'),
      visionBody?.model,
    );
    check(
      'The reply reaches the agent as untrusted data',
      JSON.stringify(stub.mainRequests.at(-1).messages).includes('<untrusted_page_content>') &&
        JSON.stringify(stub.mainRequests.at(-1).messages).includes('two square buttons'),
    );
    check(
      'The main agent model never receives the image',
      !stub.mainRequests.some((body) => JSON.stringify(body).includes('base64,/9j/')),
    );
    check('Marks the run as using page content', seen?.readPageContent === true);

    const freed = await evaluate(
      panel,
      `chrome.storage.session.get(null).then((all) => JSON.stringify(all).includes('/9j/'))`,
    );
    const freedLocal = await evaluate(
      panel,
      `chrome.storage.local.get(null).then((all) => JSON.stringify(all).includes('/9j/'))`,
    );
    check('Screenshots are never written to storage', !freed && !freedLocal);
    const gone = await send({ type: 'panel.get_screenshot', id: consent.approval.screenshotId });
    check('Screenshots are forgotten when the task ends', gone.dataUrl === null);

    // --- Test D shape: "Click the blue button", icon-only, grounded on a real element ---
    const clickBlue = (body) => {
      const text = body.messages.at(-1).content.find((part) => part.type === 'text').text;
      const n = text.match(/(\d+): button \(no label\), blue/)?.[1];
      if (!n) throw new Error(`The list did not show a blue button: ${text.slice(0, 200)}`);
      return say(
        JSON.stringify({
          description: 'Two icon buttons',
          targets: [{ n: Number(n), why: 'It is blue' }],
          points: [],
        }),
      );
    };
    await start(
      'Click the blue button',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/icons` })),
        tools(toolCall('get_visual_page_context', { question: 'the blue button' })),
        (body) => tools(toolCall('click_element', { ref: lastData(body, 'ref') })),
        tools(toolCall('get_page_metadata')),
        say('Clicked the blue button.'),
      ],
      [clickBlue],
    );
    const blue = await runApproving(['screenshot']);
    check(
      'Clicks an icon-only button, grounded on the real element',
      blue?.status === 'completed' && (await titlesOf('/icons')).includes('BLUE'),
      (await titlesOf('/icons')).join(),
    );
    check('Used the DOM to observe first, and one screenshot', stub.visionRequests.length === 1);

    // --- Canvas: coordinates, with scaling checked against the real page ---
    const pickPoint = (body) => {
      const { text } = body.messages.at(-1).content.find((part) => part.type === 'text');
      const [, w, h] = text.match(/image is (\d+)x(\d+)/);
      return say(
        JSON.stringify({
          description: 'A canvas',
          targets: [],
          points: [
            { x: Math.round(Number(w) / 4), y: Math.round(Number(h) / 4), why: 'On the canvas' },
          ],
        }),
      );
    };
    await start(
      'Click the middle of the drawing',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/canvas` })),
        tools(toolCall('get_visual_page_context', { question: 'the drawing' })),
        (body) =>
          tools(
            toolCall('click_visual_target', {
              screenshotId: lastData(body, 'screenshotId'),
              pointId: 'p1',
            }),
          ),
        say('Clicked.'),
      ],
      [pickPoint],
    );
    const canvasRun = await runApproving(['screenshot']);
    const canvasTarget = await waitForTarget((t) => t.type === 'page' && t.url.includes('/canvas'));
    const canvasAttach = await browser.send('Target.attachToTarget', {
      targetId: canvasTarget.targetId,
      flatten: true,
    });
    const canvasPage = { targetId: canvasTarget.targetId, sessionId: canvasAttach.sessionId };
    const hit = await evaluate(
      canvasPage,
      `JSON.stringify({ hits, vw: innerWidth, vh: innerHeight })`,
    );
    const { hits, vw, vh } = JSON.parse(hit);
    check(
      'Scales a visual point correctly onto the real page',
      canvasRun?.status === 'completed' &&
        hits.length === 1 &&
        Math.abs(hits[0][0] - vw / 4) < 3 &&
        Math.abs(hits[0][1] - vh / 4) < 3,
      `clicked ${hits[0]?.join(',')} in ${vw}x${vh}`,
    );

    // --- A page that changed since the screenshot ---
    let holdForScroll;
    const scrollHeld = new Promise((done) => (holdForScroll = done));
    const screenshotIds = [];
    await start(
      'Click the drawing, after the page moves',
      [
        tools(toolCall('get_visual_page_context', { question: 'another part of the drawing' })),
        (body) => {
          screenshotIds.push(lastData(body, 'screenshotId'));
          holdForScroll();
          return tools(toolCall('get_tabs'));
        },
        (body) => {
          void body;
          return tools(
            toolCall('click_visual_target', { screenshotId: screenshotIds[0], pointId: 'p1' }),
          );
        },
        say('That did not work.'),
      ],
      [pickPoint],
    );
    const scrolling = runApproving(['screenshot']);
    await scrollHeld;
    await evaluate(canvasPage, `window.scrollTo(0, 500)`);
    await scrolling;
    const staleBody = JSON.stringify(stub.mainRequests.at(-1)?.messages ?? []);
    const hitsAfter = JSON.parse(await evaluate(canvasPage, `JSON.stringify(hits)`));
    check(
      'Rejects a stale screenshot, and does not click',
      /stale_screenshot/.test(staleBody) && hitsAfter.length === 1,
      `${hitsAfter.length} clicks`,
    );
    await evaluate(canvasPage, `window.scrollTo(0, 0)`);

    // --- Grounded targets cannot get around the rules ---
    const deleteBox = await evaluate(
      iconSession,
      `(() => { const r = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Delete account').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vw: innerWidth, vh: innerHeight }; })()`,
    );
    const pointAt = (box) => (body) => {
      const { text } = body.messages.at(-1).content.find((part) => part.type === 'text');
      const [, w, h] = text.match(/image is (\d+)x(\d+)/);
      return say(
        JSON.stringify({
          description: 'x',
          targets: [],
          points: [
            {
              x: Math.round((box.x * Number(w)) / box.vw),
              y: Math.round((box.y * Number(h)) / box.vh),
              why: 'there',
            },
          ],
        }),
      );
    };
    await start(
      'Click that button',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/icons` })),
        tools(toolCall('get_visual_page_context', { question: 'that button' })),
        (body) =>
          tools(
            toolCall('click_visual_target', {
              screenshotId: lastData(body, 'screenshotId'),
              pointId: 'p1',
            }),
          ),
        say('Finished.'),
      ],
      [pointAt(deleteBox)],
    );
    const risky = await runApproving(['screenshot']);
    check(
      'A visual click on something sensitive still needs approval',
      risky?.approval?.kind === 'action' && /Delete account/.test(risky.approval.title),
      risky?.approval?.title,
    );
    check('It was not clicked', !(await titlesOf('/icons')).includes('DELETED'));
    await send({ type: 'panel.stop_agent' });
    await finished();

    const quizBox = { x: 100, y: 90, vw: deleteBox.vw, vh: deleteBox.vh };
    await start(
      'Submit my quiz',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/quiz` })),
        tools(toolCall('get_visual_page_context', { question: 'the submit button' })),
        (body) =>
          tools(
            toolCall('click_visual_target', {
              screenshotId: lastData(body, 'screenshotId'),
              pointId: 'p1',
            }),
          ),
        say('never'),
      ],
      [pointAt(quizBox)],
    );
    const quiz = await runApproving(['screenshot']);
    check(
      'Cannot submit a graded quiz by clicking where it appears',
      quiz?.status === 'failed' &&
        /graded quiz/.test(quiz.error ?? '') &&
        !fixtures.posts.includes('/grade'),
      quiz?.error,
    );

    await start(
      'Look at this',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/frame` })),
        tools(toolCall('get_visual_page_context', { question: 'the button in the frame' })),
        (body) =>
          tools(
            toolCall('click_visual_target', {
              screenshotId: lastData(body, 'screenshotId'),
              pointId: 'p1',
            }),
          ),
        say('I cannot click inside that frame.'),
      ],
      [pointAt({ x: 100, y: 100, vw: deleteBox.vw, vh: deleteBox.vh })],
    );
    await runApproving(['screenshot']);
    check(
      'Is honest that frames cannot be clicked',
      JSON.stringify(stub.mainRequests.at(-1).messages).includes('inside_frame'),
    );

    await start('What does this say?', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/captcha` })),
      tools(toolCall('analyze_screenshot', { question: 'Solve this' })),
      say('never'),
    ]);
    const captcha = await runApproving(['screenshot']);
    check(
      'Never sends a CAPTCHA for analysis',
      captcha?.status === 'failed' &&
        /CAPTCHA/.test(captcha.error ?? '') &&
        stub.visionRequests.length === 0,
      captcha?.error,
    );

    await start('Look at settings', [
      tools(toolCall('open_tab')),
      tools(toolCall('analyze_screenshot', { question: 'What is here?' })),
      say('It is an internal page.'),
    ]);
    await finished();
    check(
      'Will not capture internal pages',
      JSON.stringify(stub.mainRequests.at(-1).messages).includes('restricted_page') &&
        stub.visionRequests.length === 0,
    );

    await start('Look at the checkout', [
      tools(toolCall('open_tab', { url: `${fixtures.base}/checkout` })),
      tools(toolCall('analyze_screenshot', { question: 'What is here?' })),
      say('ok'),
    ]);
    // The address asks first, and the screenshot warns separately.
    const checkout = await runApproving(['action']);
    check(
      'Warns about payment pages specifically',
      /payment/.test(checkout?.approval?.detail ?? ''),
      checkout?.approval?.detail?.slice(0, 50),
    );
    await send({ type: 'panel.stop_agent' });
    await finished();

    // --- Vision failures are honest ---
    await start(
      'What is on screen?',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/icons` })),
        tools(toolCall('analyze_screenshot', { question: 'q1' })),
        say('I could not see the page, because of a rate limit.'),
      ],
      [{ status: 429, headers: [{ name: 'retry-after', value: '60' }] }],
    );
    await runApproving(['screenshot']);
    const limitBody = JSON.stringify(stub.mainRequests.at(-1).messages);
    check(
      'Explains a free-tier image limit, and does not retry it',
      limitBody.includes('vision_rate_limited') && stub.visionRequests.length === 1,
    );

    await evaluate(
      panel,
      `chrome.storage.local.get('groqSettings').then(({ groqSettings }) => chrome.storage.local.set({ groqSettings: { ...groqSettings, visionFallback: 'verify/fallback-vision' } }))`,
    );
    await start(
      'What is on screen?',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/icons` })),
        tools(toolCall('analyze_screenshot', { question: 'q2' })),
        say('Saw it on the fallback.'),
      ],
      [
        { status: 404, body: { error: { code: 'model_not_found', message: 'gone' } } },
        say('Seen by the fallback model.'),
      ],
    );
    await runApproving(['screenshot']);
    const models = stub.visionRequests.map((body) => body.model);
    check(
      'Falls back to the configured model',
      models.length === 2 && models[0] !== models[1],
      models.join(' then '),
    );

    // Stop during vision.
    let visionHeld;
    const heldVision = new Promise((done) => (visionHeld = done));
    await start(
      'Look',
      [
        tools(toolCall('open_tab', { url: `${fixtures.base}/icons` })),
        tools(toolCall('analyze_screenshot', { question: 'q3' })),
        tools(toolCall('open_tab', { url: `${fixtures.base}/other?afterstop` })),
      ],
      [{ hold: true, onHold: visionHeld }],
    );
    const stopRun = runApproving(['screenshot']);
    await heldVision;
    await sleep(200);
    check(
      'Says when a screenshot is being used',
      await waitFor(panel, `document.body.innerText.includes('using a screenshot')`),
    );
    await screenshot(panel, `${name}-vision-running`, { width: 380, height: 760 });
    await clickButton(panel, 'Stop task');
    await stopRun;
    const stoppedVision = await finished();
    await sleep(600);
    const after = (await browser.send('Target.getTargets')).targetInfos.some((t) =>
      t.url.includes('afterstop'),
    );
    check(
      'Stop works during vision processing, and nothing further runs',
      stoppedVision?.status === 'cancelled' && !after,
    );

    // Vision can be turned off.
    await setStorage({ preferences: { vision: false, speechFallback: true, voiceEngine: 'groq' } });
    await sleep(200);
    await start('What is on screen?', [
      tools(toolCall('analyze_screenshot', { question: 'q4' })),
      say('Vision is off.'),
    ]);
    await finished();
    check(
      'Respects vision being turned off',
      JSON.stringify(stub.mainRequests.at(-1).messages).includes('vision_off') &&
        stub.visionRequests.length === 0,
    );
    await setStorage({ preferences: { vision: true, speechFallback: true, voiceEngine: 'groq' } });

    // --- The website: voice through the bridge, and no route to images ---
    const webRunning = await fetch('http://localhost:3000/api/health')
      .then((r) => r.ok)
      .catch(() => false);
    if (webRunning) {
      const web = await open('http://localhost:3000');
      await waitFor(web, `document.body.textContent.includes('Extension connected')`);
      const external = (body) =>
        evaluate(
          web,
          `chrome.runtime.sendMessage(${JSON.stringify(id)}, ${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), ...body })})`,
        );

      for (const [label, message] of [
        ['read a screenshot', { type: 'panel.get_screenshot', id: 'x' }],
        ['change settings', { type: 'external.set_preferences', vision: false }],
        ['answer an approval', { type: 'panel.resolve_approval', id: 'x', approved: true }],
      ]) {
        const reply = await external(message);
        check(`Website cannot ${label}`, reply?.reason === 'invalid_message');
      }
      const webState = JSON.stringify(await external({ type: 'external.get_state' }));
      check(
        'Bridge state never contains an image or key',
        !webState.includes('base64') && !webState.includes(FAKE_KEY),
      );

      stub.speech = [{ text: 'new tab' }];
      const webMic = `[...document.querySelectorAll('button')].find((b) => /Speak a command|Finish speaking/.test(b.getAttribute('aria-label')))`;
      await sleep(500);
      await evaluate(web, `${webMic}.click()`);
      await waitFor(
        web,
        `document.querySelector('[data-testid=voice-status]')?.textContent.includes('Listening')`,
      );
      await sleep(700);
      await evaluate(web, `${webMic}.click()`);
      check(
        'Website voice works through the extension, and runs the command',
        await waitFor(web, `document.body.innerText.includes('Opened a new tab.')`, 10000),
      );
      await setStorage({
        preferences: { vision: true, speechFallback: false, voiceEngine: 'groq' },
      });
      const refusedWeb = await external({
        type: 'external.transcribe',
        audio: 'AAAA',
        mimeType: 'audio/webm',
      });
      check(
        'Website cannot use Groq voice unless allowed in the extension',
        refusedWeb?.text === null && /turned off/.test(refusedWeb?.error ?? ''),
        refusedWeb?.error,
      );
    } else {
      check('Website is running for these checks', false);
    }
  } catch (error) {
    check('Voice and vision verification completed', false, error.message);
  } finally {
    await browser.close();
    fixtures.server.closeAllConnections();
    fixtures.server.close();
    rmSync(copy, { recursive: true, force: true });
  }
  return allPassed();
}
