/**
 * Asks for access to a single site at runtime, so the extension never holds
 * blanket access to every page. Must be called from a user gesture.
 */
export function requestHostAccess(url: string): Promise<boolean> {
  const { protocol, host } = new URL(url);
  if (protocol !== 'https:' && protocol !== 'http:') return Promise.resolve(false);
  return chrome.permissions.request({ origins: [`${protocol}//${host}/*`] });
}
