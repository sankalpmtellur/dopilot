#!/usr/bin/env node
// Writes the license texts that shipped third-party code requires to be passed on, into both
// the extension and the website. Run it after changing dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// Used only on the server or at build time, so these never reach anyone's browser.
const NOT_SHIPPED =
  /^(@img\/|sharp$|detect-libc$|semver$|caniuse-lite$|baseline-browser-mapping$|browserslist$|electron-to-chromium$|node-releases$|update-browserslist-db$|@babel\/|gensync$|json5$|jsesc$|js-tokens$|lru-cache$|yallist$|debug$|ms$|picocolors$|convert-source-map$|escalade$|@jridgewell\/)/;

function packagesOf(filter) {
  const output = execFileSync(
    'pnpm',
    ['--filter', filter, 'licenses', 'list', '--prod', '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
    },
  );
  return Object.entries(JSON.parse(output))
    .flatMap(([license, packages]) => packages.map((item) => ({ ...item, license })))
    .filter((item) => !NOT_SHIPPED.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function licenseText(path) {
  const files = existsSync(path) ? readdirSync(path) : [];
  return files
    .filter((name) => /^(licen[cs]e|notice|copying)/i.test(name))
    .sort()
    .map((name) => readFileSync(join(path, name), 'utf8').trim())
    .join('\n\n');
}

function write(filter, target) {
  const sections = packagesOf(filter).map(({ name, versions, license, paths }) => {
    const text = licenseText(paths?.[0] ?? '');
    if (!text) console.log(`  No license file in ${name}; recording its declared license.`);
    return `${name} ${versions.join(', ')} (${license})\n\n${text || `Licensed under ${license}. The package includes no license file.`}`;
  });
  const header = 'Dopilot includes the following third-party software.';
  writeFileSync(join(root, target), `${header}\n\n${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`);
  console.log(`${target}: ${sections.length} packages`);
}

write('@dopilot/extension', 'apps/extension/public/THIRD_PARTY_NOTICES.txt');
write('@dopilot/web', 'apps/web/public/third-party-notices.txt');
