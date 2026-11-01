#!/usr/bin/env node
// Builds the extension for public distribution, proves the result is fit to publish, and
// zips it for a store upload. It deploys nothing and uploads nothing.
//
//   DOPILOT_WEB_ORIGIN=https://your.domain DOPILOT_KEEP_KEY=1 pnpm release:extension
//
// DOPILOT_KEEP_KEY=1 keeps the pinned key, which manual installs need: without it, each
// install's ID depends on its folder, and the website could not find it. Leave it out for a
// store upload, which refuses keys. DOPILOT_MCP=1 keeps the local MCP bridge. Neither is
// for ordinary use beyond that.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'apps/extension/dist');
const env = { ...process.env, DOPILOT_CHANNEL: 'production' };
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });

run('node', ['scripts/third-party-notices.mjs']);
run('pnpm', ['build:packages']);
run('pnpm', ['--filter', '@dopilot/extension', 'build']);

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const problems = [];
const origin = process.env.DOPILOT_WEB_ORIGIN;

if (
  JSON.stringify(manifest.externally_connectable) !== JSON.stringify({ matches: [`${origin}/*`] })
) {
  problems.push('externally_connectable must name exactly the production website.');
}
if (manifest.key && process.env.DOPILOT_KEEP_KEY !== '1') problems.push('The manifest has a key.');
if (
  !process.env.DOPILOT_MCP &&
  manifest.content_security_policy.extension_pages.includes('127.0.0.1')
) {
  problems.push('The security policy still allows the local MCP bridge.');
}
for (const size of ['16', '48', '128']) {
  if (!manifest.icons?.[size]) problems.push(`There is no ${size}px icon.`);
}
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['https://api.groq.com/*'])) {
  problems.push('Host permissions beyond Groq must stay optional.');
}

for (const file of files(dist)) {
  const name = file.slice(dist.length + 1);
  if (name.endsWith('.map')) problems.push(`Source map in the build: ${name}`);
  if (/ \d+\.|\.pem$|\.env/.test(name)) problems.push(`Stray file in the build: ${name}`);
  if (!/\.(js|html|css|json)$/.test(name)) continue;
  const text = readFileSync(file, 'utf8');
  if (/gsk_[A-Za-z0-9]{20,}/.test(text)) problems.push(`Something like a Groq key in ${name}`);
  if (/localhost:3000/.test(text)) problems.push(`A development origin in ${name}`);
}

if (!statSync(join(dist, 'THIRD_PARTY_NOTICES.txt'), { throwIfNoEntry: false })) {
  problems.push('The third-party notices are missing.');
}

if (problems.length > 0) {
  console.error(`Not fit to publish:\n${problems.map((item) => `  - ${item}`).join('\n')}`);
  process.exit(1);
}

const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `dopilot-${manifest.version}.zip`);
rmSync(zip, { force: true });
run('zip', ['-qr', zip, '.'], dist);
console.log(`Checks passed. Not uploaded anywhere: ${zip}`);
if (manifest.key) {
  // How browsers derive an ID from a key: the hash's first 16 bytes, written with a to p.
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
  const id = [...hash.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('');
  console.log(`Extension ID, which the website uses by default: ${id}`);
}
console.log('Run `pnpm build` afterwards to go back to a local development build.');
