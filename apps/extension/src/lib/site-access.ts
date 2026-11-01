const STORAGE_KEY = 'authorizedSites';
const ALL_SITES: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/**
 * Browsers only allow screenshots with `activeTab` or `<all_urls>`. Granting `<all_urls>`
 * also makes every per-site permission check succeed, so Dopilot records the sites the user
 * actually approved, and that list decides. Screenshot access never widens site access.
 */
export function hasAllSitesPermission(): Promise<boolean> {
  return chrome.permissions.contains(ALL_SITES);
}

export async function listAuthorizedSites(): Promise<string[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const sites = stored[STORAGE_KEY];
  return Array.isArray(sites) ? (sites as string[]) : [];
}

export async function addAuthorizedSite(origin: string): Promise<void> {
  const sites = await listAuthorizedSites();
  if (!sites.includes(origin)) {
    await chrome.storage.local.set({ [STORAGE_KEY]: [...sites, origin] });
  }
}

export async function removeAuthorizedSite(origin: string): Promise<void> {
  const sites = await listAuthorizedSites();
  await chrome.storage.local.set({ [STORAGE_KEY]: sites.filter((site) => site !== origin) });
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
}

export async function isSiteAuthorized(origin: string): Promise<boolean> {
  if (await hasAllSitesPermission()) return (await listAuthorizedSites()).includes(origin);
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

/** Keeps sites granted earlier when `<all_urls>` is about to make the browser's list useless. */
export async function rememberGrantedSites(): Promise<void> {
  const { origins = [] } = await chrome.permissions.getAll();
  for (const pattern of origins) {
    const match = /^(https?:\/\/[^/*]+)\/\*$/.exec(pattern);
    if (match?.[1] && !/api\.groq\.com|127\.0\.0\.1:4319/.test(pattern)) {
      await addAuthorizedSite(match[1]);
    }
  }
}
