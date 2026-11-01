import { describe, expect, it } from 'vitest';
import { ExternalRequestSchema, PROTOCOL_VERSION } from './messages.js';

describe('ExternalRequestSchema', () => {
  it('accepts a ping', () => {
    const ping = { protocolVersion: PROTOCOL_VERSION, type: 'external.ping' };
    expect(ExternalRequestSchema.safeParse(ping).success).toBe(true);
  });

  it('rejects unknown types, extra fields and other protocol versions', () => {
    const invalid = [
      { protocolVersion: PROTOCOL_VERSION, type: 'external.run_task' },
      { protocolVersion: PROTOCOL_VERSION, type: 'external.ping', apiKey: 'x' },
      { protocolVersion: PROTOCOL_VERSION + 1, type: 'external.ping' },
    ];
    for (const message of invalid) {
      expect(ExternalRequestSchema.safeParse(message).success).toBe(false);
    }
  });
});
