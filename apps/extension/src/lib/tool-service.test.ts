import type { ToolAssessment, ToolContext } from '@dopilot/agent-core';
import { ToolResultSchema } from '@dopilot/shared';
import type { ContentRequest, DescribeResult, ElementFacts, ToolResult } from '@dopilot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApi } from './browser-commands';
import { NoPageAccessError } from './content-client';
import type { ContentPort } from './content-client';
import { createToolService } from './tool-service';
import type { PermissionPort } from './tool-service';

type Tab = chrome.tabs.Tab;

const context: ToolContext = {
  source: 'panel',
  currentTabId: 1,
  signal: new AbortController().signal,
};

function tab(id: number, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    index: id,
    windowId: 1,
    active: id === 1,
    status: 'complete',
    url: 'https://a.com/page',
    title: `Tab ${id}`,
    lastAccessed: id,
    ...extra,
  } as Tab;
}

function facts(element: Partial<ElementFacts> = {}): DescribeResult {
  return {
    element: {
      tag: 'button',
      role: 'button',
      name: 'Next',
      inputType: null,
      href: null,
      isSubmit: false,
      inForm: false,
      isSearchForm: false,
      isFileInput: false,
      isSecretField: false,
      isChallenge: false,
      ...element,
    },
    page: { url: 'https://a.com/page', title: 'A', headings: [], hasChallenge: false },
  };
}

let tabs: Tab[];
let api: BrowserApi & { [K in keyof BrowserApi]: ReturnType<typeof vi.fn> };
let content: ContentPort & { send: ReturnType<typeof vi.fn>; canAccess: ReturnType<typeof vi.fn> };
let permissions: PermissionPort & {
  hasTabDetails: ReturnType<typeof vi.fn>;
  hasOrigin: ReturnType<typeof vi.fn>;
  hasAllUrls: ReturnType<typeof vi.fn>;
};
let service: ReturnType<typeof createToolService>;

beforeEach(() => {
  tabs = [tab(1), tab(2, { url: 'https://github.com/x', title: 'GitHub' })];
  api = {
    queryTabs: vi.fn(async (query: chrome.tabs.QueryInfo) =>
      query.active ? tabs.filter((item) => item.active) : tabs,
    ),
    getTab: vi.fn(async (id: number) => {
      const found = tabs.find((item) => item.id === id);
      if (!found) throw new Error(`No tab with id: ${id}`);
      return found;
    }),
    createTab: vi.fn(async (properties: { url?: string }) => {
      const created = tab(9, { url: properties.url ?? 'chrome://newtab/' });
      tabs.push(created);
      return created;
    }),
    navigateTab: vi.fn(async () => undefined),
    activateTab: vi.fn(async () => undefined),
    focusWindow: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => undefined),
  } as never;
  content = {
    canAccess: vi.fn(async () => true),
    send: vi.fn(async (_tabId: number, request: ContentRequest): Promise<ToolResult> =>
      request.type === 'content.describe'
        ? { ok: true, summary: 'described', data: facts() }
        : { ok: true, summary: `${request.type} done` },
    ),
  };
  permissions = {
    hasTabDetails: vi.fn(async () => true),
    hasOrigin: vi.fn(async () => true),
    hasAllUrls: vi.fn(async () => false),
  };
  service = createToolService({ api, content, permissions, sleep: async () => undefined });
});

const assess = (name: string, args: Record<string, unknown> = {}, ctx = context) =>
  service.toolbox.assess(name, args, ctx);
const execute = async (name: string, args: Record<string, unknown> = {}, ctx = context) => {
  const result = await service.toolbox.execute(name, args, ctx);
  expect(ToolResultSchema.safeParse(result).success).toBe(true);
  return result;
};

function describeAs(element: Partial<ElementFacts>) {
  content.send.mockImplementation(async (_tabId: number, request: ContentRequest) =>
    request.type === 'content.describe'
      ? { ok: true, summary: 'described', data: facts(element) }
      : { ok: true, summary: 'done' },
  );
}

describe('permissions', () => {
  it('asks for site access, for exactly that origin', async () => {
    permissions.hasOrigin.mockResolvedValue(false);
    content.canAccess.mockResolvedValue(false);
    expect(await assess('get_visible_text')).toMatchObject({
      decision: 'approve',
      kind: 'site_access',
      origin: 'https://a.com',
      key: 'site:https://a.com',
    });
    expect(permissions.hasOrigin).toHaveBeenCalledWith('https://a.com');
  });

  it('uses access the browser already granted through activeTab', async () => {
    permissions.hasOrigin.mockResolvedValue(false);
    expect((await assess('get_visible_text')).decision).toBe('allow');
  });

  it('does not let screenshot access unlock every site', async () => {
    // With <all_urls> the browser would allow injecting anywhere, so that proves nothing.
    permissions.hasOrigin.mockResolvedValue(false);
    permissions.hasAllUrls.mockResolvedValue(true);
    content.canAccess.mockResolvedValue(true);
    expect(await assess('get_visible_text')).toMatchObject({
      decision: 'approve',
      kind: 'site_access',
      origin: 'https://a.com',
    });
  });

  it('asks for tab details when the address cannot be seen', async () => {
    tabs[0] = tab(1, { url: undefined as never, title: undefined as never });
    content.canAccess.mockResolvedValue(false);
    expect(await assess('get_visible_text')).toMatchObject({ kind: 'tab_details' });
  });

  it('asks for tab details once per run, so declining does not nag', async () => {
    permissions.hasTabDetails.mockResolvedValue(false);
    const run = { ...context, runId: 'run-1' };
    expect(await assess('get_tabs', {}, run)).toMatchObject({ kind: 'tab_details' });
    expect((await assess('get_tabs', {}, run)).decision).toBe('allow');
    const result = await execute('get_tabs', {}, run);
    expect(JSON.stringify(result)).toContain('has not allowed tab details');
  });

  it('reports a site with no access, rather than pretending', async () => {
    content.send.mockRejectedValue(new NoPageAccessError());
    expect(await execute('get_visible_text')).toMatchObject({
      ok: false,
      code: 'no_page_access',
    });
  });
});

describe('internal pages', () => {
  it.each([
    'chrome://settings/',
    'brave://wallet/',
    'chrome-extension://abc/x.html',
    'chrome://newtab/',
    'file:///etc/passwd',
  ])('never touches %s', async (url) => {
    tabs[0] = tab(1, { url });
    for (const name of ['get_page_content', 'get_interactive_elements']) {
      expect(await assess(name)).toMatchObject({
        decision: 'block',
        result: { code: 'restricted_page' },
      });
    }
    expect(content.canAccess).not.toHaveBeenCalled();
  });

  it.each([
    'chrome://settings',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'chrome-extension://abc/x',
  ])('will not navigate to %s', async (url) => {
    for (const name of ['navigate', 'open_tab']) {
      expect(await assess(name, { url })).toMatchObject({
        decision: 'block',
        result: { code: 'blocked_url' },
      });
      expect(await execute(name, { url })).toMatchObject({ code: 'blocked_url' });
    }
    expect(api.navigateTab).not.toHaveBeenCalled();
    expect(api.createTab).not.toHaveBeenCalled();
  });

  it('will not navigate away from Dopilot’s own pages or internal pages', async () => {
    for (const url of ['chrome-extension://abc/settings/index.html', 'chrome://settings/']) {
      tabs[0] = tab(1, { url });
      expect(await assess('navigate', { url: 'https://a.com' })).toMatchObject({
        decision: 'block',
        result: { code: 'restricted_page' },
      });
    }
  });

  it('can leave a blank new tab', async () => {
    tabs[0] = tab(1, { url: 'chrome://newtab/' });
    expect((await assess('navigate', { url: 'https://a.com' })).decision).toBe('allow');
  });

  it('refuses to reload an internal page, through the shared command code', async () => {
    tabs[0] = tab(1, { url: 'chrome://settings/' });
    expect(await execute('reload_tab')).toMatchObject({ ok: false, code: 'restricted_page' });
    expect(api.reload).not.toHaveBeenCalled();
  });
});

describe('approval is decided from the live page', () => {
  it('asks before clicking something sensitive, naming it', async () => {
    describeAs({ name: 'Delete repository' });
    const result = (await assess('click_element', { ref: 'ab.1' })) as Extract<
      ToolAssessment,
      { decision: 'approve' }
    >;
    expect(result).toMatchObject({ decision: 'approve', kind: 'action' });
    expect(result.title).toBe('Click “Delete repository”?');
    expect(result.detail).toContain('https://a.com');
  });

  it('allows ordinary clicks', async () => {
    expect((await assess('click_element', { ref: 'ab.1' })).decision).toBe('allow');
  });

  it('uses a different key when the element differs, so approval cannot carry over', async () => {
    describeAs({ name: 'Delete draft' });
    const first = (await assess('click_element', { ref: 'ab.1' })) as { key: string };
    describeAs({ name: 'Delete account' });
    const second = (await assess('click_element', { ref: 'ab.1' })) as { key: string };
    expect(first.key).not.toBe(second.key);
  });

  it('blocks secret fields, CAPTCHAs and stale refs before anything runs', async () => {
    describeAs({ isSecretField: true });
    expect(await assess('type_text', { ref: 'ab.1', text: 'x' })).toMatchObject({
      decision: 'block',
      result: { code: 'secret_field' },
    });

    describeAs({ isChallenge: true });
    expect(await assess('click_element', { ref: 'ab.1' })).toMatchObject({
      result: { code: 'security_challenge', stopTask: true },
    });

    content.send.mockResolvedValue({
      ok: false,
      code: 'stale_ref',
      message: 'Gone.',
      recoverable: true,
    });
    expect(await assess('click_element', { ref: 'ab.1' })).toMatchObject({
      decision: 'block',
      result: { code: 'stale_ref' },
    });
  });

  it('checks Enter against the focused element when no ref is given', async () => {
    describeAs({ name: 'Message', role: 'textbox', inForm: true });
    expect(await assess('press_key', { key: 'Enter' })).toMatchObject({ decision: 'approve' });
    const described = content.send.mock.calls[0]?.[1];
    expect(described).toEqual({ type: 'content.describe' });
  });

  it('always asks before closing a tab', async () => {
    expect(await assess('close_tab')).toMatchObject({ decision: 'approve' });
  });
});

describe('executing tools', () => {
  it('opens a tab, waits for it and makes it current', async () => {
    const result = await execute('open_tab', { url: 'https://youtube.com' });
    expect(api.createTab).toHaveBeenCalledWith({ url: 'https://youtube.com/' });
    expect(result).toMatchObject({ ok: true, currentTabId: 9, pageChanged: true });
  });

  it('waits for navigation to finish before reporting', async () => {
    tabs[0] = tab(1, { status: 'loading' });
    const loading = api.getTab.getMockImplementation() as (id: number) => Promise<Tab>;
    let polls = 0;
    api.getTab.mockImplementation(async (id: number) => {
      polls += 1;
      if (polls === 3 && tabs[0]) tabs[0] = tab(1);
      return loading?.(id);
    });
    await execute('navigate', { url: 'https://a.com/next' });
    expect(api.navigateTab).toHaveBeenCalledWith(1, 'https://a.com/next');
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('stops waiting on a page that never finishes loading', async () => {
    tabs[0] = tab(1, { status: 'loading' });
    const slow = createToolService({
      api,
      content,
      permissions,
      sleep: () => new Promise((done) => setTimeout(done, 1)),
      loadTimeoutMs: 10,
    });
    const result = await slow.toolbox.execute('navigate', { url: 'https://a.com/' }, context);
    expect(result.ok).toBe(true);
  });

  it('switches to the requested tab and makes it current', async () => {
    const result = await execute('switch_tab', { tabId: 2 });
    expect(api.activateTab).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({ ok: true, currentTabId: 2, data: { title: 'GitHub' } });
  });

  it('reports a tab that is gone', async () => {
    expect(await execute('switch_tab', { tabId: 77 })).toMatchObject({ ok: false });
  });

  it('lists tabs for the model as untrusted, without query strings', async () => {
    tabs[0] = tab(1, { url: 'https://a.com/x?token=secret', title: 'a.com/x?token=secret' });
    const result = await execute('get_tabs');
    expect(result).toMatchObject({ ok: true, untrusted: true });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('runs page tools in the current tab, or an explicit one', async () => {
    await execute('click_element', { ref: 'ab.1' }, { ...context, currentTabId: 2 });
    expect(content.send).toHaveBeenLastCalledWith(2, { type: 'content.click', ref: 'ab.1' });
    await execute('get_visible_text', { tabId: 1 }, { ...context, currentTabId: 2 });
    expect(content.send.mock.lastCall?.[0]).toBe(1);
  });

  it('limits how much of a page is read', async () => {
    await execute('get_page_content');
    expect(content.send.mock.lastCall?.[1]).toMatchObject({ maxChars: 3000 });
  });

  it('treats a click that navigates away as done, and looks at the new page', async () => {
    content.send.mockRejectedValue(new Error('message channel closed'));
    const result = await execute('click_element', { ref: 'ab.1' });
    expect(result).toMatchObject({ ok: true, pageChanged: true, data: { tabId: 1 } });
  });

  it('does not treat a lost reply to anything else as success', async () => {
    content.send.mockRejectedValue(new Error('message channel closed'));
    expect(await execute('get_visible_text')).toMatchObject({ ok: false, code: 'page_changed' });
  });

  it('falls back to the active tab if the current one has closed', async () => {
    await execute('get_visible_text', {}, { ...context, currentTabId: 55 });
    expect(content.send.mock.lastCall?.[0]).toBe(1);
  });

  it('never returns raw browser errors', async () => {
    api.createTab.mockRejectedValue(new Error('internal secret detail'));
    const result = await execute('open_tab');
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});

describe('calls from MCP', () => {
  it('runs allowed tools', async () => {
    expect(await service.runExternalCall('get_tabs', {})).toMatchObject({ ok: true });
    expect(await service.runExternalCall('open_tab', { url: 'https://a.com' })).toMatchObject({
      ok: true,
      currentTabId: 9,
    });
  });

  it('applies the same validation', async () => {
    expect(await service.runExternalCall('run_javascript', { code: 'x' })).toMatchObject({
      code: 'invalid_arguments',
    });
    expect(await service.runExternalCall('navigate', { url: 'chrome://settings' })).toMatchObject({
      code: 'blocked_url',
    });
  });

  it('refuses anything that needs approval, and never runs it', async () => {
    expect(await service.runExternalCall('close_tab', {})).toMatchObject({
      code: 'approval_required',
    });
    expect(api.closeTab).not.toHaveBeenCalled();

    describeAs({ name: 'Buy now' });
    expect(await service.runExternalCall('click_element', { ref: 'ab.1' })).toMatchObject({
      code: 'approval_required',
    });
    expect(content.send.mock.calls.every((call) => call[1].type === 'content.describe')).toBe(true);
  });

  it('cannot reach a site the user has not authorized', async () => {
    permissions.hasOrigin.mockResolvedValue(false);
    content.canAccess.mockResolvedValue(false);
    expect(await service.runExternalCall('get_page_content', {})).toMatchObject({
      code: 'approval_required',
    });
    expect(content.send).not.toHaveBeenCalled();
  });
});

describe('the tab showing Dopilot’s website', () => {
  const website: ToolContext = {
    source: 'website',
    currentTabId: null,
    protectedTabId: 2,
    signal: new AbortController().signal,
  };

  it('is never chosen as the current tab, even when it is the most recent', async () => {
    tabs[0] = tab(1, { lastAccessed: 1 });
    tabs[1] = tab(2, { lastAccessed: 99, active: true });
    const { currentTabId, text } = await service.toolbox.describeContext('website', 2);
    expect(currentTabId).toBe(1);
    expect(text).toContain('Tab 2 shows Dopilot itself');

    await execute('navigate', { url: 'https://a.com/next' }, website);
    expect(api.navigateTab).toHaveBeenCalledWith(1, 'https://a.com/next');
  });

  it('cannot be targeted directly by the model', async () => {
    for (const name of ['navigate', 'close_tab', 'get_page_content', 'reload_tab']) {
      expect(await assess(name, { tabId: 2, url: 'https://a.com' }, website)).toMatchObject({
        decision: 'block',
        result: { code: 'dopilot_tab' },
      });
    }
  });

  it('leaves the model to open a tab when the website is the only one', async () => {
    tabs = [tab(2)];
    const { currentTabId, text } = await service.toolbox.describeContext('website', 2);
    expect(currentTabId).toBeNull();
    expect(text).toContain('open one if needed');
    expect(await execute('navigate', { url: 'https://a.com' }, website)).toMatchObject({
      code: 'no_target_tab',
    });
    expect(api.navigateTab).not.toHaveBeenCalled();
  });
});

describe('describeContext', () => {
  it('gives the model the current tab, concisely', async () => {
    const { text, currentTabId } = await service.toolbox.describeContext('panel');
    expect(currentTabId).toBe(1);
    expect(text).toContain('Tab 1');
    expect(text).toContain('2 tabs open');
    expect(text.length).toBeLessThan(300);
  });

  it('never treats the website itself as the current tab', async () => {
    tabs[0] = tab(1, { active: false, lastAccessed: 5 });
    tabs[1] = tab(2, { active: false, lastAccessed: 3 });
    const { currentTabId } = await service.toolbox.describeContext('website');
    expect([1, 2]).toContain(currentTabId);
  });
});
