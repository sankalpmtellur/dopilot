import { PROTOCOL_VERSION } from '@dopilot/shared';
import { describe, expect, it } from 'vitest';
import { handleExternalMessage } from './external';

const ping = { protocolVersion: PROTOCOL_VERSION, type: 'external.ping' };

describe('handleExternalMessage', () => {
  it('answers a valid ping from an allowed origin', () => {
    expect(handleExternalMessage(ping, 'http://localhost:3000', '1.0.0')).toMatchObject({
      type: 'external.pong',
      extensionVersion: '1.0.0',
    });
  });

  it('rejects other origins before looking at the message', () => {
    for (const origin of ['https://evil.example', 'http://localhost:3001', undefined]) {
      expect(handleExternalMessage(ping, origin, '1.0.0')).toMatchObject({
        reason: 'origin_not_allowed',
      });
    }
  });

  it('rejects privileged or malformed messages from an allowed origin', () => {
    const message = { protocolVersion: PROTOCOL_VERSION, type: 'external.click', selector: 'a' };
    expect(handleExternalMessage(message, 'http://localhost:3000', '1.0.0')).toMatchObject({
      reason: 'invalid_message',
    });
  });
});
