import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationManager } from './confirmations';

function setup() {
  const ui = { open: vi.fn(async () => 42), close: vi.fn(async () => undefined) };
  let next = 0;
  const manager = new ConfirmationManager(ui, 1000, () => `id-${++next}`);
  return { ui, manager };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { getPlatformInfo: vi.fn() } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ConfirmationManager', () => {
  it('resolves with the user’s decision and closes the window', async () => {
    const { ui, manager } = setup();
    const outcome = manager.request('Close tab?', 'r1');
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getPrompt('id-1')).toBe('Close tab?');
    manager.decide('id-1', true);

    expect(await outcome).toBe('approved');
    expect(ui.close).toHaveBeenCalledWith(42);
    expect(manager.getPrompt('id-1')).toBeNull();
  });

  it('ignores decisions for an unknown confirmation', async () => {
    const { manager } = setup();
    const outcome = manager.request('Close tab?', 'r1');
    await vi.advanceTimersByTimeAsync(0);
    manager.decide('forged', true);
    expect(manager.busy).toBe(true);
    manager.decide('id-1', false);
    expect(await outcome).toBe('denied');
  });

  it('times out when nobody answers', async () => {
    const { manager } = setup();
    const outcome = manager.request('Close tab?', 'r1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe('timeout');
  });

  it('treats closing the window as declining', async () => {
    const { manager } = setup();
    const outcome = manager.request('Close tab?', 'r1');
    await vi.advanceTimersByTimeAsync(0);
    manager.handleWindowClosed(42);
    expect(await outcome).toBe('denied');
  });

  it('can be cancelled by the original request only', async () => {
    const { manager } = setup();
    const outcome = manager.request('Close tab?', 'r1');
    await vi.advanceTimersByTimeAsync(0);
    manager.cancelRequest('other');
    expect(manager.busy).toBe(true);
    manager.cancelRequest('r1');
    expect(await outcome).toBe('cancelled');
  });
});
