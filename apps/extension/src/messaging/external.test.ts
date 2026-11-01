import { ExternalResponseSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type { ExtensionState } from '@dopilot/shared';
import { describe, expect, it, vi } from 'vitest';
import { createExternalHandler } from './external';
import type { ExternalDeps } from './external';
import { RateLimiter } from './rate-limit';

const ORIGIN = 'http://localhost:3000';

const state: ExtensionState = {
  extensionVersion: '1.0.0',
  tabDetailsAvailable: false,
  tabs: [],
  currentTabId: null,
  groq: {
    configured: true,
    maskedKey: 'gsk_••••••••1234',
    connection: { state: 'untested', checkedAt: null },
    models: [],
    selectedModel: null,
    visionModels: [],
    selectedVisionModel: null,
    visionFallback: 'qwen/qwen3.8-27b',
    speechModels: [],
  },
  agent: null,
  preferences: { vision: true, speechFallback: false, voiceEngine: 'auto', modelFallback: true },
  recentActions: [],
};

function setup(overrides: Partial<ExternalDeps> = {}) {
  const deps = {
    extensionVersion: '1.0.0',
    getState: vi.fn(async () => state),
    execute: vi.fn(async () => ({ ok: true as const, message: 'Done.' })),
    cancel: vi.fn(),
    openSettings: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => null),
    stopAgent: vi.fn(async () => undefined),
    resetAgent: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ text: 'open youtube', error: null })),
    ...overrides,
  };
  return { deps, handle: createExternalHandler(deps) };
}

function message(type: string, extra: object = {}, requestId: string = crypto.randomUUID()) {
  return { protocolVersion: PROTOCOL_VERSION, requestId, type, ...extra };
}

const command = (extra: object = {}, id?: string) =>
  message('external.command', { command: { action: 'tab.new' }, ...extra }, id);

describe('origin checks', () => {
  it.each([
    'https://evil.example',
    'http://localhost:3001',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3000.evil.example',
    'null',
    undefined,
  ])('rejects %s before doing anything', async (origin) => {
    const { handle, deps } = setup();
    const response = await handle(command(), { origin });
    expect(response).toMatchObject({ type: 'external.rejected', reason: 'origin_not_allowed' });
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

describe('message validation', () => {
  it.each([
    ['unknown message', message('external.run_script', { code: 'alert(1)' })],
    ['unknown command', command({ command: { action: 'tab.execute', code: 'alert(1)' } })],
    ['self-confirmation', command({ command: { action: 'tab.close', confirmed: true } })],
    ['extra fields', command({ apiKey: 'gsk_x' })],
    ['missing request ID', { protocolVersion: PROTOCOL_VERSION, type: 'external.ping' }],
    ['not an object', 'external.ping'],
  ])('rejects %s', async (_label, payload) => {
    const { handle, deps } = setup();
    const response = await handle(payload, { origin: ORIGIN });
    expect(response).toMatchObject({ type: 'external.rejected', reason: 'invalid_message' });
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

describe('structured responses', () => {
  it('echoes the request ID and matches the shared schema', async () => {
    const { handle } = setup();
    const id = crypto.randomUUID();
    for (const payload of [
      message('external.ping', {}, id),
      message('external.get_state', {}, id),
      command({}, id),
    ]) {
      const response = await handle(payload, { origin: ORIGIN });
      expect(response.requestId).toBe(id);
      expect(ExternalResponseSchema.safeParse(response).success).toBe(true);
    }
  });

  it('passes the sender tab, so the website is not treated as the current tab', async () => {
    const { handle, deps } = setup();
    const id = crypto.randomUUID();
    await handle(command({}, id), { origin: ORIGIN, tabId: 5 });
    expect(deps.execute).toHaveBeenCalledWith({ action: 'tab.new' }, id, 5);
  });

  it('cancels by request ID', async () => {
    const { handle, deps } = setup();
    const target = crypto.randomUUID();
    await handle(message('external.cancel', { targetRequestId: target }), { origin: ORIGIN });
    expect(deps.cancel).toHaveBeenCalledWith(target);
  });
});

describe('agent control from the website', () => {
  const start = (instruction: unknown) => message('external.agent_start', { instruction });

  it('starts and stops tasks', async () => {
    const { handle, deps } = setup();
    expect(await handle(start('open youtube'), { origin: ORIGIN })).toMatchObject({
      type: 'external.agent_started',
      error: null,
    });
    expect(deps.startAgent).toHaveBeenCalledWith('open youtube', undefined);
    await handle(message('external.agent_stop'), { origin: ORIGIN });
    expect(deps.stopAgent).toHaveBeenCalled();
  });

  it('tells the agent which tab is the website, so it is left alone', async () => {
    const { handle, deps } = setup();
    await handle(start('open youtube'), { origin: ORIGIN, tabId: 42 });
    expect(deps.startAgent).toHaveBeenCalledWith('open youtube', 42);
  });

  it('reports why a task could not start', async () => {
    const { handle } = setup({ startAgent: async () => 'Add your key first.' });
    expect(await handle(start('x'), { origin: ORIGIN })).toMatchObject({
      error: 'Add your key first.',
    });
  });

  it('other origins cannot start or stop anything', async () => {
    const { handle, deps } = setup();
    await handle(start('x'), { origin: 'https://evil.example' });
    await handle(message('external.agent_stop'), { origin: 'https://evil.example' });
    expect(deps.startAgent).not.toHaveBeenCalled();
    expect(deps.stopAgent).not.toHaveBeenCalled();
  });

  it('rejects any attempt to answer an approval', async () => {
    const { handle } = setup();
    const answer = message('external.resolve_approval', { id: 'a', approved: true });
    expect(await handle(answer, { origin: ORIGIN })).toMatchObject({ reason: 'invalid_message' });
  });

  it('rate limits starting tasks', async () => {
    const { handle, deps } = setup({ rateLimiter: new RateLimiter(1, 1000, () => 5000) });
    await handle(start('a'), { origin: ORIGIN });
    const limited = await handle(start('b'), { origin: ORIGIN });
    expect(limited).toMatchObject({ error: expect.stringMatching(/too many/i) });
    expect(deps.startAgent).toHaveBeenCalledTimes(1);
  });
});

describe('voice and vision from the website', () => {
  it('can have speech transcribed, subject to the same checks', async () => {
    const { handle, deps } = setup();
    const speech = message('external.transcribe', { audio: 'AAAA', mimeType: 'audio/webm' });
    expect(await handle(speech, { origin: ORIGIN })).toMatchObject({
      type: 'external.transcription',
      text: 'open youtube',
    });
    await handle(speech, { origin: 'https://evil.example' });
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });

  it('refuses oversized audio and unknown formats', async () => {
    const { handle, deps } = setup();
    for (const extra of [
      { audio: 'A'.repeat(600000), mimeType: 'audio/webm' },
      { audio: 'AAAA', mimeType: 'text/html' },
    ]) {
      expect(await handle(message('external.transcribe', extra), { origin: ORIGIN })).toMatchObject(
        {
          reason: 'invalid_message',
        },
      );
    }
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ['read a screenshot', 'panel.get_screenshot', { id: 's1' }],
    ['ask for one by another name', 'external.get_screenshot', { id: 's1' }],
    ['change settings', 'external.set_preferences', { speechFallback: true }],
  ])('cannot %s', async (_label, type, extra) => {
    const { handle } = setup();
    expect(await handle(message(type, extra), { origin: ORIGIN })).toMatchObject({
      reason: 'invalid_message',
    });
  });
});

describe('abuse limits', () => {
  it('refuses to run a request ID twice', async () => {
    const { handle, deps } = setup();
    const id = crypto.randomUUID();
    await handle(command({}, id), { origin: ORIGIN });
    const replay = await handle(command({}, id), { origin: ORIGIN });
    expect(replay).toMatchObject({ result: { ok: false, code: 'duplicate_request' } });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('rate limits commands', async () => {
    const { handle, deps } = setup({ rateLimiter: new RateLimiter(1, 1000, () => 5000) });
    await handle(command(), { origin: ORIGIN });
    const limited = await handle(command(), { origin: ORIGIN });
    expect(limited).toMatchObject({ result: { ok: false, code: 'rate_limited' } });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });
});
