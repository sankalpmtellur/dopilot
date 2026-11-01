import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let screenshotDir;
export function setScreenshotDir(dir) {
  screenshotDir = dir;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * `blockNetwork` routes everything except local addresses to a closed port, so nothing
 * in a run can reach the internet, even if interception were to miss a request.
 */
export function launch(executable, { blockNetwork = false, fakeMic = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'dopilot-verify-'));
  const child = spawn(
    executable,
    [
      ...(process.env.VERIFY_HEADED ? [] : ['--headless=new']),
      ...(blockNetwork ? ['--proxy-server=127.0.0.1:9'] : []),
      // A real microphone pipeline with a synthetic device, and no permission dialog.
      ...(fakeMic ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
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

export function createPageTools(browser) {
  async function open(url) {
    const { targetId } = await browser.send('Target.createTarget', { url });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }

  async function evaluate(page, expression, options = {}) {
    const run = () =>
      browser.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, ...options },
        page.sessionId,
      );
    let reply;
    try {
      reply = await run();
    } catch (error) {
      // Browsers can move a new page to another process, which ends the debugging session.
      if (!/session/i.test(error.message) || !page.targetId) throw error;
      const attached = await browser.send('Target.attachToTarget', {
        targetId: page.targetId,
        flatten: true,
      });
      page.sessionId = attached.sessionId;
      reply = await run();
    }
    const { result, exceptionDetails } = reply;
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

  const clickButton = (page, label, options = {}) =>
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
      options,
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

export function createChecks() {
  const results = [];
  return {
    check(label, passed, detail = '') {
      results.push(Boolean(passed));
      console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
    },
    allPassed: () => results.every(Boolean),
  };
}
