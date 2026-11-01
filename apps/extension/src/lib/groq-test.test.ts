import { describe, expect, it, vi } from 'vitest';
import { testGroqKey } from './groq-test';

const KEY = 'gsk_test_key_abcdefghijklmnopqrstuvwxyz';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status, headers }));
}

// Every test uses a stub fetch. No test ever contacts Groq.
describe('testGroqKey', () => {
  it('reports a working key and keeps only active text models', async () => {
    const fetchStub = respond(200, {
      object: 'list',
      data: [
        { id: 'text-b', active: true },
        { id: 'text-a', active: true },
        { id: 'retired-model', active: false },
        { id: 'whisper-large', active: true },
        { id: 'some-guard', active: true },
      ],
    });
    const outcome = await testGroqKey(KEY, 1000, fetchStub);

    expect(outcome.connection).toEqual({ state: 'connected', checkedAt: 1000 });
    expect(outcome.models).toEqual([{ id: 'text-a' }, { id: 'text-b' }]);

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(String(url)).toContain('/models');
    expect(init?.method).toBe('GET');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected key, without retrying or keeping the API error text', async () => {
    const fetchStub = respond(401, { error: { message: `Invalid API Key ${KEY}` } });
    const outcome = await testGroqKey(KEY, 1000, fetchStub);

    expect(outcome).toEqual({
      connection: { state: 'invalid_key', checkedAt: 1000 },
      models: null,
    });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('maps rate limiting and reads the retry delay', async () => {
    const fetchStub = respond(429, { error: {} }, { 'retry-after': '30' });
    const outcome = await testGroqKey(KEY, 1000, fetchStub);
    expect(outcome.connection).toEqual({
      state: 'rate_limited',
      checkedAt: 1000,
      retryAfterSeconds: 30,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('maps forbidden, server and network failures', async () => {
    expect((await testGroqKey(KEY, 1, respond(403, {}))).connection.state).toBe('forbidden');
    expect((await testGroqKey(KEY, 1, respond(503, {}))).connection.state).toBe('service_error');
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await testGroqKey(KEY, 1, offline)).connection.state).toBe('network_error');
  });
});
