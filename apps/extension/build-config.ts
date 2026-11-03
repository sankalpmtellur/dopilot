/**
 * What differs between a local build and a public one. Local builds are unchanged, and
 * keep the pinned key so existing installs and their data keep working. A public build
 * carries nothing that only exists for development, and trusts a website only if named.
 */
export interface BuildConfig {
  production: boolean;
  webOrigins: string[];
  mcp: boolean;
  keepKey: boolean;
}

interface Manifest {
  key?: string;
  externally_connectable?: { matches: string[] };
  content_security_policy: { extension_pages: string };
}

export function resolveBuildConfig(env: Record<string, string | undefined>): BuildConfig {
  const production = env.DOPILOT_CHANNEL === 'production';
  if (!production) {
    return {
      production: false,
      webOrigins: ['http://localhost:3000'],
      mcp: true,
      keepKey: true,
    };
  }

  const origin = env.DOPILOT_WEB_ORIGIN;
  // The extension stands alone by default, so a public build trusts no website unless told to.
  if (!origin) {
    return {
      production: true,
      webOrigins: [],
      mcp: env.DOPILOT_MCP === '1',
      keepKey: env.DOPILOT_KEEP_KEY === '1',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`DOPILOT_WEB_ORIGIN is not an address: ${origin}`);
  }
  if (parsed.origin !== origin || parsed.protocol !== 'https:') {
    throw new Error('DOPILOT_WEB_ORIGIN must be an https origin, with no path.');
  }
  if (/^(localhost|127\.|\[::1\])/.test(parsed.hostname) || parsed.hostname.includes('*')) {
    throw new Error('DOPILOT_WEB_ORIGIN must be a real public domain.');
  }
  return {
    production: true,
    webOrigins: [origin],
    mcp: env.DOPILOT_MCP === '1',
    // Stores refuse a manifest with a key. Keeping it is for sharing an unpacked build.
    keepKey: env.DOPILOT_KEEP_KEY === '1',
  };
}

export function buildManifest<M extends Manifest>(base: M, config: BuildConfig): M {
  const manifest = structuredClone(base);
  // Browsers treat an empty list as a mistake, so no websites means no entry at all.
  if (config.webOrigins.length > 0) {
    manifest.externally_connectable = {
      matches: config.webOrigins.map((origin) => `${origin}/*`),
    };
  } else {
    delete manifest.externally_connectable;
  }
  if (!config.keepKey) delete manifest.key;
  if (!config.mcp) {
    manifest.content_security_policy.extension_pages =
      manifest.content_security_policy.extension_pages.replace(' http://127.0.0.1:4319', '');
  }
  return manifest;
}
