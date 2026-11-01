export const MAX_URL_LENGTH = 2048;

export type UrlValidation = { ok: true; url: string } | { ok: false; reason: string };

const ONLY_WEB_PAGES = 'Only http and https addresses can be opened.';
const NOT_AN_ADDRESS = 'That does not look like a web address.';

function looksLikeHost(host: string): boolean {
  return host === 'localhost' || /^[^\s.]+(\.[^\s.]+)+$/.test(host);
}

/**
 * Turns user or website input into a safe address to navigate to. Internal browser
 * pages, extension pages and script-carrying schemes are all refused.
 */
export function validateNavigationUrl(input: string): UrlValidation {
  const value = input.trim();
  if (!value || value.length > MAX_URL_LENGTH) return { ok: false, reason: NOT_AN_ADDRESS };

  // URL parsers strip these, which would let "java\nscript:" slip past a scheme check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(value)) return { ok: false, reason: NOT_AN_ADDRESS };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  const isHostAndPort = /^[^/:]+:\d+(\/|\?|#|$)/.test(value);
  let candidate = value;

  if (scheme && !isHostAndPort) {
    if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: ONLY_WEB_PAGES };
  } else {
    const host = value.split(/[/:?#]/, 1)[0] ?? '';
    if (!looksLikeHost(host)) return { ok: false, reason: NOT_AN_ADDRESS };
    candidate = `${host === 'localhost' ? 'http' : 'https'}://${value}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: NOT_AN_ADDRESS };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: ONLY_WEB_PAGES };
  }
  if (!parsed.hostname) return { ok: false, reason: NOT_AN_ADDRESS };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Addresses containing a username or password are not allowed.' };
  }
  return { ok: true, url: parsed.href };
}

const BLANK_TAB_PAGES = new Set([
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'brave://newtab/',
  'about:blank',
]);

/** True for internal browser pages and extension pages, apart from blank new tabs. */
export function isRestrictedTabUrl(url: string): boolean {
  if (BLANK_TAB_PAGES.has(url)) return false;
  return !/^https?:\/\//i.test(url);
}

/** Drops credentials, query strings and fragments, which often contain tokens. */
export function sanitizeTabUrl(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return undefined;
  }
}

/** Untitled pages use their full address as the title, which would bring the query string back. */
export function sanitizeTabTitle(title: string, url: string | undefined): string {
  if (!url) return title;
  try {
    const { search, hash } = new URL(url);
    let clean = title;
    for (const part of [search, hash]) {
      if (part.length > 1) clean = clean.replaceAll(part, '');
    }
    return clean;
  } catch {
    return title;
  }
}
