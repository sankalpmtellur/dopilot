#!/usr/bin/env node
// Runs the built extension and the website in real Chrome and Brave, over the DevTools
// protocol, using throwaway profiles. Real profiles are never touched. Groq is stubbed
// at the network layer, so nothing here contacts Groq.
//
//   pnpm build && pnpm dev:web      (in one terminal)
//   pnpm verify:extension           (in another)
//
// Environment: WEB_URL, VERIFY_BROWSER (Chrome or Brave), VERIFY_HEADED=1 to show the
// browser window, SCREENSHOT_DIR to save screenshots of the interface.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '../packages/shared/dist/index.js';

const extensionPath = resolve(import.meta.dirname, '../apps/extension/dist');
const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
const screenshotDir = process.env.SCREENSHOT_DIR;
const browsers = {
  Chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  Brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};
const FAKE_KEY = 'gsk_verifyOnlyNotARealKey000000000000abcd';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function launch(executable) {
  const profile = mkdtempSync(join(tmpdir(), 'dopilot-verify-'));
  const child = spawn(
    executable,
    [
      ...(process.env.VERIFY_HEADED ? [] : ['--headless=new']),
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,860',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );

  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  const listeners = new Set();
  child.stdio[4].setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method) {
        for (const listener of listeners) listener(message);
        continue;
      }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) });
      child.stdio[3].write(`${payload}\0`);
      return new Promise((done, reject) => pending.set(id, { resolve: done, reject }));
    },
    onEvent: (listener) => listeners.add(listener),
    async close() {
      const exited = new Promise((done) => child.once('exit', done));
      child.kill();
      await exited;
      // Helper processes can outlive the browser briefly, so retry. A leftover
      // temp profile is harmless and must not fail the verification.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true });
          return;
        } catch {
          await sleep(500);
        }
      }
      console.log(`  NOTE  Could not remove temp profile ${profile}`);
    },
  };
}

function createPageTools(browser) {
  async function open(url) {
    const { targetId } = await browser.send('Target.createTarget', { url });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }

  async function evaluate(page, expression, options = {}) {
    const { result, exceptionDetails } = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, ...options },
      page.sessionId,
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  /** Polls until the expression is truthy, and returns its value (or null on timeout). */
  async function waitFor(page, expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(page, expression).catch(() => null);
      if (value) return value;
      await sleep(100);
    }
    return null;
  }

  async function waitForTarget(match, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { targetInfos } = await browser.send('Target.getTargets');
      const found = targetInfos.find(match);
      if (found) return found;
      await sleep(100);
    }
    return null;
  }

  const clickButton = (page, label) =>
    evaluate(
      page,
      `(() => {
        const label = ${JSON.stringify(label)};
        const button = [...document.querySelectorAll('button')].find(
          (el) => (el.getAttribute('aria-label') === label || el.textContent.trim() === label) && !el.disabled,
        );
        if (button) button.click();
        return Boolean(button);
      })()`,
    );

  // Uses the native setter so React sees the change, as it would from real typing.
  const fill = (page, selector, value) =>
    evaluate(
      page,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    );

  async function screenshot(page, name, { width, height } = {}) {
    if (!screenshotDir) return;
    await browser.send('Page.bringToFront', {}, page.sessionId);
    if (width) {
      await browser.send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 2, mobile: false },
        page.sessionId,
      );
      await sleep(400);
    }
    const { data } = await browser.send(
      'Page.captureScreenshot',
      { format: 'png' },
      page.sessionId,
    );
    writeFileSync(join(screenshotDir, `${name}.png`), Buffer.from(data, 'base64'));
    if (width) await browser.send('Emulation.clearDeviceMetricsOverride', {}, page.sessionId);
  }

  return { open, evaluate, waitFor, waitForTarget, clickButton, fill, screenshot };
}

function createChecks() {
  const results = [];
  return {
    check(label, passed, detail = '') {
      results.push(Boolean(passed));
      console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
    },
    allPassed: () => results.every(Boolean),
  };
}

/** Answers Groq requests from the service worker, so no test ever reaches Groq. */
async function stubGroq(browser, workerTargetId) {
  const stub = { status: 200, headers: [], requests: [] };
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId: workerTargetId,
    flatten: true,
  });
  browser.onEvent((event) => {
    if (event.method !== 'Fetch.requestPaused' || event.sessionId !== sessionId) return;
    stub.requests.push(event.params.request);
    const body =
      stub.status === 200
        ? {
            object: 'list',
            data: [
              { id: 'verify-text-model', active: true },
              { id: 'verify-whisper-model', active: true },
              { id: 'verify-retired-model', active: false },
            ],
          }
        : { error: { message: 'stubbed' } };
    void browser.send(
      'Fetch.fulfillRequest',
      {
        requestId: event.params.requestId,
        responseCode: stub.status,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...stub.headers],
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      },
      sessionId,
    );
  });
  await browser.send(
    'Fetch.enable',
    { patterns: [{ urlPattern: 'https://api.groq.com/*' }] },
    sessionId,
  );
  return stub;
}

async function verifyProduct(name, executable) {
  const browser = launch(executable);
  const tools = createPageTools(browser);
  const { open, evaluate, waitFor, waitForTarget, clickButton, fill, screenshot } = tools;
  const { check, allPassed } = createChecks();

  try {
    const version = (await browser.send('Browser.getVersion')).product;
    console.log(`\n${name}: ${version}`);

    const { id } = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
    check('Loads as an unpacked extension', Boolean(id), id);

    const worker = await waitForTarget(
      (target) => target.type === 'service_worker' && target.url.includes(id),
    );
    check('Service worker starts', Boolean(worker));

    const groq = await stubGroq(browser, worker.targetId);
    const base = `chrome-extension://${id}`;

    // --- Side panel page ---
    const panel = await open(`${base}/sidepanel/index.html`);
    check(
      'Side panel renders with real state',
      await waitFor(panel, `document.body.innerText.includes('No Groq key')`),
    );
    const panelSend = (body) =>
      evaluate(
        panel,
        `chrome.runtime.sendMessage(${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body })})`,
      );
    const execute = async (command, confirmed = false) =>
      (await panelSend({ type: 'panel.execute', command, confirmed })).result;
    const tabCount = async () => (await panelSend({ type: 'panel.get_state' })).state.tabs.length;

    check(
      'Toolbar icon is set to open the side panel',
      await evaluate(
        panel,
        `chrome.sidePanel.getPanelBehavior().then((behavior) => behavior.openPanelOnActionClick)`,
      ),
    );

    // --- Browser commands, typed into the real side panel ---
    const before = await tabCount();
    await fill(panel, 'textarea', 'new tab');
    await clickButton(panel, 'Send');
    check(
      'Typed “new tab” opens a tab and shows the result',
      (await waitFor(panel, `document.body.innerText.includes('Opened a new tab.')`)) &&
        (await tabCount()) === before + 1,
    );

    const opened = await execute({ action: 'tab.open_url', url: `${webUrl}/api/health?token=abc` });
    const openedTarget = await waitForTarget(
      (target) => target.type === 'page' && target.url.includes('/api/health'),
    );
    check('Opens a specified URL', opened.ok && openedTarget, opened.message);

    for (const url of [
      'chrome://settings',
      'brave://settings',
      `${base}/settings/index.html`,
      'javascript:alert(1)',
      'file:///etc/hosts',
    ]) {
      const blocked = await execute({ action: 'tab.open_url', url });
      check(`Blocks ${url.slice(0, 32)}`, blocked.code === 'blocked_url');
    }

    const list = await execute({ action: 'tab.list' });
    check(
      'Lists tabs by number without the optional permission',
      // Browsers still reveal the extension's own pages, which are marked restricted.
      list.ok &&
        list.tabs.length > 1 &&
        list.tabs.every((tab) => tab.restricted || (!tab.title && !tab.url)),
      list.message,
    );

    const target = list.tabs.at(-1);
    const switched = await execute({ action: 'tab.switch', target: { position: target.position } });
    const nowActive = (await execute({ action: 'tab.list' })).tabs.find(
      (tab) => tab.active && tab.id === target.id,
    );
    check('Switches tabs', switched.ok && nowActive, switched.message);

    const missing = await execute({ action: 'tab.switch', target: { position: 999 } });
    check('Reports a tab that does not exist', missing.code === 'tab_not_found');

    // --- Reload, back and forward, checked against the real page ---
    const nav = await browser.send('Target.attachToTarget', {
      targetId: openedTarget.targetId,
      flatten: true,
    });
    const navPage = { targetId: openedTarget.targetId, sessionId: nav.sessionId };
    await evaluate(navPage, `window.__marker = 'before-reload'`);
    const healthPosition = target.position;
    const reload = await execute({ action: 'tab.reload', target: { position: healthPosition } });
    check(
      'Reloads a tab',
      reload.ok &&
        (await waitFor(
          navPage,
          `window.__marker === undefined && document.readyState === 'complete'`,
        )),
      reload.message,
    );
    const noHistory = await execute({ action: 'tab.back', target: { position: healthPosition } });
    check(
      'Reports when there is no page to go back to',
      noHistory.code === 'no_history',
      noHistory.message,
    );

    // Browser-initiated, because history skips navigations a page makes by itself.
    await browser.send('Page.navigate', { url: `${webUrl}/api/health?second` }, navPage.sessionId);
    await waitFor(navPage, `location.search === '?second' && document.readyState === 'complete'`);
    const back = await execute({ action: 'tab.back', target: { position: healthPosition } });
    check(
      'Goes back',
      back.ok && (await waitFor(navPage, `location.search === '?token=abc'`)),
      back.message,
    );
    const forward = await execute({ action: 'tab.forward', target: { position: healthPosition } });
    check(
      'Goes forward',
      forward.ok && (await waitFor(navPage, `location.search === '?second'`)),
      forward.message,
    );

    // --- Closing from the panel needs confirmation ---
    const countBeforeClose = await tabCount();
    const unconfirmed = await execute({
      action: 'tab.close',
      target: { position: healthPosition },
    });
    check(
      'Closing asks for confirmation first',
      unconfirmed.code === 'confirmation_required' && (await tabCount()) === countBeforeClose,
      unconfirmed.message,
    );
    const confirmed = await execute(
      { action: 'tab.close', target: { position: healthPosition } },
      true,
    );
    check('Closes once confirmed', confirmed.ok && (await tabCount()) === countBeforeClose - 1);

    // --- Groq key, in the real settings page ---
    const settings = await open(`${base}/settings/index.html`);
    await waitFor(settings, `document.querySelector('#groq-key')`);
    await fill(settings, '#groq-key', FAKE_KEY);
    await clickButton(settings, 'Save');
    const masked = await waitFor(
      settings,
      `(() => { const t = document.querySelector('[data-testid=masked-key]')?.textContent; return t?.includes('••') ? t : null; })()`,
    );
    check('Saves a key and shows only a mask', masked === 'gsk_••••••••abcd', masked);
    check(
      'The page no longer holds the key',
      !(await evaluate(
        settings,
        `document.documentElement.outerHTML.includes(${JSON.stringify(FAKE_KEY)}) || document.querySelector('#groq-key').value.length > 0`,
      )),
    );

    const runTest = async () => {
      await clickButton(settings, 'Test connection');
      await sleep(300);
      await waitFor(settings, `!document.body.innerText.includes('Testing…')`);
      return evaluate(settings, `document.querySelector('[data-testid=groq-status]')?.textContent`);
    };

    check('Makes no Groq request before the test', groq.requests.length === 0);

    groq.status = 401;
    const invalid = await runTest();
    check('Shows an invalid or expired key', /invalid or expired/i.test(invalid ?? ''), invalid);

    groq.status = 429;
    groq.headers = [{ name: 'retry-after', value: '30' }];
    const limited = await runTest();
    check('Shows rate limiting', /try again in 30s/i.test(limited ?? ''), limited);
    check(
      'Does not retry a failed test by itself',
      groq.requests.length === 2,
      `${groq.requests.length} requests`,
    );

    groq.status = 200;
    groq.headers = [];
    const working = await runTest();
    check('Shows a working key', working === 'Connected to Groq', working);

    const request = groq.requests.at(-1);
    check(
      'The test is an authenticated, token-free model list',
      request?.method === 'GET' &&
        request.url.endsWith('/models') &&
        (request.headers.Authorization ?? request.headers.authorization) === `Bearer ${FAKE_KEY}`,
      request?.url,
    );

    const options = await evaluate(
      settings,
      `[...document.querySelectorAll('#groq-model option')].map((o) => o.value).filter(Boolean)`,
    );
    check('Lists only active text models', options.join() === 'verify-text-model', options.join());
    await evaluate(
      settings,
      `(() => {
        const el = document.querySelector('#groq-model');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'verify-text-model');
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await sleep(300);
    const afterSelect = (await panelSend({ type: 'panel.get_state' })).state.groq;
    check('Saves the chosen model', afterSelect.selectedModel === 'verify-text-model');
    await screenshot(settings, `${name}-extension-settings`, { width: 480, height: 820 });

    // --- Website ---
    const webRunning = await fetch(`${webUrl}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!webRunning) {
      check(`Website is running at ${webUrl}`, false);
    } else {
      const web = await open(webUrl);
      check(
        'Website shows the extension as connected',
        await waitFor(web, `document.body.innerText.includes('Extension connected')`),
      );
      check(
        'Website shows Groq status',
        await waitFor(web, `document.body.innerText.includes('Groq connected')`),
      );

      const externalSend = (body) =>
        evaluate(
          web,
          `chrome.runtime.sendMessage(${JSON.stringify(id)}, ${JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            requestId: crypto.randomUUID(),
            ...body,
          })})`,
        );

      const stateText = JSON.stringify(await externalSend({ type: 'external.get_state' }));
      check(
        'Bridge state contains only the masked key',
        stateText.includes('gsk_••••••••abcd') && !stateText.includes(FAKE_KEY),
      );

      await clickButton(web, 'Open settings');
      await waitFor(
        web,
        `document.querySelector('[data-testid=web-masked-key]')?.checkVisibility()`,
      );
      const webHtml = await evaluate(web, `document.documentElement.outerHTML`);
      const webStorage = await evaluate(
        web,
        `JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie`,
      );
      check(
        'Website never receives the key',
        !webHtml.includes(FAKE_KEY) && !webStorage.includes(FAKE_KEY),
      );
      await screenshot(web, `${name}-website-settings`, { width: 1280, height: 820 });

      const settingsTabsBefore = (await browser.send('Target.getTargets')).targetInfos.filter((t) =>
        t.url.includes('settings/index.html'),
      ).length;
      await clickButton(web, 'Manage key in extension');
      await sleep(600);
      const settingsTabsAfter = (await browser.send('Target.getTargets')).targetInfos.filter((t) =>
        t.url.includes('settings/index.html'),
      ).length;
      check(
        'Website can open extension settings',
        settingsTabsAfter >= settingsTabsBefore && settingsTabsAfter > 0,
      );
      await clickButton(web, 'Close settings');

      for (const [label, message] of [
        ['Rejects an unknown message', { type: 'external.run_script', code: 'alert(1)' }],
        [
          'Rejects an unknown command',
          { type: 'external.command', command: { action: 'tab.execute', code: 'x' } },
        ],
        [
          'Rejects website self-confirmation',
          { type: 'external.command', command: { action: 'tab.close', confirmed: true } },
        ],
        [
          'Rejects internal panel messages',
          { type: 'panel.decide_confirmation', id: crypto.randomUUID(), approved: true },
        ],
        ['Rejects sending a key over the bridge', { type: 'external.ping', apiKey: FAKE_KEY }],
      ]) {
        const reply = await externalSend(message);
        check(`Bridge: ${label}`, reply?.reason === 'invalid_message');
      }

      const blockedFromWeb = await externalSend({
        type: 'external.command',
        command: { action: 'tab.open_url', url: 'chrome://settings' },
      });
      check(
        'Bridge: Blocks internal pages from the website',
        blockedFromWeb?.result?.code === 'blocked_url',
      );

      await fill(web, 'textarea', 'new tab');
      await clickButton(web, 'Send');
      check(
        'Website command opens a tab and shows the result',
        await waitFor(web, `document.body.innerText.includes('Opened a new tab.')`),
      );
      await screenshot(web, `${name}-website`, { width: 1280, height: 820 });

      // --- Closing from the website must be confirmed in an extension window ---
      const decide = async (buttonLabel) => {
        const before = await tabCount();
        await fill(web, 'textarea', 'close tab');
        await clickButton(web, 'Send');
        const popup = await waitForTarget(
          (t) => t.type === 'page' && t.url.includes('confirm/index.html'),
        );
        if (!popup) return { popup: false };
        const { sessionId } = await browser.send('Target.attachToTarget', {
          targetId: popup.targetId,
          flatten: true,
        });
        const page = { targetId: popup.targetId, sessionId };
        const prompt = await waitFor(
          page,
          `document.querySelector('[data-testid=confirm-prompt]')?.textContent`,
        );
        const unchanged = (await tabCount()) === before;
        if (buttonLabel === 'Close tab') await screenshot(page, `${name}-confirm`);
        await clickButton(page, buttonLabel);
        await sleep(800);
        return { popup: true, prompt, unchanged, delta: (await tabCount()) - before };
      };

      const declined = await decide('Keep open');
      check(
        'Website close opens an extension confirmation',
        declined.popup && declined.prompt,
        declined.prompt,
      );
      check('Nothing closes before the answer', declined.unchanged);
      check('Declining keeps the tab', declined.delta === 0);
      check(
        'Website shows the decline',
        await waitFor(web, `document.body.innerText.includes('You chose not to do this.')`),
      );

      const approved = await decide('Close tab');
      check('Approving closes the tab', approved.delta === -1);

      const webStillOpen = (await browser.send('Target.getTargets')).targetInfos.some(
        (t) => t.targetId === web.targetId,
      );
      check('The website never closes itself by accident', webStillOpen);

      const log = (await panelSend({ type: 'panel.get_state' })).state.recentActions;
      check(
        'Recent actions record real outcomes from both surfaces',
        log.some((entry) => entry.source === 'website' && entry.ok) &&
          log.some((entry) => entry.source === 'panel' && !entry.ok) &&
          !JSON.stringify(log).includes('token=abc'),
        `${log.length} entries`,
      );

      const other = await open(webUrl.replace('localhost', '127.0.0.1'));
      await sleep(600);
      const otherApi = await evaluate(other, `typeof globalThis.chrome?.runtime?.sendMessage`);
      check('Other origins get no messaging API', otherApi === 'undefined', otherApi);
      await browser.send('Target.closeTarget', { targetId: other.targetId });

      const mobile = await open(webUrl);
      await waitFor(mobile, `document.body.innerText.includes('Extension connected')`);
      if (screenshotDir) {
        await screenshot(mobile, `${name}-website-mobile`, { width: 390, height: 800 });
        await evaluate(mobile, `document.documentElement.dataset.theme = 'dark'`);
        await screenshot(mobile, `${name}-website-mobile-dark`, { width: 390, height: 800 });
        await evaluate(mobile, `delete document.documentElement.dataset.theme`);
      }
      await browser.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 390, height: 800, deviceScaleFactor: 1, mobile: false },
        mobile.sessionId,
      );
      await sleep(300);
      const overflow = await evaluate(mobile, `document.documentElement.scrollWidth > innerWidth`);
      check('Website has no sideways scroll', !overflow);

      await browser.send('Page.bringToFront', {}, web.sessionId);
      if (screenshotDir) {
        await screenshot(panel, `${name}-panel`, { width: 380, height: 760 });
        await evaluate(panel, `document.documentElement.dataset.theme = 'dark'`);
        await screenshot(panel, `${name}-panel-dark`, { width: 380, height: 760 });
        await evaluate(panel, `delete document.documentElement.dataset.theme`);
        await evaluate(web, `document.documentElement.dataset.theme = 'dark'`);
        await screenshot(web, `${name}-website-dark`, { width: 1280, height: 820 });
        await evaluate(web, `document.documentElement.dataset.theme = 'light'`);
        await screenshot(web, `${name}-website-light`, { width: 1280, height: 820 });
        await evaluate(panel, `document.documentElement.dataset.theme = 'light'`);
        await screenshot(panel, `${name}-panel-light`, { width: 380, height: 760 });
        await evaluate(panel, `delete document.documentElement.dataset.theme`);
        await evaluate(web, `delete document.documentElement.dataset.theme`);
      }
    }

    // --- Removing the key ---
    await browser.send('Page.bringToFront', {}, settings.sessionId);
    await clickButton(settings, 'Remove');
    await clickButton(settings, 'Confirm remove');
    await waitFor(
      settings,
      `document.querySelector('[data-testid=masked-key]')?.textContent === 'No key saved'`,
    );
    const remaining = await evaluate(
      settings,
      `chrome.storage.local.get(null).then((all) => JSON.stringify(all))`,
    );
    check('Removing deletes the key and what was learned about it', remaining === '{}', remaining);

    // --- The real side panel, opened as if by a toolbar click ---
    const opensPanel = await evaluate(
      panel,
      `chrome.windows.getLastFocused().then((win) => chrome.sidePanel.open({ windowId: win.id })).then(() => true)`,
      { userGesture: true },
    ).catch((error) => error.message);
    check(
      'Side panel API opens the panel',
      opensPanel === true,
      opensPanel === true ? '' : opensPanel,
    );
  } catch (error) {
    check('Verification completed', false, error.message);
  } finally {
    await browser.close();
  }
  return allPassed();
}

/**
 * The "tabs" permission can only be granted through a browser dialog, so this loads a
 * copy of the build that has it from the start, to cover what the permission unlocks.
 */
async function verifyTabDetails(name, executable) {
  const copy = mkdtempSync(join(tmpdir(), 'dopilot-verify-copy-'));
  cpSync(extensionPath, copy, { recursive: true });
  const manifestPath = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions.push('tabs');
  delete manifest.optional_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const browser = launch(executable);
  const { open, evaluate, waitFor, screenshot } = createPageTools(browser);
  const { check, allPassed } = createChecks();

  try {
    console.log(`\n${name}, with tab details allowed:`);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: copy });
    await sleep(500);
    const panel = await open(`chrome-extension://${id}/sidepanel/index.html`);
    await waitFor(panel, `document.body.innerText.includes('No Groq key')`);
    const execute = async (command, confirmed = false) =>
      (
        await evaluate(
          panel,
          `chrome.runtime.sendMessage(${JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            type: 'panel.execute',
            command,
            confirmed,
          })})`,
        )
      ).result;

    const web = await open(`${webUrl}/api/health?token=secret-value#frag`);
    await waitFor(web, `document.readyState === 'complete'`);
    const internal = await browser.send('Target.createTarget', { url: 'chrome://version' });
    await sleep(800);

    const { tabs } = await execute({ action: 'tab.list' });
    const health = tabs.find((tab) => tab.url?.includes('/api/health'));
    check('Shows titles and addresses', Boolean(health?.url), health?.url);
    check(
      'Removes query strings and fragments',
      health?.url && !JSON.stringify(tabs).includes('secret-value'),
    );

    const restricted = tabs.find((tab) => tab.restricted && tab.title !== 'Dopilot');
    check(
      'Marks internal pages as restricted, with no address',
      restricted && !restricted.url,
      restricted?.title,
    );
    for (const action of ['tab.reload', 'tab.back', 'tab.close', 'tab.switch']) {
      const result = await execute({ action, target: { tabId: restricted.id } }, true);
      check(`Blocks ${action} on internal pages`, result.code === 'restricted_page');
    }
    const stillThere = (await browser.send('Target.getTargets')).targetInfos.some(
      (t) => t.targetId === internal.targetId,
    );
    check('The internal page was not touched', stillThere);

    await waitFor(panel, `document.body.innerText.length > 0`);
    await screenshot(panel, `${name}-panel-tab-details`, { width: 380, height: 760 });

    const webPage = await open(webUrl);
    const shown = await waitFor(
      webPage,
      `(() => { const t = document.body.textContent; return t.includes('Extension connected') && t.includes('Open tabs (') ? t : null; })()`,
    );
    check('Website lists tabs with details', shown?.includes('localhost:3000'));
    await waitFor(webPage, `document.fonts.ready.then(() => true)`);
    await screenshot(webPage, `${name}-website-tab-details`, { width: 1280, height: 820 });
  } catch (error) {
    check('Verification completed', false, error.message);
  } finally {
    await browser.close();
    rmSync(copy, { recursive: true, force: true });
  }
  return allPassed();
}

if (!existsSync(join(extensionPath, 'manifest.json'))) {
  console.error('Build first: pnpm build');
  process.exit(1);
}

let ok = true;
for (const [name, executable] of Object.entries(browsers)) {
  if (process.env.VERIFY_BROWSER && process.env.VERIFY_BROWSER !== name) continue;
  if (!existsSync(executable)) {
    console.log(`\n${name}: not installed, skipped`);
    continue;
  }
  ok = (await verifyProduct(name, executable)) && ok;
  ok = (await verifyTabDetails(name, executable)) && ok;
}
process.exit(ok ? 0 : 1);
