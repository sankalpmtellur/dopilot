import { describe, expect, it } from 'vitest';
import { ExternalRequestSchema, PanelRequestSchema, PROTOCOL_VERSION } from './messages.js';

const base = {
  protocolVersion: PROTOCOL_VERSION,
  requestId: '6f1c2f0e-3b1d-4a57-9c8e-2d4b6a8f0c11',
};

describe('ExternalRequestSchema', () => {
  it('accepts a ping and a valid command', () => {
    expect(ExternalRequestSchema.safeParse({ ...base, type: 'external.ping' }).success).toBe(true);
    expect(
      ExternalRequestSchema.safeParse({
        ...base,
        type: 'external.command',
        command: { action: 'tab.list' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown types, extra fields, bad IDs and other protocol versions', () => {
    const invalid = [
      { ...base, type: 'external.run_task' },
      { ...base, type: 'external.ping', apiKey: 'x' },
      { ...base, type: 'external.ping', requestId: 'not-a-uuid' },
      { ...base, type: 'external.ping', protocolVersion: PROTOCOL_VERSION + 1 },
      { protocolVersion: PROTOCOL_VERSION, type: 'external.ping' },
    ];
    for (const message of invalid) {
      expect(ExternalRequestSchema.safeParse(message).success).toBe(false);
    }
  });

  it('rejects commands outside the closed list and self-confirmation', () => {
    const commands = [
      { action: 'tab.execute_script', code: 'alert(1)' },
      { action: 'tab.close', confirmed: true },
      { action: 'tab.open_url' },
      { action: 'tab.switch', target: { tabId: -1 } },
      { action: 'tab.switch', target: { tabId: 1, position: 1 } },
    ];
    for (const command of commands) {
      const message = { ...base, type: 'external.command', command };
      expect(ExternalRequestSchema.safeParse(message).success).toBe(false);
    }
  });
});

describe('PanelRequestSchema', () => {
  it('has no message that can carry an API key', () => {
    const save = { protocolVersion: PROTOCOL_VERSION, type: 'panel.save_key', apiKey: 'gsk_x' };
    expect(PanelRequestSchema.safeParse(save).success).toBe(false);
  });
});

describe('agent messages', () => {
  it('accepts an instruction and rejects empty or oversized ones', () => {
    const start = { ...base, type: 'external.agent_start' };
    expect(ExternalRequestSchema.safeParse({ ...start, instruction: 'open youtube' }).success).toBe(
      true,
    );
    expect(ExternalRequestSchema.safeParse({ ...start, instruction: '   ' }).success).toBe(false);
    expect(
      ExternalRequestSchema.safeParse({ ...start, instruction: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('gives websites no way to answer an approval', () => {
    const answer = { ...base, type: 'external.resolve_approval', id: 'a', approved: true };
    expect(ExternalRequestSchema.safeParse(answer).success).toBe(false);
  });
});
