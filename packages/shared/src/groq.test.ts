import { describe, expect, it } from 'vitest';
import { maskApiKey, rankToolModels, validateApiKeyFormat } from './groq.js';

describe('maskApiKey', () => {
  const key = 'gsk_abcdefghijklmnopqrstuvwxyz1234';

  it('reveals only the prefix and last four characters', () => {
    expect(maskApiKey(key)).toBe('gsk_••••••••1234');
    expect(maskApiKey(key)).not.toContain('abcdefgh');
  });

  it('reveals nothing from a short key', () => {
    expect(maskApiKey('short-key')).toBe('••••••••');
  });
});

describe('validateApiKeyFormat', () => {
  it('accepts plausible keys, without assuming a prefix', () => {
    expect(validateApiKeyFormat('gsk_abcdefghijklmnopqrstuvwxyz')).toBeNull();
    expect(validateApiKeyFormat('  future_format_abcdefghijklmnop ')).toBeNull();
  });

  it('rejects empty, short and whitespace-containing input', () => {
    for (const value of ['', '   ', 'short', 'gsk_abc def ghi jkl mno pqr stu']) {
      expect(validateApiKeyFormat(value)).not.toBeNull();
    }
  });
});

describe('rankToolModels', () => {
  it('prefers reliable tool-calling families and drops models that cannot use tools', () => {
    const ranked = rankToolModels([
      { id: 'whisper-large-v3' },
      { id: 'groq/compound' },
      { id: 'meta-llama/llama-prompt-guard-2-86m' },
      { id: 'unknown-model', contextWindow: 200000 },
      { id: 'llama-3.1-8b-instant' },
      { id: 'llama-3.3-70b-versatile' },
    ]);
    expect(ranked.map((model) => model.id)).toEqual([
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'unknown-model',
    ]);
  });

  it('still offers something when Groq has only unfamiliar models', () => {
    const ranked = rankToolModels([
      { id: 'future-a', contextWindow: 1000 },
      { id: 'future-b', contextWindow: 9000 },
    ]);
    expect(ranked[0]?.id).toBe('future-b');
  });
});
