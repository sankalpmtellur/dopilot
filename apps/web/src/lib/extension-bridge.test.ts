import { PROTOCOL_VERSION } from '@dopilot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectToExtension } from './extension-bridge';

function stubRuntime(sendMessage: (id: string, message: unknown) => Promise<unknown>) {
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
}

describe('connectToExtension', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('needs a configured extension ID', async () => {
    expect(await connectToExtension(undefined)).toEqual({ state: 'not_configured' });
  });

  it('handles browsers without extension messaging', async () => {
    expect(await connectToExtension('abc')).toEqual({ state: 'not_detected' });
  });

  it('connects on a valid pong', async () => {
    stubRuntime(async () => ({
      protocolVersion: PROTOCOL_VERSION,
      type: 'external.pong',
      extensionVersion: '1.2.3',
    }));
    expect(await connectToExtension('abc')).toEqual({ state: 'connected', version: '1.2.3' });
  });

  it('does not trust a malformed reply', async () => {
    stubRuntime(async () => ({ type: 'external.pong' }));
    expect(await connectToExtension('abc')).toEqual({ state: 'not_detected' });
  });
});
