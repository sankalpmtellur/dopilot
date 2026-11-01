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
    startAgent: vi.fn(async () => null),
    stopAgent: vi.fn(async () => undefined),
    resetAgent: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => undefined),
    getApproval: vi.fn(async () => null),
    mcpStatus: () => ({ enabled: false, connected: false }),
    mcpConfigure: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ text: 'hi', error: null })),
    getScreenshot: vi.fn(() => 'data:image/jpeg;base64,/9j/'),
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

  it('accepts approval answers only from extension pages', async () => {
    const mocks = deps();
    const answer = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'panel.resolve_approval',
      id: 'approval-1',
      approved: true,
    };
    expect(
      await handleInternalMessage(answer, { id: ID, origin: 'https://evil.example' }, mocks),
    ).toBeNull();
    expect(mocks.resolveApproval).not.toHaveBeenCalled();

    await handleInternalMessage(answer, page, mocks);
    expect(mocks.resolveApproval).toHaveBeenCalledWith('approval-1', true);
  });

  it('only lets extension pages configure the MCP bridge', async () => {
    const mocks = deps();
    const configure = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'panel.mcp_configure',
      token: 'x',
    };
    expect(
      await handleInternalMessage(configure, { id: ID, origin: 'https://evil.example' }, mocks),
    ).toBeNull();
    expect(mocks.mcpConfigure).not.toHaveBeenCalled();
  });

  it('only gives screenshots to extension pages', async () => {
    const mocks = deps();
    const get = { protocolVersion: PROTOCOL_VERSION, type: 'panel.get_screenshot', id: 's1' };
    expect(
      await handleInternalMessage(get, { id: ID, origin: 'https://evil.example' }, mocks),
    ).toBeNull();
    expect(mocks.getScreenshot).not.toHaveBeenCalled();
    expect(await handleInternalMessage(get, page, mocks)).toMatchObject({
      type: 'panel.screenshot',
    });
  });

  it('ignores invalid messages', async () => {
    const mocks = deps();
    expect(
      await handleInternalMessage({ ...execute, command: { action: 'nope' } }, page, mocks),
    ).toBeNull();
  });
});
