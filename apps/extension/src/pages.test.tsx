// @vitest-environment jsdom
import { DEFAULT_PREFERENCES, PROTOCOL_VERSION } from '@dopilot/shared';
import type { ExtensionState, GroqStatus, PanelRequest } from '@dopilot/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGroqStatus } from '@/lib/api-key-store';
import { SettingsForm } from '@/settings/settings-form';
import { App } from '@/sidepanel/app';

const KEY = 'gsk_abcdefghijklmnopqrstuvwxyz1234';

const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

let sent: unknown[];
let local: Map<string, unknown>;
let handler: (message: PanelRequest) => unknown;

const groq: GroqStatus = {
  configured: false,
  maskedKey: null,
  connection: { state: 'untested', checkedAt: null },
  models: [],
  selectedModel: null,
  visionModels: [],
  selectedVisionModel: null,
  visionFallback: 'qwen/qwen3.8-27b',
  speechModels: [],
};

const state: ExtensionState = {
  extensionVersion: '1.0.0',
  tabDetailsAvailable: true,
  tabs: [
    { id: 7, position: 1, active: true, restricted: false, title: 'Docs', url: 'https://a.dev/x' },
  ],
  currentTabId: 7,
  groq,
  agent: null,
  preferences: DEFAULT_PREFERENCES,
  recentActions: [],
};

beforeEach(() => {
  sent = [];
  local = new Map();
  handler = (message) =>
    message.type === 'panel.get_state'
      ? { protocolVersion: PROTOCOL_VERSION, type: 'panel.state', state }
      : { protocolVersion: PROTOCOL_VERSION, type: 'panel.ack' };

  const area = {
    get: async (key: string) => (local.has(key) ? { [key]: local.get(key) } : {}),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) local.set(key, value);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) local.delete(key);
    },
  };

  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (message: PanelRequest) => {
        sent.push(message);
        return handler(message);
      }),
    },
    storage: { local: area, session: area, onChanged: event() },
    tabs: {
      onActivated: event(),
      onCreated: event(),
      onRemoved: event(),
      onUpdated: event(),
      onMoved: event(),
    },
    windows: { onFocusChanged: event() },
    permissions: {
      onAdded: event(),
      onRemoved: event(),
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      getAll: vi.fn(async () => ({
        origins: ['https://api.groq.com/*', 'https://en.wikipedia.org/*'],
      })),
      remove: vi.fn(async () => true),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('side panel', () => {
  it('renders the current tab, Groq status and controls', async () => {
    render(<App />);
    expect((await screen.findAllByText('Docs')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('a.dev').length).toBeGreaterThan(0);
    expect(screen.getByText('No Groq key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Speak a command' })).toBeTruthy();
    expect(screen.getByText(/Nothing has been run yet/)).toBeTruthy();
  });

  it('runs a typed command through the worker and shows the real result', async () => {
    handler = (message) =>
      message.type === 'panel.execute'
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: 'panel.command_result',
            result: { ok: true, message: 'Opened a new tab.' },
          }
        : { protocolVersion: PROTOCOL_VERSION, type: 'panel.state', state };

    render(<App />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'new tab{Enter}');
    expect(await screen.findByText('Opened a new tab.')).toBeTruthy();
    expect(sent).toContainEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: 'panel.execute',
      command: { action: 'tab.new' },
      confirmed: false,
    });
  });

  it('reports when the worker cannot be reached', async () => {
    handler = () => {
      throw new Error('Could not establish connection');
    };
    render(<App />);
    expect(await screen.findByText('Extension error')).toBeTruthy();
  });

  it('opens settings', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Groq API key')).toBeTruthy();
  });
});

describe('side panel voice', () => {
  it('explains when voice needs turning on, and text still works', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Speak a command' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/allow sending voice to Groq/);
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Command' })).toBeTruthy();
  });
});

describe('side panel agent', () => {
  const run: NonNullable<ExtensionState['agent']> = {
    id: 'run-1',
    instruction: 'Delete my draft',
    source: 'panel',
    status: 'waiting_for_approval',
    notice: null,
    model: 'model-a',
    startedAt: 0,
    finishedAt: null,
    actionCount: 1,
    readPageContent: false,
    maxActions: 15,
    timeline: [],
    approval: { id: 'a1', kind: 'action', title: 'Click “Delete”?', detail: 'Deletes it.' },
    summary: null,
    error: null,
  };

  function withRun(agent: ExtensionState['agent']) {
    handler = (message) =>
      message.type === 'panel.get_state'
        ? { protocolVersion: PROTOCOL_VERSION, type: 'panel.state', state: { ...state, agent } }
        : { protocolVersion: PROTOCOL_VERSION, type: 'panel.ack' };
  }

  it('sends natural language to the agent', async () => {
    handler = (message) =>
      message.type === 'panel.start_agent'
        ? { protocolVersion: PROTOCOL_VERSION, type: 'panel.agent_started', error: null }
        : { protocolVersion: PROTOCOL_VERSION, type: 'panel.state', state };
    render(<App />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Command' }), 'Open YouTube.{Enter}');
    await waitFor(() =>
      expect(sent).toContainEqual({
        protocolVersion: PROTOCOL_VERSION,
        type: 'panel.start_agent',
        instruction: 'Open YouTube.',
      }),
    );
  });

  it('answers approvals from the panel', async () => {
    withRun(run);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        protocolVersion: PROTOCOL_VERSION,
        type: 'panel.resolve_approval',
        id: 'a1',
        approved: true,
      }),
    );
  });

  it('asks the browser for exactly the requested site', async () => {
    withRun({
      ...run,
      approval: {
        id: 'a2',
        kind: 'site_access',
        title: 'Allow Dopilot on a.com?',
        detail: 'Needed.',
        origin: 'https://a.com',
      },
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://a.com/*'] });
    await waitFor(() => expect(local.get('authorizedSites')).toEqual(['https://a.com']));
  });

  it('shows the screenshot that would be sent, and asks for broad access only when clicked', async () => {
    handler = (message) =>
      message.type === 'panel.get_state'
        ? {
            protocolVersion: PROTOCOL_VERSION,
            type: 'panel.state',
            state: {
              ...state,
              agent: {
                ...run,
                approval: {
                  id: 'a4',
                  kind: 'screenshot',
                  title: 'Send a screenshot of a.com to Groq?',
                  detail: 'Groq will process this image.',
                  screenshotId: 's1',
                },
              },
            },
          }
        : message.type === 'panel.get_screenshot'
          ? {
              protocolVersion: PROTOCOL_VERSION,
              type: 'panel.screenshot',
              dataUrl: 'data:image/jpeg;base64,/9j/',
            }
          : { protocolVersion: PROTOCOL_VERSION, type: 'panel.ack' };
    render(<App />);
    expect(await screen.findByAltText('The screenshot that would be sent')).toBeTruthy();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it('counts a refused browser permission as declining', async () => {
    vi.mocked(chrome.permissions.request).mockResolvedValue(false as never);
    withRun({
      ...run,
      approval: { id: 'a3', kind: 'tab_details', title: 'Tabs?', detail: 'Needed.' },
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        protocolVersion: PROTOCOL_VERSION,
        type: 'panel.resolve_approval',
        id: 'a3',
        approved: false,
      }),
    );
  });

  it('has a prominent stop button during a task', async () => {
    withRun({ ...run, status: 'executing', approval: null });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop task' }));
    await waitFor(() =>
      expect(sent).toContainEqual({ protocolVersion: PROTOCOL_VERSION, type: 'panel.stop_agent' }),
    );
  });
});

describe('settings', () => {
  async function saveKey() {
    await userEvent.type(await screen.findByLabelText('Your key'), KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByLabelText('Replace key');
  }

  it('saves to extension storage, clears the field and shows only a mask', async () => {
    render(<SettingsForm />);
    await saveKey();

    expect(local.get('groqApiKey')).toBe(KEY);
    expect(screen.getByTestId('masked-key').textContent).toBe('gsk_••••••••1234');
    expect((screen.getByLabelText('Replace key') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('never puts the key in a message', async () => {
    render(<SettingsForm />);
    await saveKey();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(JSON.stringify(sent)).not.toContain(KEY);
  });

  it('shows why a key failed its test', async () => {
    handler = () => ({
      protocolVersion: PROTOCOL_VERSION,
      type: 'panel.groq_status',
      groq: {
        ...groq,
        configured: true,
        maskedKey: 'gsk_••••••••1234',
        connection: { state: 'rate_limited', checkedAt: 1, retryAfterSeconds: 30 },
      },
    });
    render(<SettingsForm />);
    await saveKey();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((await screen.findByTestId('groq-status')).textContent).toContain('Try again in 30s');
  });

  it('requires a second click to remove', async () => {
    render(<SettingsForm />);
    await saveKey();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(local.has('groqApiKey')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await screen.findByLabelText('Your key');
    expect(local.has('groqApiKey')).toBe(false);
    expect((await loadGroqStatus()).configured).toBe(false);
  });

  it('rejects a malformed key and keeps nothing', async () => {
    render(<SettingsForm />);
    await userEvent.type(await screen.findByLabelText('Your key'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not look like/);
    expect(local.has('groqApiKey')).toBe(false);
  });

  it('lists authorized sites and lets you remove them, hiding Groq itself', async () => {
    render(<SettingsForm />);
    expect(await screen.findByText('https://en.wikipedia.org')).toBeTruthy();
    expect(screen.queryByText('https://api.groq.com')).toBeNull();
    const row = screen.getByText('https://en.wikipedia.org').closest('li') as HTMLElement;
    await userEvent.click(row.querySelector('button') as HTMLElement);
    await waitFor(() =>
      expect(chrome.permissions.remove).toHaveBeenCalledWith({
        origins: ['https://en.wikipedia.org/*'],
      }),
    );
  });

  it('leaves voice through Groq off until asked', async () => {
    render(<SettingsForm />);
    const toggle = (await screen.findByLabelText(
      'Allow sending my voice to Groq',
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await userEvent.click(toggle);
    await waitFor(() => expect(local.get('preferences')).toMatchObject({ speechFallback: true }));
  });

  it('can turn vision off, and choose a fallback model', async () => {
    render(<SettingsForm />);
    const toggle = await screen.findByLabelText('Let Dopilot use screenshots when it needs to see');
    await userEvent.click(toggle);
    await waitFor(() => expect(local.get('preferences')).toMatchObject({ vision: false }));

    const fallback = (await screen.findByLabelText('Fallback vision model')) as HTMLInputElement;
    expect(fallback.value).toBe('qwen/qwen3.8-27b');
    await userEvent.clear(fallback);
    await userEvent.type(fallback, 'other/model');
    await userEvent.tab();
    await waitFor(() =>
      expect(local.get('groqSettings')).toMatchObject({ visionFallback: 'other/model' }),
    );
  });

  it('offers automatic model choice', async () => {
    render(<SettingsForm />);
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    expect(select.options[0]?.textContent).toMatch(/automatic/i);
  });

  it('asks for tab details only when clicked', async () => {
    render(<SettingsForm />);
    const allow = await screen.findByRole('button', { name: 'Allow tab details' });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    await userEvent.click(allow);
    expect(chrome.permissions.request).toHaveBeenCalledWith({ permissions: ['tabs'] });
  });
});

describe('side panel first run', () => {
  it('explains itself, offers key setup, and marks what needs a key', async () => {
    render(<App />);
    expect(await screen.findByText('Welcome to Dopilot')).toBeTruthy();
    expect(await screen.findByLabelText('Your key')).toBeTruthy();
    expect(screen.getByText('What Dopilot asks permission for')).toBeTruthy();
    expect(screen.getAllByText('Needs a key').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Summarize/ }).hasAttribute('disabled')).toBe(true);
  });

  it('has a clear button, which does nothing until there is something to clear', async () => {
    render(<App />);
    const clear = await screen.findByRole('button', { name: 'Clear conversation' });
    expect(clear.hasAttribute('disabled')).toBe(true);
  });
});
