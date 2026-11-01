import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadApiKey,
  loadGroqStatus,
  recordConnectionTest,
  removeApiKey,
  saveApiKey,
  selectModel,
} from './api-key-store';

const KEY = 'gsk_abcdefghijklmnopqrstuvwxyz1234';

beforeEach(() => {
  const data = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) data.set(key, value);
        },
        remove: async (keys: string[]) => {
          for (const key of keys) data.delete(key);
        },
      },
    },
  });
});

describe('API key store', () => {
  it('saves and exposes only a masked key in the status', async () => {
    expect(await saveApiKey(`  ${KEY}  `)).toEqual({ ok: true });
    expect(await loadApiKey()).toBe(KEY);

    const status = await loadGroqStatus();
    expect(status.configured).toBe(true);
    expect(status.maskedKey).toBe('gsk_••••••••1234');
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it('refuses malformed keys', async () => {
    expect((await saveApiKey('nope')).ok).toBe(false);
    expect(await loadApiKey()).toBeUndefined();
  });

  it('removes the key and everything learned about it', async () => {
    await saveApiKey(KEY);
    await recordConnectionTest({ state: 'connected', checkedAt: 1 }, [{ id: 'model-a' }]);
    await removeApiKey();

    expect(await loadApiKey()).toBeUndefined();
    expect(await loadGroqStatus()).toEqual({
      configured: false,
      maskedKey: null,
      connection: { state: 'untested', checkedAt: null },
      models: [],
      selectedModel: null,
      visionModels: [],
      selectedVisionModel: null,
      visionFallback: 'qwen/qwen3.8-27b',
      speechModels: [],
      modelIssues: {},
    });
  });

  it('resets the connection state when the key changes', async () => {
    await saveApiKey(KEY);
    await recordConnectionTest({ state: 'connected', checkedAt: 1 }, [{ id: 'model-a' }]);
    await selectModel('model-a');
    await saveApiKey('gsk_zyxwvutsrqponmlkjihgfedcba9876');

    const status = await loadGroqStatus();
    expect(status.maskedKey).toBe('gsk_••••••••9876');
    expect(status.connection.state).toBe('untested');
    expect(status.selectedModel).toBeNull();
  });

  it('only selects models Groq reported, and drops ones that disappear', async () => {
    await saveApiKey(KEY);
    await recordConnectionTest({ state: 'connected', checkedAt: 1 }, [{ id: 'model-a' }]);

    await selectModel('made-up');
    expect((await loadGroqStatus()).selectedModel).toBeNull();

    await selectModel('model-a');
    expect((await loadGroqStatus()).selectedModel).toBe('model-a');

    await recordConnectionTest({ state: 'rate_limited', checkedAt: 2 }, null);
    expect((await loadGroqStatus()).selectedModel).toBe('model-a');

    await recordConnectionTest({ state: 'connected', checkedAt: 3 }, [{ id: 'model-b' }]);
    expect((await loadGroqStatus()).selectedModel).toBeNull();
  });
});
