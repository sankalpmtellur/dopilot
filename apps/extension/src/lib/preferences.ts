import { DEFAULT_PREFERENCES, PreferencesSchema } from '@dopilot/shared';
import type { Preferences } from '@dopilot/shared';

const STORAGE_KEY = 'preferences';

export async function loadPreferences(): Promise<Preferences> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const parsed = PreferencesSchema.safeParse(stored[STORAGE_KEY]);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

/** Only extension pages can reach storage, so a website can never change these. */
export async function savePreferences(changes: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await loadPreferences()), ...changes };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
