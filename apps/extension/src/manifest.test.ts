import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_WEB_ORIGINS } from './messaging/external';

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../public/manifest.json'), 'utf8'),
);

describe('manifest', () => {
  it('requests only what is needed up front', () => {
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'scripting', 'sidePanel', 'storage']);
    expect(manifest.host_permissions).toEqual(['https://api.groq.com/*']);
    expect(manifest.optional_permissions).toEqual(['tabs']);
    // Sites are granted one at a time, at the moment the agent needs them.
    // <all_urls> is only requested for screenshots, because browsers accept nothing narrower.
    // Dopilot keeps its own list of authorized sites, so it does not unlock every site.
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*', '<all_urls>']);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(JSON.stringify(manifest.permissions)).not.toContain('<all_urls>');
  });

  it('exposes nothing to webpages beyond the allowed origin', () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable.matches).toEqual(
      [...ALLOWED_WEB_ORIGINS].map((origin) => `${origin}/*`),
    );
  });

  it('limits extension network access to Groq and forbids remote code', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    // The second address is the local development MCP bridge, which is off by default.
    expect(csp).toContain('connect-src https://api.groq.com http://127.0.0.1:4319;'.slice(0, -1));
    expect(csp).not.toContain('unsafe-eval');
  });

  it('pins the ID the website expects', () => {
    const digest = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest('hex')
      .slice(0, 32);
    const id = [...digest].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
    const website = readFileSync(
      resolve(import.meta.dirname, '../../web/src/lib/extension-bridge.ts'),
      'utf8',
    );
    expect(website).toContain(id);
  });
});
