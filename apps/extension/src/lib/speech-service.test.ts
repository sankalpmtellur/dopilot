import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transcribeAudio } from './speech-service';

let local: Map<string, unknown>;

beforeEach(() => {
  local = new Map<string, unknown>([
    ['groqApiKey', 'gsk_test_key_abcdefghijklmnopqrstuvwxyz'],
    ['preferences', { vision: true, speechFallback: true, voiceEngine: 'auto' }],
  ]);
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async (key: string) => (local.has(key) ? { [key]: local.get(key) } : {}) },
    },
  });
});

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(async () => Response.json(body, { status, headers }));

// Every test uses a stub fetch. No test ever contacts Groq.
describe('speech-to-text fallback', () => {
  it('sends the recording to Groq and returns the text', async () => {
    const fetchStub = reply(200, { text: ' Open YouTube. ' });
    expect(await transcribeAudio('AAAA', 'audio/webm', fetchStub)).toEqual({
      text: 'Open YouTube.',
      error: null,
    });
    const [url, init] = fetchStub.mock.calls.at(-1) ?? [];
    expect(String(url)).toContain('/audio/transcriptions');
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect((form.get('file') as File).type).toBe('audio/webm');
  });

  it('refuses to send audio unless the user agreed', async () => {
    local.set('preferences', { vision: true, speechFallback: false, voiceEngine: 'auto' });
    const fetchStub = reply(200, { text: 'x' });
    const result = await transcribeAudio('AAAA', 'audio/webm', fetchStub);
    expect(result.error).toMatch(/turned off/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('needs a key', async () => {
    local.delete('groqApiKey');
    expect((await transcribeAudio('AAAA', 'audio/webm')).error).toMatch(/API key/);
  });

  it('explains free-tier limits', async () => {
    const result = await transcribeAudio(
      'AAAA',
      'audio/webm',
      reply(429, { error: {} }, { 'retry-after': '30' }),
    );
    expect(result.error).toMatch(/free-tier.*30s/);
  });

  it('tries the fallback model when a discovered one is gone', async () => {
    local.set('groqSettings', {
      connection: { state: 'connected', checkedAt: 1 },
      models: [],
      selectedModel: null,
      speechModels: [{ id: 'whisper-old' }],
    });
    const fetchStub = vi.fn<typeof fetch>(async (_url, init) =>
      (init?.body as FormData | undefined)?.get?.('model') === 'whisper-old'
        ? Response.json({ error: { code: 'model_not_found' } }, { status: 404 })
        : Response.json({ text: 'Hello' }),
    );
    expect((await transcribeAudio('AAAA', 'audio/webm', fetchStub)).text).toBe('Hello');
    const models = fetchStub.mock.calls
      .map((call) => call[1]?.body)
      .filter((body) => body instanceof FormData)
      .map((body) => (body as FormData).get('model'));
    expect(models).toEqual(['whisper-old', 'whisper-large-v3-turbo']);
  });

  it('reports when nothing was recognized, and bad recordings', async () => {
    expect((await transcribeAudio('AAAA', 'audio/webm', reply(200, { text: '  ' }))).error).toMatch(
      /No speech/,
    );
    expect((await transcribeAudio('%%%', 'audio/webm', reply(200, { text: 'x' }))).error).toMatch(
      /could not be read/,
    );
  });
});
