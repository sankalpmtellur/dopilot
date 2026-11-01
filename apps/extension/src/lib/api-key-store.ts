const STORAGE_KEY = 'groqApiKey';

/**
 * Stores the user's Groq key on this device, for trusted extension contexts only.
 *
 * chrome.storage is not encrypted. The device owner and anything with access to
 * the browser profile can read it, so users should use a key they can revoke.
 * Never log the value, send it to our backend, or expose it to a content script.
 */
export async function restrictStorageToTrustedContexts(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: apiKey.trim() });
}

export async function loadApiKey(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  return typeof value === 'string' && value ? value : undefined;
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
