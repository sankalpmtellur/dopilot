#!/usr/bin/env node
// Loads the built extension into Chrome and Brave, using throwaway profiles in
// headless mode, and checks it over the DevTools protocol. Never touches real
// profiles. Start the web app first to include the page-to-extension checks.
//
//   pnpm --filter @dopilot/extension build && pnpm verify:extension
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const extensionPath = resolve(import.meta.dirname, '../apps/extension/dist');
const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
const browsers = {
  Chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  Brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};

function launch(executable) {
  const profile = mkdtempSync(join(tmpdir(), 'dopilot-verify-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );

  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdio[4].setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
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
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject });
      });
    },
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function evaluate(browser, url, expression) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1500);
  const { result, exceptionDetails } = await browser.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  await browser.send('Target.closeTarget', { targetId });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
  return result.value;
}

async function isWebRunning() {
  try {
    return (await fetch(`${webUrl}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function verify(name, executable) {
  const browser = launch(executable);
  const results = [];
  const check = (label, passed, detail = '') => {
    results.push(passed);
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  };

  try {
    const version = (await browser.send('Browser.getVersion')).product;
    console.log(`\n${name}: ${version}`);

    const { id } = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
    check('Loads as an unpacked extension', Boolean(id), id);

    await sleep(1000);
    const { targetInfos } = await browser.send('Target.getTargets');
    const worker = targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.includes(id),
    );
    check('Service worker starts', Boolean(worker));

    const panel = await evaluate(
      browser,
      `chrome-extension://${id}/sidepanel/index.html`,
      `document.querySelector('[role=status]')?.textContent`,
    );
    check(
      'Side panel renders and reaches the worker',
      panel === 'No Groq API key saved yet.',
      panel,
    );

    const opensOnClick = await evaluate(
      browser,
      `chrome-extension://${id}/sidepanel/index.html`,
      `chrome.sidePanel.getPanelBehavior().then((behavior) => behavior.openPanelOnActionClick)`,
    );
    check('Toolbar icon is set to open the side panel', opensOnClick === true);

    if (await isWebRunning()) {
      const ping = JSON.stringify({ protocolVersion: 1, type: 'external.ping' });
      const pong = await evaluate(
        browser,
        webUrl,
        `chrome.runtime.sendMessage(${JSON.stringify(id)}, ${ping})`,
      );
      check('Allowed web origin gets a pong', pong?.type === 'external.pong', pong?.type);

      const status = await evaluate(
        browser,
        webUrl,
        `document.querySelector('[data-testid=extension-status]')?.textContent`,
      );
      if (status === 'Extension ID not configured') {
        console.log('  SKIP  Website status (NEXT_PUBLIC_DOPILOT_EXTENSION_ID is not set)');
      } else {
        check('Website reports a connection', status?.startsWith('Extension connected'), status);
      }

      const privileged = await evaluate(
        browser,
        webUrl,
        `chrome.runtime.sendMessage(${JSON.stringify(id)}, { protocolVersion: 1, type: 'external.click' })`,
      );
      check('Privileged message is rejected', privileged?.reason === 'invalid_message');

      const other = await evaluate(
        browser,
        webUrl.replace('localhost', '127.0.0.1'),
        `typeof globalThis.chrome?.runtime?.sendMessage`,
      );
      check('Other origins get no messaging API', other === 'undefined', other);
    } else {
      console.log(`  SKIP  Page-to-extension checks (nothing running at ${webUrl})`);
    }
  } catch (error) {
    check('Verification completed', false, error.message);
  } finally {
    await browser.close();
  }
  return results.every(Boolean);
}

if (!existsSync(join(extensionPath, 'manifest.json'))) {
  console.error('Build the extension first: pnpm --filter @dopilot/extension build');
  process.exit(1);
}

let ok = true;
for (const [name, executable] of Object.entries(browsers)) {
  if (!existsSync(executable)) {
    console.log(`\n${name}: not installed, skipped`);
    continue;
  }
  ok = (await verify(name, executable)) && ok;
}
process.exit(ok ? 0 : 1);
