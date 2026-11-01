import { PROTOCOL_VERSION } from '@dopilot/shared';
import { describe, expect, it, vi } from 'vitest';
import { handleInternalMessage } from './internal';
import type { InternalDeps } from './internal';

const ID = 'abc';
const page = { id: ID, origin: `chrome-extension://${ID}` };

function deps(): InternalDeps {
  return {
    extensionId: ID,
    getState: vi.fn(),
    execute: vi.fn(async () => ({ ok: true as const, message: 'Done.' })),
    testGroq: vi.fn(),
    getConfirmationPrompt: vi.fn(() => 'Close tab?'),
    decideConfirmation: vi.fn(),
  };
}

const execute = {
  protocolVersion: PROTOCOL_VERSION,
  type: 'panel.execute',
  command: { action: 'tab.close' },
  confirmed: true,
};

describe('handleInternalMessage', () => {
  it('runs commands from extension pages', async () => {
    const mocks = deps();
    expect(await handleInternalMessage(execute, page, mocks)).toMatchObject({
      type: 'panel.command_result',
    });
    expect(mocks.execute).toHaveBeenCalledWith({ action: 'tab.close' }, true);
  });

  it.each([
    ['a content script inside a webpage', { id: ID, origin: 'https://evil.example' }],
    ['another extension', { id: 'other', origin: 'chrome-extension://other' }],
    ['an unknown sender', {}],
  ])('ignores %s, which must not be able to confirm or test keys', async (_label, sender) => {
    const mocks = deps();
    expect(await handleInternalMessage(execute, sender, mocks)).toBeNull();
    const decide = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'panel.decide_confirmation',
      id: crypto.randomUUID(),
      approved: true,
    };
    expect(await handleInternalMessage(decide, sender, mocks)).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.decideConfirmation).not.toHaveBeenCalled();
  });

  it('ignores invalid messages', async () => {
    const mocks = deps();
    expect(
      await handleInternalMessage({ ...execute, command: { action: 'nope' } }, page, mocks),
    ).toBeNull();
  });
});
