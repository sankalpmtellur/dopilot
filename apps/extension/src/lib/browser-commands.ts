import {
  commandError,
  isRestrictedTabUrl,
  sanitizeTabTitle,
  sanitizeTabUrl,
  validateNavigationUrl,
} from '@dopilot/shared';
import type {
  BrowserCommand,
  CommandResult,
  CommandSource,
  TabInfo,
  TabTarget,
} from '@dopilot/shared';

type Tab = chrome.tabs.Tab;

/** The browser APIs commands may use. Everything else is out of reach. */
export interface BrowserApi {
  queryTabs(query: chrome.tabs.QueryInfo): Promise<Tab[]>;
  createTab(properties: { url?: string }): Promise<Tab>;
  getTab(tabId: number): Promise<Tab>;
  navigateTab(tabId: number, url: string): Promise<unknown>;
  activateTab(tabId: number): Promise<unknown>;
  focusWindow(windowId: number): Promise<unknown>;
  reload(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
}

export const chromeBrowserApi: BrowserApi = {
  queryTabs: (query) => chrome.tabs.query(query),
  createTab: (properties) => chrome.tabs.create(properties),
  getTab: (tabId) => chrome.tabs.get(tabId),
  navigateTab: (tabId, url) => chrome.tabs.update(tabId, { url }),
  activateTab: (tabId) => chrome.tabs.update(tabId, { active: true }),
  focusWindow: (windowId) => chrome.windows.update(windowId, { focused: true }),
  reload: (tabId) => chrome.tabs.reload(tabId),
  goBack: (tabId) => chrome.tabs.goBack(tabId),
  goForward: (tabId) => chrome.tabs.goForward(tabId),
  closeTab: (tabId) => chrome.tabs.remove(tabId),
};

export interface CommandContext {
  source: CommandSource;
  /** The website's own tab, which "current tab" must never mean for the website. */
  senderTabId?: number | undefined;
  /** The extension's own UI has already confirmed this action. */
  confirmed: boolean;
  /** Asks in extension-owned UI. Resolves to null when approved, or the reason it was not. */
  requestConfirmation?: (prompt: string) => Promise<CommandResult | null>;
}

export async function listTabs(api: BrowserApi): Promise<TabInfo[]> {
  // Normal windows only, so the confirmation popup is never listed or targeted.
  const tabs = await api.queryTabs({ windowType: 'normal' });
  return tabs
    .filter((tab): tab is Tab & { id: number } => tab.id !== undefined)
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
    .map((tab, index) => {
      const url = tab.url ? sanitizeTabUrl(tab.url) : undefined;
      return {
        id: tab.id,
        position: index + 1,
        active: tab.active,
        ...(tab.title && { title: sanitizeTabTitle(tab.title, tab.url) }),
        ...(url && { url }),
        restricted: tab.url ? isRestrictedTabUrl(tab.url) : false,
      };
    });
}

/**
 * The tab a command without a target acts on. In the side panel that is the active
 * tab. The website is always the active tab itself while being used, so there it
 * means the most recently used other tab.
 */
export async function findCurrentTabId(
  api: BrowserApi,
  source: CommandSource,
  senderTabId?: number,
): Promise<number | null> {
  if (source === 'panel') {
    // Normal windows only: the last focused window may be Dopilot's own approval popup.
    const [focused] = await api.queryTabs({
      active: true,
      lastFocusedWindow: true,
      windowType: 'normal',
    });
    if (focused?.id !== undefined) return focused.id;
    const active = await api.queryTabs({ active: true, windowType: 'normal' });
    active.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return active[0]?.id ?? null;
  }
  const tabs = await api.queryTabs({ windowType: 'normal' });
  const others = tabs
    .filter((tab) => tab.id !== undefined && tab.id !== senderTabId)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return others[0]?.id ?? null;
}

function tabLabel(tab: TabInfo): string {
  return tab.title ? `“${tab.title}”` : `tab ${tab.position}`;
}

function toFailure(error: unknown): CommandResult {
  const message = error instanceof Error ? error.message : '';
  if (/history/i.test(message)) return commandError('no_history', 'There is no page to go to.');
  if (/no tab with id/i.test(message)) return commandError('tab_not_found', 'That tab is gone.');
  return commandError('execution_failed', 'The browser could not complete that action.');
}

async function resolveTarget(
  api: BrowserApi,
  target: TabTarget | undefined,
  context: CommandContext,
): Promise<{ tab: TabInfo; tabs: TabInfo[] } | { failure: CommandResult }> {
  const tabs = await listTabs(api);
  let tab: TabInfo | undefined;

  if (!target) {
    const id = await findCurrentTabId(api, context.source, context.senderTabId);
    tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return { failure: commandError('no_target_tab', 'There is no tab to act on.') };
  } else {
    tab =
      'position' in target
        ? tabs[target.position - 1]
        : tabs.find((candidate) => candidate.id === target.tabId);
    if (!tab) return { failure: commandError('tab_not_found', 'That tab does not exist.') };
  }

  // Unknowable until the user allows tab details, since browsers hide the URL before then.
  if (tab.restricted) {
    return {
      failure: commandError(
        'restricted_page',
        'Dopilot cannot act on internal browser or extension pages.',
      ),
    };
  }
  return { tab, tabs };
}

export async function executeCommand(
  api: BrowserApi,
  command: BrowserCommand,
  context: CommandContext,
): Promise<CommandResult> {
  try {
    switch (command.action) {
      case 'tab.new': {
        await api.createTab({});
        return { ok: true, message: 'Opened a new tab.' };
      }

      case 'tab.open_url': {
        // Revalidated here: the caller may be a website, and its parser is not trusted.
        const validation = validateNavigationUrl(command.url);
        if (!validation.ok) return commandError('blocked_url', validation.reason);
        await api.createTab({ url: validation.url });
        return { ok: true, message: `Opened ${sanitizeTabUrl(validation.url)}` };
      }

      case 'tab.list': {
        const tabs = await listTabs(api);
        const count = tabs.length === 1 ? '1 open tab' : `${tabs.length} open tabs`;
        return { ok: true, message: `Found ${count}.`, tabs };
      }

      case 'tab.switch': {
        const resolved = await resolveTarget(api, command.target, context);
        if ('failure' in resolved) return resolved.failure;
        await api.activateTab(resolved.tab.id);
        const all = await api.queryTabs({ windowType: 'normal' });
        const windowId = all.find((tab) => tab.id === resolved.tab.id)?.windowId;
        if (windowId !== undefined) await api.focusWindow(windowId);
        return {
          ok: true,
          message: `Switched to ${tabLabel(resolved.tab)}.`,
          tab: { ...resolved.tab, active: true },
        };
      }

      case 'tab.reload': {
        const resolved = await resolveTarget(api, command.target, context);
        if ('failure' in resolved) return resolved.failure;
        await api.reload(resolved.tab.id);
        return { ok: true, message: `Reloaded ${tabLabel(resolved.tab)}.`, tab: resolved.tab };
      }

      case 'tab.back': {
        const resolved = await resolveTarget(api, command.target, context);
        if ('failure' in resolved) return resolved.failure;
        await api.goBack(resolved.tab.id);
        return { ok: true, message: `Went back in ${tabLabel(resolved.tab)}.`, tab: resolved.tab };
      }

      case 'tab.forward': {
        const resolved = await resolveTarget(api, command.target, context);
        if ('failure' in resolved) return resolved.failure;
        await api.goForward(resolved.tab.id);
        return {
          ok: true,
          message: `Went forward in ${tabLabel(resolved.tab)}.`,
          tab: resolved.tab,
        };
      }

      case 'tab.close': {
        const resolved = await resolveTarget(api, command.target, context);
        if ('failure' in resolved) return resolved.failure;

        if (!context.confirmed) {
          const prompt = `Close ${tabLabel(resolved.tab)}?`;
          if (!context.requestConfirmation) return commandError('confirmation_required', prompt);
          const refusal = await context.requestConfirmation(prompt);
          if (refusal) return refusal;
        }
        await api.closeTab(resolved.tab.id);
        return { ok: true, message: `Closed ${tabLabel(resolved.tab)}.` };
      }
    }
  } catch (error) {
    return toFailure(error);
  }
}
