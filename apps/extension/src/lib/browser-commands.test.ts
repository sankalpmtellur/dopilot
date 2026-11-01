import { CommandResultSchema } from '@dopilot/shared';
import type { BrowserCommand } from '@dopilot/shared';
import { describe, expect, it, vi } from 'vitest';
import { executeCommand, findCurrentTabId, listTabs } from './browser-commands';
import type { BrowserApi, CommandContext } from './browser-commands';

type Tab = chrome.tabs.Tab;

function tab(id: number, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    index: id,
    windowId: 1,
    active: false,
    lastAccessed: id,
    ...extra,
  } as Tab;
}

function fakeApi(tabs: Tab[]) {
  return {
    queryTabs: vi.fn(async (query: chrome.tabs.QueryInfo) =>
      query.active ? tabs.filter((item) => item.active) : tabs,
    ),
    createTab: vi.fn(async () => tab(99)),
    getTab: vi.fn(async (id: number) => tab(id)),
    navigateTab: vi.fn(async () => undefined),
    activateTab: vi.fn(async () => undefined),
    focusWindow: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => undefined),
  } satisfies BrowserApi;
}

const panel: CommandContext = { source: 'panel', confirmed: false };

async function run(api: BrowserApi, command: BrowserCommand, context = panel) {
  const result = await executeCommand(api, command, context);
  // Every outcome must match the structured contract the UIs depend on.
  expect(CommandResultSchema.safeParse(result).success).toBe(true);
  return result;
}

describe('tab creation and navigation', () => {
  it('opens a new tab', async () => {
    const api = fakeApi([]);
    expect(await run(api, { action: 'tab.new' })).toMatchObject({ ok: true });
    expect(api.createTab).toHaveBeenCalledWith({});
  });

  it('opens a validated URL', async () => {
    const api = fakeApi([]);
    await run(api, { action: 'tab.open_url', url: 'https://youtube.com' });
    expect(api.createTab).toHaveBeenCalledWith({ url: 'https://youtube.com/' });
  });

  it.each(['javascript:alert(1)', 'chrome://settings', 'chrome-extension://abc/a.html'])(
    'revalidates and refuses %s',
    async (url) => {
      const api = fakeApi([]);
      expect(await run(api, { action: 'tab.open_url', url })).toMatchObject({
        ok: false,
        code: 'blocked_url',
      });
      expect(api.createTab).not.toHaveBeenCalled();
    },
  );

  it('reloads and navigates the active tab from the side panel', async () => {
    const api = fakeApi([tab(1), tab(2, { active: true })]);
    await run(api, { action: 'tab.reload' });
    await run(api, { action: 'tab.back' });
    await run(api, { action: 'tab.forward' });
    expect(api.reload).toHaveBeenCalledWith(2);
    expect(api.goBack).toHaveBeenCalledWith(2);
    expect(api.goForward).toHaveBeenCalledWith(2);
  });

  it('reports when there is no history', async () => {
    const api = fakeApi([tab(1, { active: true })]);
    api.goBack.mockRejectedValue(new Error('Cannot find a next page in history.'));
    expect(await run(api, { action: 'tab.back' })).toMatchObject({ ok: false, code: 'no_history' });
  });

  it('never returns raw browser error text', async () => {
    const api = fakeApi([tab(1, { active: true })]);
    api.reload.mockRejectedValue(new Error('internal detail'));
    const result = await run(api, { action: 'tab.reload' });
    expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
    expect(JSON.stringify(result)).not.toContain('internal detail');
  });
});

describe('tab listing and switching', () => {
  it('orders tabs and removes query strings', async () => {
    const api = fakeApi([
      tab(2, { windowId: 2, index: 0 }),
      tab(1, { index: 0, title: 'Mail', url: 'https://mail.example/inbox?token=secret#x' }),
    ]);
    const tabs = await listTabs(api);
    expect(tabs.map((item) => item.id)).toEqual([1, 2]);
    expect(tabs[0]).toMatchObject({
      position: 1,
      title: 'Mail',
      url: 'https://mail.example/inbox',
    });
    expect(JSON.stringify(tabs)).not.toContain('secret');
  });

  it('keeps tokens out of titles made from the address', async () => {
    const api = fakeApi([
      tab(1, { title: 'a.com/x?token=secret', url: 'https://a.com/x?token=secret' }),
    ]);
    expect(JSON.stringify(await listTabs(api))).not.toContain('secret');
  });

  it('only looks at normal windows, so the confirmation popup is never a target', async () => {
    const api = fakeApi([tab(1)]);
    await listTabs(api);
    await findCurrentTabId(api, 'website', 2);
    for (const [query] of api.queryTabs.mock.calls) expect(query.windowType).toBe('normal');
  });

  it('works without tab details, which need an optional permission', async () => {
    const result = await run(fakeApi([tab(1)]), { action: 'tab.list' });
    expect(result).toMatchObject({ ok: true, tabs: [{ id: 1, restricted: false }] });
  });

  it('switches by position and focuses its window', async () => {
    const api = fakeApi([tab(1), tab(2, { windowId: 7 })]);
    await run(api, { action: 'tab.switch', target: { position: 2 } });
    expect(api.activateTab).toHaveBeenCalledWith(2);
    expect(api.focusWindow).toHaveBeenCalledWith(7);
  });

  it('reports a tab that does not exist', async () => {
    const api = fakeApi([tab(1)]);
    const result = await run(api, { action: 'tab.switch', target: { position: 9 } });
    expect(result).toMatchObject({ ok: false, code: 'tab_not_found' });
    expect(api.activateTab).not.toHaveBeenCalled();
  });
});

describe('restricted pages', () => {
  const settings = tab(1, { active: true, url: 'chrome://settings/', title: 'Settings' });

  it.each<BrowserCommand>([
    { action: 'tab.reload' },
    { action: 'tab.back' },
    { action: 'tab.forward' },
    { action: 'tab.close' },
    { action: 'tab.switch', target: { tabId: 1 } },
  ])('blocks $action', async (command) => {
    const api = fakeApi([settings]);
    expect(await run(api, command)).toMatchObject({ ok: false, code: 'restricted_page' });
    expect(api.closeTab).not.toHaveBeenCalled();
    expect(api.reload).not.toHaveBeenCalled();
  });

  it('hides internal addresses from tab lists', async () => {
    const [info] = await listTabs(fakeApi([settings]));
    expect(info).toMatchObject({ restricted: true });
    expect(info?.url).toBeUndefined();
  });

  it('treats blank new tabs as ordinary tabs', async () => {
    const api = fakeApi([tab(1, { active: true, url: 'chrome://newtab/' })]);
    await run(api, { action: 'tab.close' }, { ...panel, confirmed: true });
    expect(api.closeTab).toHaveBeenCalledWith(1);
  });
});

describe('closing tabs', () => {
  it('asks the panel to confirm, naming the tab', async () => {
    const api = fakeApi([tab(1, { active: true, title: 'Mail' })]);
    expect(await run(api, { action: 'tab.close' })).toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'Close “Mail”?',
    });
    expect(api.closeTab).not.toHaveBeenCalled();
  });

  it('closes once confirmed by the panel', async () => {
    const api = fakeApi([tab(1, { active: true })]);
    const result = await run(api, { action: 'tab.close' }, { ...panel, confirmed: true });
    expect(result).toMatchObject({ ok: true });
    expect(api.closeTab).toHaveBeenCalledWith(1);
  });

  it('waits for extension-owned confirmation for website requests', async () => {
    const api = fakeApi([tab(1), tab(2)]);
    const context: CommandContext = {
      source: 'website',
      senderTabId: 2,
      confirmed: false,
      requestConfirmation: async () => null,
    };
    await run(api, { action: 'tab.close' }, context);
    expect(api.closeTab).toHaveBeenCalledWith(1);
  });

  it('does not close when the user declines', async () => {
    const api = fakeApi([tab(1)]);
    const refusal = { ok: false, code: 'confirmation_denied', message: 'Cancelled.' } as const;
    const context: CommandContext = {
      source: 'website',
      confirmed: false,
      requestConfirmation: async () => refusal,
    };
    expect(await run(api, { action: 'tab.close' }, context)).toEqual(refusal);
    expect(api.closeTab).not.toHaveBeenCalled();
  });
});

describe('findCurrentTabId', () => {
  it('uses the most recently used other tab for the website', async () => {
    const api = fakeApi([
      tab(1, { lastAccessed: 100 }),
      tab(2, { lastAccessed: 300, active: true }),
      tab(3, { lastAccessed: 200 }),
    ]);
    expect(await findCurrentTabId(api, 'website', 2)).toBe(3);
  });

  it('finds nothing when the website is the only tab', async () => {
    expect(await findCurrentTabId(fakeApi([tab(2)]), 'website', 2)).toBeNull();
  });
});
