const TAB_DETAILS: chrome.permissions.Permissions = { permissions: ['tabs'] };

/**
 * Tab titles and addresses need the optional "tabs" permission. Opening, switching,
 * reloading and closing tabs do not, so it is only requested if the user wants it.
 */
export function hasTabDetails(): Promise<boolean> {
  return chrome.permissions.contains(TAB_DETAILS);
}

/** Must be called from a click in an extension page. */
export function requestTabDetails(): Promise<boolean> {
  return chrome.permissions.request(TAB_DETAILS);
}

export function removeTabDetails(): Promise<boolean> {
  return chrome.permissions.remove(TAB_DETAILS);
}
