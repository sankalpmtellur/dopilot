import {
  GroqConnectionSchema,
  GroqModelSchema,
  maskApiKey,
  validateApiKeyFormat,
} from '@dopilot/shared';
import type { GroqConnection, GroqModel, GroqStatus } from '@dopilot/shared';
import { z } from 'zod';

const KEY_STORAGE = 'groqApiKey';
const SETTINGS_STORAGE = 'groqSettings';

const SettingsSchema = z.object({
  connection: GroqConnectionSchema,
  models: z.array(GroqModelSchema),
  selectedModel: z.string().nullable(),
});
type GroqSettings = z.infer<typeof SettingsSchema>;

const INITIAL_SETTINGS: GroqSettings = {
  connection: { state: 'untested', checkedAt: null },
  models: [],
  selectedModel: null,
};

/**
 * Stores the user's Groq key on this device, for trusted extension contexts only.
 *
 * chrome.storage is not encrypted. The device owner and anything with access to
 * the browser profile can read it, so users should use a key they can revoke.
 * Never log the value, put it in a message, or expose it to a content script.
 */
export async function restrictStorageToTrustedContexts(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export type SaveKeyResult = { ok: true } | { ok: false; error: string };

/** Replacing a key also clears what was learned about the old one. */
export async function saveApiKey(apiKey: string): Promise<SaveKeyResult> {
  const error = validateApiKeyFormat(apiKey);
  if (error) return { ok: false, error };
  await chrome.storage.local.set({
    [KEY_STORAGE]: apiKey.trim(),
    [SETTINGS_STORAGE]: INITIAL_SETTINGS,
  });
  return { ok: true };
}

export async function loadApiKey(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(KEY_STORAGE);
  const value = stored[KEY_STORAGE];
  return typeof value === 'string' && value ? value : undefined;
}

export async function removeApiKey(): Promise<void> {
  await chrome.storage.local.remove([KEY_STORAGE, SETTINGS_STORAGE]);
}

async function loadSettings(): Promise<GroqSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE);
  const parsed = SettingsSchema.safeParse(stored[SETTINGS_STORAGE]);
  return parsed.success ? parsed.data : INITIAL_SETTINGS;
}

export async function loadGroqStatus(): Promise<GroqStatus> {
  const [apiKey, settings] = await Promise.all([loadApiKey(), loadSettings()]);
  return {
    configured: apiKey !== undefined,
    maskedKey: apiKey ? maskApiKey(apiKey) : null,
    ...settings,
  };
}

/**
 * Keeps the previous model list when a test fails for a temporary reason. A model
 * that Groq no longer offers is deselected rather than kept.
 */
export async function recordConnectionTest(
  connection: GroqConnection,
  models: GroqModel[] | null,
): Promise<void> {
  const settings = await loadSettings();
  const nextModels = models ?? settings.models;
  const stillAvailable =
    models === null || models.some((model) => model.id === settings.selectedModel);
  await chrome.storage.local.set({
    [SETTINGS_STORAGE]: {
      connection,
      models: nextModels,
      selectedModel: stillAvailable ? settings.selectedModel : null,
    } satisfies GroqSettings,
  });
}

/** Deselects a model Groq has reported as unavailable, so the next task chooses automatically. */
export async function dropSelectedModel(modelId: string): Promise<void> {
  const settings = await loadSettings();
  if (settings.selectedModel !== modelId) return;
  await chrome.storage.local.set({
    [SETTINGS_STORAGE]: { ...settings, selectedModel: null } satisfies GroqSettings,
  });
}

export async function markKeyRejected(state: 'invalid_key' | 'forbidden'): Promise<void> {
  const settings = await loadSettings();
  await chrome.storage.local.set({
    [SETTINGS_STORAGE]: {
      ...settings,
      connection: { state, checkedAt: Date.now() },
    } satisfies GroqSettings,
  });
}

export async function selectModel(modelId: string | null): Promise<void> {
  const settings = await loadSettings();
  const known = modelId === null || settings.models.some((model) => model.id === modelId);
  if (!known) return;
  await chrome.storage.local.set({
    [SETTINGS_STORAGE]: { ...settings, selectedModel: modelId } satisfies GroqSettings,
  });
}
