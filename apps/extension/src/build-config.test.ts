import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, resolveBuildConfig } from '../build-config';

const base = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../public/manifest.json'), 'utf8'),
);
const production = { DOPILOT_CHANNEL: 'production', DOPILOT_WEB_ORIGIN: 'https://dopilot.example' };

describe('development builds', () => {
  it('stay exactly as they were, so existing installs keep their ID and data', () => {
    const manifest = buildManifest(base, resolveBuildConfig({}));
    expect(manifest).toEqual(base);
    expect(manifest.key).toBeTruthy();
  });
});

describe('production builds', () => {
  const manifest = buildManifest(base, resolveBuildConfig(production));

  it('allow only the production website', () => {
    expect(manifest.externally_connectable).toEqual({ matches: ['https://dopilot.example/*'] });
    expect(JSON.stringify(manifest)).not.toContain('localhost');
  });

  it('leave out the key, which stores refuse, and the local MCP address', () => {
    expect(manifest.key).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).not.toContain('127.0.0.1');
    expect(manifest.content_security_policy.extension_pages).toContain('https://api.groq.com');
  });

  it('do not widen what is asked for at install', () => {
    expect(manifest.host_permissions).toEqual(['https://api.groq.com/*']);
    expect(manifest.permissions).toEqual(base.permissions);
  });

  it('can keep the key on request, for sharing an unpacked build', () => {
    const kept = buildManifest(base, resolveBuildConfig({ ...production, DOPILOT_KEEP_KEY: '1' }));
    expect(kept.key).toBe(base.key);
  });

  it.each([
    [undefined, /needs DOPILOT_WEB_ORIGIN/],
    ['http://dopilot.example', /https/],
    ['https://dopilot.example/app', /no path/],
    ['https://localhost:3000', /public domain/],
    ['https://127.0.0.1', /public domain/],
    ['https://*.vercel.app', /./],
    ['not an address', /not an address/],
  ])('refuse %s as the website', (origin, message) => {
    expect(() =>
      resolveBuildConfig({ DOPILOT_CHANNEL: 'production', DOPILOT_WEB_ORIGIN: origin }),
    ).toThrow(message);
  });
});
