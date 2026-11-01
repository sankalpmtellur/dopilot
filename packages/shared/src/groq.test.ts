import { describe, expect, it } from 'vitest';
import {
  chooseToolModel,
  DEFAULT_TOOL_MODEL,
  maskApiKey,
  MODEL_ISSUE_TTL_MS,
  rankToolModels,
  validateApiKeyFormat,
} from './groq.js';

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

describe('choosing a model by what it can do', () => {
  const models = [
    { id: 'llama-3.3-70b-versatile' },
    { id: 'openai/gpt-oss-20b' },
    { id: 'whisper-large-v3' },
  ];
  const choose = (
    status: Partial<Parameters<typeof chooseToolModel>[0]['status']>,
    extra: Partial<Parameters<typeof chooseToolModel>[0]> = {},
  ) =>
    chooseToolModel({
      status: { selectedModel: null, models, ...status },
      tried: [],
      allowFallback: true,
      now: 1000,
      ...extra,
    });

  it('uses the user’s choice while it can do the job', () => {
    expect(choose({ selectedModel: 'openai/gpt-oss-20b' })).toEqual({ id: 'openai/gpt-oss-20b' });
  });

  it('never uses a model that cannot call tools, and says what it did instead', () => {
    const choice = choose({ selectedModel: 'whisper-large-v3' });
    expect(choice).toMatchObject({
      id: 'llama-3.3-70b-versatile',
      notice: expect.stringMatching(/whisper/),
    });
  });

  it('tells the user when it stands in for their model', () => {
    const choice = choose(
      { selectedModel: 'openai/gpt-oss-20b' },
      { tried: ['openai/gpt-oss-20b'] },
    );
    expect(choice).toMatchObject({ id: 'llama-3.3-70b-versatile', notice: expect.any(String) });
  });

  it('refuses rather than substituting, if the user said not to', () => {
    const choice = choose(
      { selectedModel: 'openai/gpt-oss-20b' },
      { tried: ['openai/gpt-oss-20b'], allowFallback: false },
    );
    expect(choice).toMatchObject({ refusal: expect.stringMatching(/gpt-oss-20b/) });
  });

  it('skips a model refused recently, but tries it again later', () => {
    const modelIssues = { 'llama-3.3-70b-versatile': { reason: 'unavailable' as const, at: 1000 } };
    expect(choose({ modelIssues })).toEqual({ id: 'openai/gpt-oss-20b' });
    expect(choose({ modelIssues }, { now: 1000 + MODEL_ISSUE_TTL_MS + 1 })).toEqual({
      id: 'llama-3.3-70b-versatile',
    });
  });

  it('falls back to a known model when no list could be fetched', () => {
    expect(choose({ models: [] })).toEqual({ id: DEFAULT_TOOL_MODEL });
  });

  it('refuses honestly when nothing is left', () => {
    expect(choose({}, { tried: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'] })).toMatchObject({
      refusal: expect.any(String),
    });
  });
});
