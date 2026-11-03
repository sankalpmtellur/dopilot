#!/usr/bin/env node
// Checks the extension-only release ZIP, the one meant for a store: what is inside it, then the
// unzipped package itself in real Chrome and Brave with throwaway profiles. All non-local
// network is blocked, so nothing here reaches Groq or uses any quota.
//
//   pnpm release:extension
//   pnpm verify:package
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '../packages/shared/dist/index.js';
import { createChecks, createPageTools, launch, sleep } from './lib/browser.mjs';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(
  readFileSync(join(root, 'apps/extension/public/manifest.json'), 'utf8'),
);
const zip = join(root, `release/dopilot-${version}.zip`);
if (!existsSync(zip)) {
  console.error(`No package at ${zip}. Run pnpm release:extension first.`);
  process.exit(1);
}

const browsers = {
  Chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  Brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};
const FAKE_KEY = 'gsk_verifyOnlyNotARealKey000000000000abcd';
/** Everything a package may contain. Anything else is a mistake, however harmless it looks. */
const ALLOWED =
  /^(manifest\.json|THIRD_PARTY_NOTICES\.txt|(background|content|sidepanel|settings|confirm)\.js|(sidepanel|settings|confirm)\/index\.html|assets\/[\w-]+\.(js|css)|icons\/(16|48|128)\.png)$/;
const REQUIRED_PERMISSIONS = ['activeTab', 'alarms', 'scripting', 'sidePanel', 'storage'];

const work = mkdtempSync(join(tmpdir(), 'dopilot-package-'));
const unpacked = join(work, 'extension');
execFileSync('unzip', ['-q', zip, '-d', unpacked]);
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const names = files(unpacked).map((file) => relative(unpacked, file));
const text = (pattern) =>
  files(unpacked)
    .filter((file) => pattern.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

function verifyContents() {
  const { check, allPassed } = createChecks();
  const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'));
  const code = text(/\.(js|html|css|json)$/);
  const unexpected = names.filter((name) => !ALLOWED.test(name));
  console.log(`\nPackage: ${zip} (${Math.round(statSync(zip).size / 1024)} KB)`);
  check('Holds only expected files', unexpected.length === 0, unexpected.join(', '));
  check('Is Manifest V3, with manifest.json at the top', manifest.manifest_version === 3);
  check('Its version matches the source', manifest.version === version, manifest.version);
  check('Has no key, which stores refuse', !manifest.key);
  check('Trusts no website', !manifest.externally_connectable);
  check(
    'Asks for nothing new at install',
    JSON.stringify(manifest.permissions) === JSON.stringify(REQUIRED_PERMISSIONS) &&
      JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://api.groq.com/*']),
  );
  check(
    'Connects only to Groq',
    manifest.content_security_policy.extension_pages ===
      "script-src 'self'; object-src 'self'; connect-src https://api.groq.com",
    manifest.content_security_policy.extension_pages,
  );
  check(
    'Names only files that exist',
    [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      manifest.options_ui.page,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
      'content.js',
      'confirm/index.html',
    ].every((path) => existsSync(join(unpacked, path))),
  );
  check('Holds nothing like a key', !/gsk_[A-Za-z0-9]{20,}/.test(code));
  check('Holds no development address', !/localhost:3000|127\.0\.0\.1:4319/.test(code));
  check('Holds no source maps', !names.some((name) => name.endsWith('.map')));
  check('Has no eval or new Function', !/\beval\(|new Function\b/.test(text(/\.js$/)));
  const scripts = [...text(/\.html$/).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  check(
    'Loads no remote code',
    scripts.length > 0 && scripts.every((src) => !/^(https?:)?\/\//.test(src)),
    scripts.join(', '),
  );
  check(
    'Includes the third-party notices',
    readFileSync(join(unpacked, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('groq-sdk'),
  );
  return allPassed();
}

async function verifyInBrowser(name, executable, port) {
  const browser = launch(executable, { blockNetwork: true });
  const { open, evaluate, waitFor, waitForTarget, clickButton, fill } = createPageTools(browser);
  const { check, allPassed } = createChecks();
  try {
    const product = (await browser.send('Browser.getVersion')).product;
    console.log(`\n${name}: ${product}`);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: unpacked });
    check('Loads from the ZIP', Boolean(id), id);
    const worker = await waitForTarget(
      (target) => target.type === 'service_worker' && target.url.includes(id),
    );
    check('Its service worker starts', Boolean(worker));

    const site = await open(`http://127.0.0.1:${port}/`);
    await browser.send('Target.activateTarget', { targetId: site.targetId });
    check(
      'A website gets no way to message it',
      (await evaluate(site, `typeof globalThis.chrome?.runtime?.sendMessage`)) === 'undefined',
    );

    const helper = await open(`chrome-extension://${id}/settings/index.html`);
    await browser.send('Target.activateTarget', { targetId: site.targetId });
    await sleep(300);
    const opened = await evaluate(
      helper,
      `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.open({ windowId: w.id })).then(() => true, (e) => e.message)`,
      { userGesture: true },
    );
    const target = await waitForTarget((t) => t.url.includes('sidepanel/index.html'), 8000);
    check('The docked side panel opens', opened === true && Boolean(target), String(opened));
    const attached = await browser.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const panel = { targetId: target.targetId, sessionId: attached.sessionId };
    check(
      'It starts with setup and examples, needing no website',
      await waitFor(
        panel,
        `document.body.innerText.includes('Welcome to Dopilot') && document.body.innerText.includes('Try one of these')`,
      ),
    );

    for (const theme of ['light', 'dark']) {
      await evaluate(panel, `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      for (const width of [280, 360, 480, 700]) {
        await browser.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height: 720, deviceScaleFactor: 1, mobile: false },
          panel.sessionId,
        );
        await sleep(120);
        const overflow = await evaluate(
          panel,
          `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
        );
        check(`No sideways scroll at ${width}px, ${theme}`, overflow <= 0, `${overflow}px`);
      }
    }
    await browser.send('Emulation.clearDeviceMetricsOverride', {}, panel.sessionId);
    await evaluate(panel, `delete document.documentElement.dataset.theme`);

    const send = (body) =>
      evaluate(
        panel,
        `chrome.runtime.sendMessage(${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body })})`,
      );
    const state = async () => (await send({ type: 'panel.get_state' })).state;

    const before = (await state()).tabs.length;
    await fill(panel, 'textarea', 'Open 5 new tabs');
    await clickButton(panel, 'Send');
    check(
      'Runs a command in the docked panel, with no key',
      await waitFor(panel, `document.body.innerText.includes('Opened 5 of 5 new tabs')`),
    );
    check('It really opened 5 tabs', (await state()).tabs.length === before + 5);

    await evaluate(panel, `chrome.storage.local.set({ groqApiKey: ${JSON.stringify(FAKE_KEY)} })`);
    const groq = await send({ type: 'panel.test_groq' });
    check(
      'A key test with no network says so, honestly',
      groq.groq.connection.state === 'network_error',
      groq.groq.connection.state,
    );
    await evaluate(panel, `chrome.storage.local.remove('groqApiKey')`);

    // Older browsers cannot close it from code, so this only runs where they can.
    if ((await evaluate(helper, `typeof chrome.sidePanel.close`)) === 'function') {
      await evaluate(
        helper,
        `chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`,
      );
      await sleep(500);
      const { targetInfos } = await browser.send('Target.getTargets');
      check(
        'The docked side panel closes',
        !targetInfos.some((t) => t.url.includes('sidepanel/index.html')),
      );
    }
  } catch (error) {
    check('Verification completed', false, error.message);
  } finally {
    await browser.close();
  }
  return allPassed();
}

const fixture = createServer((_incoming, outgoing) => {
  outgoing.setHeader('content-type', 'text/html');
  outgoing.end('<!doctype html><title>Fixture</title><h1>Fixture page</h1>');
});
await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
const { port } = fixture.address();

let ok = verifyContents();
for (const [name, executable] of Object.entries(browsers)) {
  if (process.env.VERIFY_BROWSER && process.env.VERIFY_BROWSER !== name) continue;
  if (!existsSync(executable)) {
    console.log(`\n${name}: not installed, skipped`);
    continue;
  }
  ok = (await verifyInBrowser(name, executable, port)) && ok;
}
fixture.close();
rmSync(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
