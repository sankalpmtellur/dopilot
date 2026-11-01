import { CommandResultSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchExtensionState, sendBrowserCommand } from './extension-bridge';

type Message = { requestId: string; type: string; targetRequestId?: string };

function stubRuntime(sendMessage: (id: string, message: Message) => Promise<unknown>) {
  const spy = vi.fn(sendMessage);
  vi.stubGlobal('chrome', { runtime: { sendMessage: spy } });
  return spy;
}

const commandReply = (message: Message) => ({
  protocolVersion: PROTOCOL_VERSION,
  requestId: message.requestId,
  type: 'external.command_result',
  result: { ok: true, message: 'Done.' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('disconnected extension', () => {
  it('handles browsers without extension messaging', async () => {
    const result = await sendBrowserCommand('abc', { action: 'tab.new' });
    expect(result).toMatchObject({ ok: false, code: 'extension_unavailable' });
    expect(CommandResultSchema.safeParse(result).success).toBe(true);
    expect(await fetchExtensionState('abc')).toBeNull();
  });

  it('handles an extension that was removed or disabled', async () => {
    stubRuntime(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    const result = await sendBrowserCommand('abc', { action: 'tab.new' });
    expect(result).toMatchObject({ ok: false, code: 'extension_unavailable' });
    expect(await fetchExtensionState('abc')).toBeNull();
  });
});

describe('sendBrowserCommand', () => {
  it('gives every request its own ID and returns the structured result', async () => {
    const spy = stubRuntime(async (_id, message) => commandReply(message));
    expect(await sendBrowserCommand('abc', { action: 'tab.new' })).toEqual({
      ok: true,
      message: 'Done.',
    });
    await sendBrowserCommand('abc', { action: 'tab.new' });
    const [first, second] = spy.mock.calls.map((call) => call[1].requestId);
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it('does not trust a malformed reply or another request’s reply', async () => {
    stubRuntime(async () => ({ type: 'external.command_result' }));
    expect(await sendBrowserCommand('abc', { action: 'tab.new' })).toMatchObject({
      ok: false,
      code: 'execution_failed',
    });

    stubRuntime(async (_id, message) => ({
      ...commandReply(message),
      requestId: crypto.randomUUID(),
    }));
    expect(await sendBrowserCommand('abc', { action: 'tab.new' })).toMatchObject({ ok: false });
  });

  it('reports a rejection instead of treating it as success', async () => {
    stubRuntime(async () => ({
      protocolVersion: PROTOCOL_VERSION,
      requestId: null,
      type: 'external.rejected',
      reason: 'origin_not_allowed',
    }));
    expect(await sendBrowserCommand('abc', { action: 'tab.new' })).toMatchObject({ ok: false });
  });

  it('times out and tells the extension to stop waiting', async () => {
    vi.useFakeTimers();
    const spy = stubRuntime((_id, message) =>
      message.type === 'external.cancel'
        ? Promise.resolve(undefined)
        : new Promise(() => undefined),
    );
    const pending = sendBrowserCommand('abc', { action: 'tab.new' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ ok: false, code: 'timeout' });
    const [first, cancel] = spy.mock.calls.map((call) => call[1]);
    expect(cancel).toMatchObject({ type: 'external.cancel', targetRequestId: first?.requestId });
  });

  it('allows longer for a confirmation', async () => {
    vi.useFakeTimers();
    stubRuntime(() => new Promise(() => undefined));
    let settled = false;
    void sendBrowserCommand('abc', { action: 'tab.close' }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
  });

  it('can be cancelled', async () => {
    const spy = stubRuntime((_id, message) =>
      message.type === 'external.cancel'
        ? Promise.resolve(undefined)
        : new Promise(() => undefined),
    );
    const controller = new AbortController();
    const pending = sendBrowserCommand('abc', { action: 'tab.close' }, controller.signal);
    controller.abort();

    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' });
    expect(spy.mock.calls.map((call) => call[1].type)).toContain('external.cancel');
  });
});
