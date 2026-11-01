#!/usr/bin/env node
// Runs the real release ZIP against the real production website build, over HTTPS, in Chrome
// and Brave with throwaway profiles. A local certificate stands in for the public one, and every
// address resolves to this machine, so nothing here reaches the internet, Groq or Vercel.
//
//   DOPILOT_WEB_ORIGIN=https://dopilot.vercel.app DOPILOT_KEEP_KEY=1 pnpm release:extension
//   pnpm --filter @dopilot/web build
//   DOPILOT_WEB_ORIGIN=https://dopilot.vercel.app pnpm verify:production
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '../packages/shared/dist/index.js';
import { createChecks, createPageTools, launch, sleep } from './lib/browser.mjs';

const root = resolve(import.meta.dirname, '..');
const origin = process.env.DOPILOT_WEB_ORIGIN;
if (!origin) {
  console.error('Set DOPILOT_WEB_ORIGIN to the origin the ZIP was built for.');
  process.exit(1);
}
const WEB_PORT = 3107;
const TLS_PORT = 3443;
const FIXTURE_PORT = 3108;
const FAKE_KEY = 'gsk_verifyOnlyNotARealKey000000000000abcd';
const browsers = {
  Chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  Brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};

const work = mkdtempSync(join(tmpdir(), 'dopilot-production-'));
const { version } = JSON.parse(
  readFileSync(join(root, 'apps/extension/public/manifest.json'), 'utf8'),
);
const zip = join(root, `release/dopilot-${version}.zip`);
const unpacked = join(work, 'extension');
execFileSync('unzip', ['-q', zip, '-d', unpacked]);

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const allText = (dir) =>
  files(dir)
    .filter(
      (file) => /\.(js|html|css|json)$/.test(file) && !file.endsWith('THIRD_PARTY_NOTICES.txt'),
    )
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=dopilot-verify',
    '-keyout',
    join(work, 'key.pem'),
    '-out',
    join(work, 'cert.pem'),
  ],
  { stdio: 'ignore' },
);

// The production server, exactly as `next start` serves it.
const web = spawn('pnpm', ['exec', 'next', 'start', '--port', String(WEB_PORT)], {
  cwd: join(root, 'apps/web'),
  stdio: 'ignore',
  detached: true,
});

/** Stands in for the public HTTPS front: real TLS to the browser, `next start` behind it. */
const tls = createHttpsServer(
  { key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) },
  (incoming, outgoing) => {
    const host = (incoming.headers.host ?? '').split(':')[0];
    if (`https://${host}` !== origin) {
      outgoing.setHeader('content-type', 'text/html');
      outgoing.end(`<!doctype html><title>${host}</title><h1>${host}</h1>`);
      return;
    }
    const proxied = httpRequest(
      { port: WEB_PORT, path: incoming.url, method: incoming.method, headers: incoming.headers },
      (reply) => {
        outgoing.writeHead(reply.statusCode ?? 500, reply.headers);
        reply.pipe(outgoing);
      },
    );
    proxied.on('error', () => outgoing.destroy());
    incoming.pipe(proxied);
  },
);
tls.listen(TLS_PORT, '127.0.0.1');

const fixture = createHttpServer((_incoming, outgoing) => {
  outgoing.setHeader('content-type', 'text/html');
  outgoing.end('<!doctype html><title>Fixture</title><h1>Fixture page</h1>');
});
fixture.listen(FIXTURE_PORT, '127.0.0.1');

let ok = true;

async function fetchWhenUp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const reply = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`).catch(() => null);
    if (reply?.ok) return true;
    await sleep(500);
  }
  return false;
}

async function verify(name, executable) {
  const browser = launch(executable, {
    extraArgs: [
      `--host-resolver-rules=MAP * 127.0.0.1:${TLS_PORT}, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
      '--ignore-certificate-errors',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  const { open, evaluate, waitFor, waitForTarget } = createPageTools(browser);
  const { check, allPassed } = createChecks();
  try {
    console.log(`\n${name}: release ZIP against the production website`);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: unpacked });
    check('The unzipped release loads as Manifest V3', Boolean(id), id);
    const worker = await waitForTarget(
      (target) => target.type === 'service_worker' && target.url.includes(id),
    );
    check('Its service worker starts', Boolean(worker));

    const panel = await open(`chrome-extension://${id}/sidepanel/index.html`);
    await waitFor(panel, `document.body.innerText.includes('Dopilot')`);
    check('The side panel renders under the production security policy', true);
    await evaluate(panel, `chrome.storage.local.set({ groqApiKey: ${JSON.stringify(FAKE_KEY)} })`);

    const settings = await open(`chrome-extension://${id}/settings/index.html`);
    await waitFor(settings, `document.body.innerText.includes('Groq')`);
    check(
      'The MCP developer section is gone from settings',
      !(await evaluate(settings, 'document.body.innerText')).includes('MCP'),
    );
    const blocked = await evaluate(
      panel,
      `fetch('http://127.0.0.1:4319/').then(() => false, () => true)`,
    );
    check('The security policy blocks the local MCP address', blocked === true);

    const site = await open(`${origin}/`);
    const connected = await waitFor(
      site,
      `document.body.innerText.includes('Extension connected')`,
      15000,
    );
    check('The website finds the extension over HTTPS', Boolean(connected), origin);
    check(
      'It is a secure context, as microphone access needs',
      (await evaluate(site, 'window.isSecureContext && Boolean(navigator.mediaDevices)')) === true,
    );
    const stateText = await evaluate(
      site,
      `chrome.runtime.sendMessage(${JSON.stringify(id)}, ${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: '00000000-0000-4000-8000-000000000001',
        type: 'external.get_state',
      })}).then(JSON.stringify)`,
    );
    check(
      'The website sees that a key exists, and no part of it',
      stateText.includes('"configured":true') &&
        !stateText.includes(FAKE_KEY) &&
        !stateText.includes('abcd'),
    );

    // A real instruction typed on the production website, with no AI involved.
    await evaluate(
      site,
      `(() => {
        const box = document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Open a new tab and go to fixture.example');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    );
    await sleep(200);
    await evaluate(
      site,
      `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Send').click()`,
    );
    const opened = await waitForTarget(
      (target) => target.type === 'page' && target.url.includes('fixture.example'),
      10000,
    );
    check('A task started from the website runs in the browser', Boolean(opened));
    // The website pauses while hidden, and catches up when the user comes back to it.
    await browser.send('Page.bringToFront', {}, site.sessionId);
    await evaluate(site, `window.dispatchEvent(new Event('focus'))`);
    check(
      'The website reports the result',
      await waitFor(site, `document.body.innerText.includes('Opened')`, 10000),
    );

    // Everything that is not the production origin.
    const evil = await open('https://evil.example/');
    await waitFor(evil, `document.title === 'evil.example'`);
    check(
      'Another HTTPS site cannot reach the extension',
      (await evaluate(
        evil,
        `(async () => {
          if (!globalThis.chrome?.runtime?.sendMessage) return 'no api';
          return chrome.runtime.sendMessage(${JSON.stringify(id)}, { type: 'external.ping' }).then(() => 'reached', () => 'refused');
        })()`,
      )) !== 'reached',
    );
    const local = await open(`http://localhost:${WEB_PORT}/`);
    await sleep(1500);
    check(
      'The development address cannot reach the extension',
      (await evaluate(local, 'Boolean(globalThis.chrome?.runtime?.sendMessage)')) === false,
    );
    check(
      'The same website on that address reports no connection',
      await waitFor(local, `document.body.innerText.includes('not connected')`, 10000),
    );
    const localText = await evaluate(local, 'document.body.innerText');
    check(
      'Visitors without the extension get install steps, not developer commands',
      !/pnpm build|apps\/extension\/dist/.test(localText) && /Load unpacked/.test(localText),
    );
    const headers = await fetch(`http://127.0.0.1:${WEB_PORT}/`).then((reply) => reply.headers);
    check(
      'The website cannot be framed, and keeps its other security headers',
      headers.get('x-frame-options') === 'DENY' &&
        headers.get('x-content-type-options') === 'nosniff' &&
        /microphone=\(self\)/.test(headers.get('permissions-policy') ?? '') &&
        !headers.get('x-powered-by'),
    );
  } catch (error) {
    check('Verification completed', false, error.message);
  } finally {
    await browser.close();
  }
  return allPassed();
}

try {
  const { check, allPassed } = createChecks();
  console.log(`Release package: ${zip}`);
  const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'));
  check('manifest.json is at the top of the ZIP', manifest.manifest_version === 3);
  check(
    'It names only the production origin',
    JSON.stringify(manifest.externally_connectable.matches) === JSON.stringify([`${origin}/*`]),
  );
  check(
    'Its icons exist',
    ['16', '48', '128'].every((size) => existsSync(join(unpacked, manifest.icons[size]))),
  );
  check(
    'Every page and script it names exists',
    [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      manifest.options_ui.page,
      'content.js',
      'confirm/index.html',
    ].every((path) => existsSync(join(unpacked, path))),
  );
  check(
    'Third-party notices are included',
    readFileSync(join(unpacked, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('groq-sdk'),
  );
  const extensionText = allText(unpacked);
  const webText = allText(join(root, 'apps/web/.next/static'));
  check('The extension holds no key', !/gsk_[A-Za-z0-9]{20,}/.test(extensionText));
  check('The website holds no key', !/gsk_[A-Za-z0-9]{20,}/.test(webText));
  check(
    'The extension holds no development origin',
    !/localhost:3000|127\.0\.0\.1:4319/.test(extensionText),
    /127\.0\.0\.1:4319/.test(extensionText) ? 'MCP address present' : '',
  );
  check('No source maps in the extension', !files(unpacked).some((file) => file.endsWith('.map')));
  check(
    'The website was built with the extension ID',
    webText.includes(manifest.key ? 'doennedjpkdlajeeplfioihckoffjeld' : ''),
  );
  ok = allPassed() && ok;

  if (!(await fetchWhenUp())) {
    console.log('  FAIL  The production website did not start. Build it first.');
    ok = false;
  } else {
    for (const [name, executable] of Object.entries(browsers)) {
      if (process.env.VERIFY_BROWSER && process.env.VERIFY_BROWSER !== name) continue;
      if (existsSync(executable)) ok = (await verify(name, executable)) && ok;
    }
  }
} finally {
  tls.close();
  fixture.close();
  try {
    process.kill(-web.pid);
  } catch {
    // Already gone.
  }
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
