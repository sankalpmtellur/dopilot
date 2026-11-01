// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@dopilot/shared';
import type { ExtensionState } from '@dopilot/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleApp } from './console-app';

type Message = { requestId: string; type: string; command?: unknown };

const state: ExtensionState = {
  extensionVersion: '1.2.3',
  tabDetailsAvailable: true,
  tabs: [
    { id: 1, position: 1, active: false, restricted: false, title: 'Docs', url: 'https://a.dev/' },
    { id: 2, position: 2, active: true, restricted: false, title: 'Dopilot' },
  ],
  currentTabId: 1,
  groq: {
    configured: true,
    maskedKey: 'gsk_••••••••1234',
    connection: { state: 'connected', checkedAt: 1 },
    models: [{ id: 'model-a' }],
    selectedModel: 'model-a',
  },
  agentStatus: 'idle',
  recentActions: [],
};

function stubExtension(current: ExtensionState = state) {
  const sendMessage = vi.fn(async (_id: string, message: Message) => {
    const base = { protocolVersion: PROTOCOL_VERSION, requestId: message.requestId };
    switch (message.type) {
      case 'external.get_state':
        return { ...base, type: 'external.state', state: current };
      case 'external.command':
        return {
          ...base,
          type: 'external.command_result',
          result: { ok: true, message: 'Opened a new tab.' },
        };
      default:
        return { ...base, type: 'external.ack' };
    }
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const waitForConnection = () => screen.findByText('Extension connected');

describe('without the extension', () => {
  it('says so and shows how to install it', async () => {
    render(<ConsoleApp />);
    expect((await screen.findAllByText('Extension not connected')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Set up Dopilot' })).toBeTruthy();
    expect(screen.getByText('apps/extension/dist')).toBeTruthy();
    expect(screen.getByText(/Connect the extension to see your open tabs/)).toBeTruthy();
  });

  it('reports a failure, not success, when a command cannot be delivered', async () => {
    render(<ConsoleApp />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'new tab{Enter}');
    expect(await screen.findByText(/isn’t connected, so nothing was done/)).toBeTruthy();
    expect(screen.queryByText('Opened a new tab.')).toBeNull();
  });

  it('keeps the microphone as a placeholder', () => {
    render(<ConsoleApp />);
    expect(
      (screen.getByRole('button', { name: /voice input, coming soon/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('with the extension', () => {
  it('shows connection, tabs and Groq status from the extension', async () => {
    stubExtension();
    render(<ConsoleApp />);
    expect(await screen.findByText('Extension connected')).toBeTruthy();
    expect(screen.getByText('Groq connected')).toBeTruthy();
    expect(screen.getByText('Open tabs (2)')).toBeTruthy();
    expect(screen.getAllByText('Docs').length).toBeGreaterThan(0);
    expect(screen.getByText('No browser actions yet.')).toBeTruthy();
  });

  it('sends typed commands over the bridge and shows the real result', async () => {
    const sendMessage = stubExtension();
    render(<ConsoleApp />);
    await screen.findByText('Extension connected');
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'new tab{Enter}');
    expect(await screen.findByText('Opened a new tab.')).toBeTruthy();
    const sent = sendMessage.mock.calls.map((call) => call[1]);
    expect(sent.find((message) => message.type === 'external.command')?.command).toEqual({
      action: 'tab.new',
    });
  });

  it('shows only the masked key, and has no key field in settings', async () => {
    stubExtension();
    render(<ConsoleApp />);
    await screen.findByText('Extension connected');
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    expect((await screen.findByTestId('web-masked-key')).textContent).toBe('gsk_••••••••1234');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(localStorage.length + document.cookie.length).toBe(0);
  });

  it('opens the extension’s own settings for key management', async () => {
    const sendMessage = stubExtension();
    render(<ConsoleApp />);
    await screen.findByText('Extension connected');
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await userEvent.click(await screen.findByRole('button', { name: /manage key in extension/i }));
    await waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => call[1].type)).toContain(
        'external.open_settings',
      ),
    );
  });

  it('notices when the extension disconnects', async () => {
    const sendMessage = stubExtension();
    render(<ConsoleApp />);
    await screen.findByText('Extension connected');

    sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    window.dispatchEvent(new Event('focus'));
    expect((await screen.findAllByText('Extension not connected')).length).toBeGreaterThan(0);
  });

  it('hides the setup guide once setup is finished, until asked for', async () => {
    const finished = {
      ...state,
      recentActions: [
        { id: '1', at: 0, source: 'panel' as const, summary: 'x', ok: true, detail: 'y' },
      ],
    };
    stubExtension(finished);
    render(<ConsoleApp />);
    await waitForConnection();
    expect(screen.queryByRole('heading', { name: 'Set up Dopilot' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Setup' }));
    expect(screen.getByRole('heading', { name: 'Set up Dopilot' })).toBeTruthy();
    expect(screen.getByText(/and connected/)).toBeTruthy();
  });

  it('remembers that the setup guide was dismissed', async () => {
    stubExtension();
    render(<ConsoleApp />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss setup guide' }));
    expect(screen.queryByRole('heading', { name: 'Set up Dopilot' })).toBeNull();
    expect(localStorage.getItem('dopilot.guideDismissed')).toBe('true');
  });
});
