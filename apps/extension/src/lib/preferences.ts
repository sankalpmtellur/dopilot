import { DEFAULT_PREFERENCES, PreferencesSchema } from '@dopilot/shared';
import type { Preferences } from '@dopilot/shared';

const STORAGE_KEY = 'preferences';

export async function loadPreferences(): Promise<Preferences> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  // Merged, so adding a preference never wipes the ones saved by an earlier version.
  const parsed = PreferencesSchema.safeParse({
    ...DEFAULT_PREFERENCES,
    ...(stored[STORAGE_KEY] as object | undefined),
  });
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

/** Only extension pages can reach storage, so a website can never change these. */
export async function savePreferences(changes: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await loadPreferences()), ...changes };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
