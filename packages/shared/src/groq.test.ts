import { describe, expect, it } from 'vitest';
import { maskApiKey, validateApiKeyFormat } from './groq.js';

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
