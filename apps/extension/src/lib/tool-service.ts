import type { AgentToolbox, ToolAssessment, ToolContext } from '@dopilot/agent-core';
import {
  assessToolCall,
  needsPageFacts,
  toolSpecs,
  validateToolCall,
} from '@dopilot/browser-tools';
import type { PolicyContext, PolicyDecision } from '@dopilot/browser-tools';
import { wrapUntrustedContent } from '@dopilot/agent-core';
import {
  DescribeResultSchema,
  isRestrictedTabUrl,
  MAX_TABS_PER_REQUEST,
  parseSimpleInstruction,
  sanitizeTabTitle,
  sanitizeTabUrl,
  siteSearchUrl,
  toolFailure,
  validateNavigationUrl,
} from '@dopilot/shared';
import type {
  AgentSource,
  BrowserCommand,
  ContentRequest,
  DescribeResult,
  ToolResult,
} from '@dopilot/shared';
import { executeCommand, findCurrentTabId, listTabs } from './browser-commands';
import type { BrowserApi } from './browser-commands';
import { ErrorPageError, NoPageAccessError, PageBusyError } from './content-client';
import type { ContentPort } from './content-client';
import type { VisionService } from './vision-service';

const PAGE_CONTENT_CHARS = 3000;
const VISIBLE_TEXT_CHARS = 2000;
const INTERACTIVE_LIMIT = 40;
const DEFAULT_WAIT_SECONDS = 5;
const LOAD_TIMEOUT_MS = 15_000;
const LOAD_POLL_MS = 150;
const CONTEXT_TAB_LIMIT = 15;
const READ_RETRY_MS = 400;
/** Waiting for a page to load comes on top of the time the action itself takes. */
const NAVIGATION_TOOL_TIMEOUT_MS = LOAD_TIMEOUT_MS + 10_000;
const WAIT_MARGIN_MS = 8000;
const VISION_TOOL_TIMEOUT_MS = 70_000;
const EXTERNAL_CALL_TIMEOUT_MS = 50_000;
/** Time for the browser to breathe between tabs, so a batch never freezes it. */
const BATCH_PACE_MS = 30;
/** Pages loading at once in a batch. Twenty at once would stall the machine. */
const BATCH_MAX_LOADING = 4;
const BATCH_LOADING_WAIT_MS = 4000;
/** After this many refusals in a row the browser is saying no, so asking again is pointless. */
const BATCH_MAX_CONSECUTIVE_FAILURES = 3;
const BATCH_TOOL_TIMEOUT_MS = 120_000;

export interface PermissionPort {
  hasTabDetails(): Promise<boolean>;
  hasOrigin(origin: string): Promise<boolean>;
  /** With this, the browser allows every site, so being able to inject proves nothing. */
  hasAllUrls(): Promise<boolean>;
}

export interface ToolServiceDeps {
  api: BrowserApi;
  content: ContentPort;
  permissions: PermissionPort;
  sleep?: (ms: number) => Promise<void>;
  loadTimeoutMs?: number;
  vision?: VisionService;
  /** True for tabs showing Dopilot's website, wherever a task was started from. */
  isDopilotTab?: (tabId: number, url: string | undefined) => boolean;
  /** MCP must not fight a running task for the same tabs. */
  isAgentBusy?: () => Promise<boolean>;
}

/** Tools that read or act inside a page, and so need access to that page's site. */
const PAGE_TOOLS = new Set([
  'get_page_metadata',
  'get_page_content',
  'get_visible_text',
  'get_interactive_elements',
  'click_element',
  'type_text',
  'clear_input',
  'select_option',
  'scroll_page',
  'press_key',
  'wait_for_element',
  'capture_visible_tab',
  'analyze_screenshot',
  'get_visual_page_context',
]);

const CAPTURE_TOOLS = new Set([
  'capture_visible_tab',
  'analyze_screenshot',
  'get_visual_page_context',
]);

const VISION_UNAVAILABLE = toolFailure('vision_unavailable', 'Vision is not available.', false);

function originOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}

function toRequest(name: string, args: Record<string, unknown>): ContentRequest | null {
  const ref = args.ref as string;
  switch (name) {
    case 'get_page_metadata':
      return { type: 'content.metadata' };
    case 'get_page_content':
      return { type: 'content.page_content', maxChars: PAGE_CONTENT_CHARS };
    case 'get_visible_text':
      return { type: 'content.visible_text', maxChars: VISIBLE_TEXT_CHARS };
    case 'get_interactive_elements':
      return {
        type: 'content.interactive',
        limit: INTERACTIVE_LIMIT,
        ...(typeof args.query === 'string' && { query: args.query }),
      };
    case 'click_element':
      return { type: 'content.click', ref };
    case 'type_text':
      return { type: 'content.type', ref, text: args.text as string };
    case 'clear_input':
      return { type: 'content.clear', ref };
    case 'select_option':
      return { type: 'content.select', ref, option: args.option as string };
    case 'scroll_page':
      return {
        type: 'content.scroll',
        ...(args.direction !== undefined && {
          direction: args.direction as 'up' | 'down' | 'top' | 'bottom',
        }),
        ...(args.ref !== undefined && { ref }),
        ...(args.text !== undefined && { text: args.text as string }),
      };
    case 'press_key':
      return {
        type: 'content.press',
        key: args.key as Extract<ContentRequest, { type: 'content.press' }>['key'],
        ...(args.ref !== undefined && { ref }),
      };
    case 'wait_for_element':
      return {
        type: 'content.wait',
        ...(args.text !== undefined && { text: args.text as string }),
        ...(args.role !== undefined && { role: args.role as string }),
        timeoutMs: ((args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000,
      };
    default:
      return null;
  }
}

/**
 * The one place browser tools are checked and run, for the agent and MCP alike.
 * `assess` applies permissions and the safety policy to the live page. `execute`
 * only ever runs after it.
 */
export function createToolService({
  api,
  content,
  permissions,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  loadTimeoutMs = LOAD_TIMEOUT_MS,
  vision,
  isDopilotTab = () => false,
  isAgentBusy,
}: ToolServiceDeps) {
  const tabDetailsAskedIn = new Set<string>();
  /** What the current task has opened, so asking twice does not leave two tabs. */
  let opened: { runId: string; blankTab: number | null; urls: Map<string, number> } | null = null;

  function openedFor(runId: string | undefined) {
    if (!runId) return null;
    if (opened?.runId !== runId) opened = { runId, blankTab: null, urls: new Map() };
    return opened;
  }

  function abortIfStopped(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
  }

  const dopilotTabRefusal = () =>
    toolFailure(
      'dopilot_tab',
      'That tab is showing Dopilot itself. Use another tab, or open a new one.',
      false,
    );

  async function isProtected(
    tabId: number,
    context: Pick<ToolContext, 'protectedTabId'>,
  ): Promise<boolean> {
    if (tabId === context.protectedTabId) return true;
    const tab = await api.getTab(tabId).catch(() => null);
    return tab ? isDopilotTab(tabId, tab.url) : false;
  }

  /** Comparing addresses, a trailing slash or a fragment is not a different page. */
  function samePage(a: string | undefined, b: string): boolean {
    if (!a) return false;
    try {
      const left = new URL(a);
      const right = new URL(b);
      return (
        left.origin === right.origin &&
        left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '') &&
        left.search === right.search
      );
    } catch {
      return false;
    }
  }

  async function resolveTabId(
    args: Record<string, unknown>,
    context: Pick<ToolContext, 'currentTabId' | 'source' | 'protectedTabId'>,
  ): Promise<number | null> {
    if (typeof args.tabId === 'number') return args.tabId;
    if (context.currentTabId !== null) {
      const stillOpen = await api.getTab(context.currentTabId).catch(() => null);
      if (stillOpen) return context.currentTabId;
    }
    const protectedTab = context.protectedTabId ?? undefined;
    if (context.source === 'website') return findCurrentTabId(api, 'website', protectedTab);
    const active = await findCurrentTabId(api, context.source);
    return active === protectedTab ? findCurrentTabId(api, 'website', protectedTab) : active;
  }

  /** Resolves to whether the page finished loading. Stops early if the task is stopped. */
  async function waitForLoad(tabId: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + loadTimeoutMs;
    await sleep(LOAD_POLL_MS);
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      const tab = await api.getTab(tabId).catch(() => null);
      if (!tab || tab.status === 'complete') return true;
      await sleep(LOAD_POLL_MS);
    }
    return false;
  }

  /**
   * Reports a navigation only as far as it can be verified: a tab that closed, a site that
   * failed to load and a page still loading are all different from having arrived.
   */
  async function arrival(
    tabId: number,
    requestedUrl: string,
    verb: 'Opened' | 'Went to',
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const loaded = await waitForLoad(tabId, signal);
    abortIfStopped(signal);
    const tab = await api.getTab(tabId).catch(() => null);
    if (!tab) return toolFailure('tab_closed', 'The tab closed before the page loaded.');

    const origin = tab.url ? originOf(tab.url) : null;
    if (loaded && origin && content.pageState && (await permissions.hasOrigin(origin))) {
      if ((await content.pageState(tabId)) === 'error_page') {
        return toolFailure(
          'navigation_failed',
          `${sanitizeTabUrl(requestedUrl) ?? 'That site'} did not load. It may be down, or the address may be wrong.`,
        );
      }
    }

    const requestedHost = new URL(requestedUrl).host;
    const finalHost = tab.url && origin ? new URL(tab.url).host : null;
    const redirected =
      finalHost && finalHost !== requestedHost ? ` It redirected to ${finalHost}.` : '';
    // Where it ended up, when that is known and is on the same site, not just where it was sent.
    const shown =
      (!redirected && tab.url && sanitizeTabUrl(tab.url)) || sanitizeTabUrl(requestedUrl);
    return {
      ok: true,
      summary: `${verb} ${shown}.${loaded ? '' : ' It is still loading.'}${redirected}`,
      currentTabId: tabId,
      pageChanged: true,
      untrusted: true,
      data: { ...(await describeTab(tabId)), loaded },
    };
  }

  async function describeTab(tabId: number): Promise<Record<string, unknown>> {
    const tab = await api.getTab(tabId);
    const url = tab.url ? sanitizeTabUrl(tab.url) : undefined;
    return {
      tabId,
      ...(tab.title && { title: sanitizeTabTitle(tab.title, tab.url) }),
      ...(url && { url }),
      ...(tab.url && isRestrictedTabUrl(tab.url) && { internalPage: true }),
    };
  }

  function approval(
    name: string,
    decision: Extract<PolicyDecision, { decision: 'approve' }>,
    facts: DescribeResult | null,
    args: Record<string, unknown>,
  ): ToolAssessment {
    const elementName = facts?.element?.name;
    const titles: Record<string, string> = {
      click_element: elementName ? `Click “${elementName}”?` : 'Click this unlabeled control?',
      click_visual_target: elementName
        ? `Click “${elementName}”?`
        : 'Click what was found on screen?',
      press_key: `Press ${args.key} on “${elementName}”?`,
      close_tab: 'Close this tab?',
      navigate: `Go to ${String(args.url).slice(0, 80)}?`,
      open_tab: `Open ${String(args.url).slice(0, 80)}?`,
    };
    const site = facts?.page.url ? ` On ${originOf(facts.page.url) ?? 'this page'}.` : '';
    return {
      decision: 'approve',
      kind: 'action',
      title: titles[name] ?? `Allow ${name}?`,
      detail: `${decision.reason}${site}`,
      key: JSON.stringify([
        name,
        decision.category,
        args.ref ?? args.url ?? args.tabId,
        elementName,
      ]),
    };
  }

  function fromPolicy(
    name: string,
    decision: PolicyDecision,
    facts: DescribeResult | null,
    args: Record<string, unknown>,
  ): ToolAssessment {
    switch (decision.decision) {
      case 'allow':
        return { decision: 'allow' };
      case 'approve':
        return approval(name, decision, facts, args);
      case 'block':
        return {
          decision: 'block',
          result: toolFailure(decision.code, decision.reason, false, decision.stopTask),
        };
    }
  }

  async function checkPageAccess(tabId: number, context: ToolContext): Promise<ToolAssessment> {
    const tab = await api.getTab(tabId).catch(() => null);
    if (!tab) {
      return { decision: 'block', result: toolFailure('tab_not_found', 'That tab is gone.') };
    }

    if (tab.url) {
      if (!/^https?:/i.test(tab.url)) {
        return {
          decision: 'block',
          result: toolFailure(
            'restricted_page',
            'This is a blank or internal browser page, which Dopilot cannot read or use. Navigate to a website first.',
            false,
          ),
        };
      }
      const origin = originOf(tab.url);
      if (origin && (await permissions.hasOrigin(origin))) return { decision: 'allow' };
      const allUrls = await permissions.hasAllUrls();
      if (!allUrls && (await content.canAccess(tabId))) return { decision: 'allow' };
      if (origin) {
        return {
          decision: 'approve',
          kind: 'site_access',
          title: `Allow Dopilot on ${new URL(origin).host}?`,
          detail:
            'Dopilot needs this to read and use this site. You can remove access in settings.',
          origin,
          key: `site:${origin}`,
        };
      }
    }

    if (await content.canAccess(tabId)) return { decision: 'allow' };
    return tabDetailsApproval(context);
  }

  function tabDetailsApproval(
    context: Pick<ToolContext, 'runId'>,
    detail = 'Dopilot needs tab titles and addresses to know which site it is on. Your browser may describe this as reading your browsing history.',
  ): ToolAssessment {
    if (context.runId) tabDetailsAskedIn.add(context.runId);
    return {
      decision: 'approve',
      kind: 'tab_details',
      title: 'Allow Dopilot to see your tabs?',
      detail,
      key: 'tab_details',
    };
  }

  /** What an address is judged against, including where the task is at the moment. */
  async function addressContext(context: ToolContext): Promise<PolicyContext> {
    const tabId = context.pageDataRead ? await resolveTabId({}, context).catch(() => null) : null;
    const tab = tabId === null ? null : await api.getTab(tabId).catch(() => null);
    return {
      ...(context.instruction !== undefined && { instruction: context.instruction }),
      pageDataRead: context.pageDataRead === true,
      ...(tab?.url && { currentUrl: tab.url }),
    };
  }

  /** Open tabs whose title or address contains this name, leaving out Dopilot's own. */
  function tabsMatching(
    name: string,
    tabs: Awaited<ReturnType<typeof listTabs>>,
    rawTabs: chrome.tabs.Tab[],
    protectedTabId?: number | null,
  ) {
    const wanted = name.toLowerCase().replace(/\s+/g, '');
    return tabs.filter((tab) => {
      if (tab.restricted || tab.id === protectedTabId) return false;
      const raw = rawTabs.find((item) => item.id === tab.id);
      if (isDopilotTab(tab.id, raw?.url)) return false;
      return `${tab.title ?? ''} ${tab.url ?? ''}`
        .toLowerCase()
        .replace(/\s+/g, '')
        .includes(wanted);
    });
  }

  async function assess(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolAssessment> {
    // The user is watching the task on this tab, so it must not be taken over or closed.
    if (typeof args.tabId === 'number' && (await isProtected(args.tabId, context))) {
      return { decision: 'block', result: dopilotTabRefusal() };
    }

    if (name === 'open_tabs') {
      const urls = args.urls as string[] | undefined;
      const size = urls ? urls.length : (args.count as number);
      if (size > MAX_TABS_PER_REQUEST) {
        return {
          decision: 'block',
          result: toolFailure(
            'too_many_tabs',
            `Dopilot opens at most ${MAX_TABS_PER_REQUEST} new tabs per request, and this asked for ${size.toLocaleString('en')}. No tabs were opened.`,
            false,
          ),
        };
      }
      if (size < 1) {
        return {
          decision: 'block',
          result: toolFailure(
            'invalid_tab_count',
            'That is no tabs, so nothing was opened.',
            false,
          ),
        };
      }
      if (typeof args.activate === 'number' && args.activate > size) {
        return {
          decision: 'block',
          result: toolFailure(
            'invalid_tab_position',
            `There would be no tab ${args.activate} among ${size} new tabs. No tabs were opened.`,
            false,
          ),
        };
      }
      // Each address gets the same checks it would get on its own, and all of them are looked
      // at before anything happens, so one answer can never cover an address nobody saw.
      const policy = await addressContext(context);
      const flagged: { url: string; reason: string }[] = [];
      for (const url of urls ?? []) {
        const validation = validateNavigationUrl(url);
        if (!validation.ok) {
          return {
            decision: 'block',
            result: toolFailure('blocked_url', `${validation.reason} No tabs were opened.`, false),
          };
        }
        const decision = assessToolCall('open_tab', { url }, null, policy);
        if (decision.decision === 'block') {
          return {
            decision: 'block',
            result: toolFailure(decision.code, decision.reason, false, decision.stopTask),
          };
        }
        if (decision.decision === 'approve') flagged.push({ url, reason: decision.reason });
      }
      if (flagged.length === 0) return { decision: 'allow' };
      return {
        decision: 'approve',
        kind: 'action',
        title:
          flagged.length === 1
            ? `Open ${flagged[0]?.url.slice(0, 80)}?`
            : `Open ${flagged.length} addresses that need checking?`,
        detail: [
          `This opens ${size} ${size === 1 ? 'tab' : 'tabs'}. Check these first:`,
          ...flagged.map(({ url, reason }) => `• ${url.slice(0, 160)} (${reason})`),
        ].join('\n'),
        // The whole proposal, so any change to the list needs a new answer.
        key: JSON.stringify(['open_tabs', urls, args.activate ?? null]),
      };
    }

    if (name === 'open_tab' || name === 'navigate') {
      const url = args.url;
      if (typeof url === 'string') {
        const validation = validateNavigationUrl(url);
        if (!validation.ok) {
          return {
            decision: 'block',
            result: toolFailure('blocked_url', validation.reason, false),
          };
        }
      }
      if (name === 'navigate') {
        const tabId = await resolveTabId(args, context);
        if (tabId !== null && (await isProtected(tabId, context))) {
          return { decision: 'block', result: dopilotTabRefusal() };
        }
        const tab = tabId === null ? null : await api.getTab(tabId).catch(() => null);
        // Going to a website would replace the page, including Dopilot's own settings.
        if (tab?.url && isRestrictedTabUrl(tab.url)) {
          return {
            decision: 'block',
            result: toolFailure(
              'restricted_page',
              'The current tab is an internal or Dopilot page, which must not be replaced. Use open_tab instead.',
            ),
          };
        }
      }
      return fromPolicy(
        name,
        assessToolCall(name, args, null, await addressContext(context)),
        null,
        args,
      );
    }

    if (name === 'switch_tab_by_name' && !(await permissions.hasTabDetails())) {
      return tabDetailsApproval(
        context,
        'To find a tab by name, Dopilot needs tab titles and addresses. Your browser may describe this as reading your browsing history. Without it, “switch to tab 2” still works.',
      );
    }

    if (name === 'get_tabs' || name === 'get_active_tab') {
      const asked = context.runId !== undefined && tabDetailsAskedIn.has(context.runId);
      if (!asked && !(await permissions.hasTabDetails())) return tabDetailsApproval(context);
      return { decision: 'allow' };
    }

    if (name === 'close_tab') {
      const tabId = await resolveTabId(args, context);
      if (tabId !== null && (await isProtected(tabId, context))) {
        return { decision: 'block', result: dopilotTabRefusal() };
      }
      return fromPolicy(name, assessToolCall(name, args, null), null, args);
    }

    if (name === 'click_visual_target') {
      if (!vision) return { decision: 'block', result: VISION_UNAVAILABLE };
      const current = await resolveTabId({}, context);
      const target = await vision.ground(
        args.screenshotId as string,
        args.pointId as string,
        current,
      );
      if ('failure' in target) return { decision: 'block', result: target.failure };
      const access = await checkPageAccess(target.tabId, context);
      if (access.decision !== 'allow') return access;
      // The same rules as any click, judged on what is really at that point.
      return fromPolicy(
        name,
        assessToolCall('click_element', { ref: target.ref }, target.facts),
        target.facts,
        { ...args, ref: target.ref },
      );
    }

    if (CAPTURE_TOOLS.has(name)) {
      if (!vision) return { decision: 'block', result: VISION_UNAVAILABLE };
      const refusal = await vision.refusalIfOff();
      if (refusal) return refusal;
    }

    if (!PAGE_TOOLS.has(name)) return { decision: 'allow' };

    const tabId = await resolveTabId(args, context);
    if (tabId === null) {
      return { decision: 'block', result: toolFailure('no_target_tab', 'There is no tab to use.') };
    }
    // A task must not be able to press buttons on the console that gives it instructions.
    if (await isProtected(tabId, context)) {
      return { decision: 'block', result: dopilotTabRefusal() };
    }

    const access = await checkPageAccess(tabId, context);
    if (access.decision !== 'allow') return access;

    if (vision && CAPTURE_TOOLS.has(name)) {
      return vision.assessCapture(name, tabId, context);
    }

    if (!needsPageFacts(name)) return { decision: 'allow' };

    // Facts come from the live page, so an action is judged by what is there now.
    let reply: ToolResult;
    try {
      reply = await content.send(tabId, {
        type: 'content.describe',
        ...(typeof args.ref === 'string' && { ref: args.ref }),
      });
    } catch (error) {
      return {
        decision: 'block',
        result:
          error instanceof ErrorPageError
            ? toolFailure(
                'error_page',
                'This page failed to load, so there is nothing to use.',
                false,
              )
            : toolFailure(
                error instanceof PageBusyError ? 'page_busy' : 'page_error',
                'The page could not be checked. It may still be loading, so look at it again.',
              ),
      };
    }
    if (!reply.ok) return { decision: 'block', result: reply };

    const facts = DescribeResultSchema.safeParse(reply.data);
    if (!facts.success) {
      return {
        decision: 'block',
        result: toolFailure('page_error', 'The page could not be checked. Look at it again.'),
      };
    }
    return fromPolicy(name, assessToolCall(name, args, facts.data), facts.data, args);
  }

  async function runCommand(
    command: BrowserCommand,
    context: Pick<ToolContext, 'source'>,
  ): Promise<ToolResult | null> {
    // Approval already happened in `assess`, so this is what `confirmed` records.
    const result = await executeCommand(api, command, { source: context.source, confirmed: true });
    if (result.ok) return null;
    // Trying something else cannot make a page exist, or an internal page usable.
    const recoverable = result.code !== 'no_history' && result.code !== 'restricted_page';
    return toolFailure(result.code, result.message, recoverable);
  }

  async function execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      switch (name) {
        case 'get_tabs': {
          const [tabs, details] = await Promise.all([listTabs(api), permissions.hasTabDetails()]);
          return {
            ok: true,
            summary: `Found ${tabs.length} open tabs.`,
            untrusted: true,
            data: {
              tabs: tabs.map(({ id, active, title, url, restricted }) => ({
                id,
                active,
                title,
                url,
                ...(restricted && { internalPage: true }),
              })),
              ...(!details && {
                note: 'The user has not allowed tab details, so most titles and addresses are hidden.',
              }),
            },
          };
        }

        case 'get_active_tab': {
          const tabId = await resolveTabId({}, context);
          if (tabId === null) return toolFailure('no_target_tab', 'There is no current tab.');
          return {
            ok: true,
            summary: 'Read the current tab.',
            untrusted: true,
            data: await describeTab(tabId),
          };
        }

        case 'open_tabs':
          return await openTabs(args, context);

        case 'open_tab': {
          const url = args.url as string | undefined;
          const validated = url === undefined ? null : validateNavigationUrl(url);
          if (validated && !validated.ok)
            return toolFailure('blocked_url', validated.reason, false);
          abortIfStopped(context.signal);

          const memory = openedFor(context.runId);
          if (validated) {
            const already = memory?.urls.get(validated.url);
            if (already !== undefined && (await api.getTab(already).catch(() => null))) {
              return {
                ok: true,
                summary: `${sanitizeTabUrl(validated.url)} is already open in the tab this task opened.`,
                currentTabId: already,
                untrusted: true,
                data: await describeTab(already),
              };
            }
            // "Open a new tab" followed by "open YouTube" means one tab, not two.
            const blank = memory?.blankTab ?? null;
            if (blank !== null && (await api.getTab(blank).catch(() => null))) {
              await api.navigateTab(blank, validated.url);
              if (memory) {
                memory.blankTab = null;
                memory.urls.set(validated.url, blank);
              }
              return await arrival(blank, validated.url, 'Opened', context.signal);
            }
          } else if (
            memory?.blankTab != null &&
            (await api.getTab(memory.blankTab).catch(() => null))
          ) {
            return {
              ok: true,
              summary: 'The new tab this task opened is ready.',
              currentTabId: memory.blankTab,
            };
          }

          const tab = await api.createTab(validated ? { url: validated.url } : {});
          if (tab.id === undefined) return toolFailure('execution_failed', 'The tab did not open.');
          if (!validated) {
            if (memory) memory.blankTab = tab.id;
            return {
              ok: true,
              summary: 'Opened a new tab.',
              tabsCreated: 1,
              currentTabId: tab.id,
              pageChanged: true,
              // A blank tab has no page in it, so nothing here could have come from a website.
              data: await describeTab(tab.id),
            };
          }
          memory?.urls.set(validated.url, tab.id);
          return {
            ...(await arrival(tab.id, validated.url, 'Opened', context.signal)),
            tabsCreated: 1,
          };
        }

        case 'navigate': {
          const validated = validateNavigationUrl(args.url as string);
          if (!validated.ok) return toolFailure('blocked_url', validated.reason, false);
          const tabId = await resolveTabId(args, context);
          if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to use.');
          abortIfStopped(context.signal);
          const before = await api.getTab(tabId).catch(() => null);
          // Loading the same page again would lose the user's place and prove nothing.
          if (before?.status === 'complete' && samePage(before.url, validated.url)) {
            return {
              ok: true,
              summary: `Already at ${sanitizeTabUrl(validated.url)}.`,
              currentTabId: tabId,
              untrusted: true,
              data: await describeTab(tabId),
            };
          }
          const memory = openedFor(context.runId);
          if (memory?.blankTab === tabId) memory.blankTab = null;
          await api.navigateTab(tabId, validated.url);
          return await arrival(tabId, validated.url, 'Went to', context.signal);
        }

        case 'switch_tab': {
          const tabId = args.tabId as number;
          abortIfStopped(context.signal);
          const failure = await runCommand({ action: 'tab.switch', target: { tabId } }, context);
          if (failure) return failure;
          const described = await describeTab(tabId);
          const { title } = described as { title?: string };
          return {
            ok: true,
            summary: title ? `Switched to “${title.slice(0, 80)}”.` : 'Switched tabs.',
            currentTabId: tabId,
            pageChanged: true,
            untrusted: true,
            data: described,
          };
        }

        case 'switch_tab_by_name': {
          const wanted = args.name as string;
          const [tabs, rawTabs] = await Promise.all([
            listTabs(api),
            api.queryTabs({ windowType: 'normal' }),
          ]);
          const matches = tabsMatching(wanted, tabs, rawTabs, context.protectedTabId);
          const match = matches[0];
          if (!match) return toolFailure('no_matching_tab', `No open tab matches “${wanted}”.`);
          if (matches.length > 1) {
            return toolFailure(
              'ambiguous_tab',
              `${matches.length} open tabs match “${wanted}”, so Dopilot did not guess. Use a more exact name, or “switch to tab 2”.`,
              false,
            );
          }
          abortIfStopped(context.signal);
          const failure = await runCommand(
            { action: 'tab.switch', target: { tabId: match.id } },
            context,
          );
          if (failure) return failure;
          return {
            ok: true,
            summary: `Switched to “${(match.title ?? wanted).slice(0, 80)}”.`,
            currentTabId: match.id,
            pageChanged: true,
            untrusted: true,
            data: await describeTab(match.id),
          };
        }

        case 'close_tab': {
          const tabId = await resolveTabId(args, context);
          if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to close.');
          abortIfStopped(context.signal);
          const failure = await runCommand({ action: 'tab.close', target: { tabId } }, context);
          if (failure) return failure;
          const next = await findCurrentTabId(
            api,
            context.source,
            context.protectedTabId ?? undefined,
          );
          return {
            ok: true,
            summary: 'Closed the tab.',
            pageChanged: true,
            ...(next !== null && { currentTabId: next }),
          };
        }

        case 'reload_tab':
        case 'go_back':
        case 'go_forward': {
          const tabId = await resolveTabId(args, context);
          if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to use.');
          const action = (
            { reload_tab: 'tab.reload', go_back: 'tab.back', go_forward: 'tab.forward' } as const
          )[name];
          abortIfStopped(context.signal);
          const failure = await runCommand({ action, target: { tabId } }, context);
          if (failure) return failure;
          const loaded = await waitForLoad(tabId, context.signal);
          return {
            ok: true,
            summary: `${
              {
                reload_tab: 'Reloaded.',
                go_back: 'Went back.',
                go_forward: 'Went forward.',
              }[name]
            }${loaded ? '' : ' It is still loading.'}`,
            currentTabId: tabId,
            pageChanged: true,
            untrusted: true,
            data: await describeTab(tabId),
          };
        }
      }

      if (CAPTURE_TOOLS.has(name)) {
        if (!vision) return VISION_UNAVAILABLE;
        const tabId = await resolveTabId(args, context);
        if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to use.');
        return await vision.execute(name, args, tabId, context);
      }

      if (name === 'click_visual_target') {
        if (!vision) return VISION_UNAVAILABLE;
        const current = await resolveTabId({}, context);
        // Checked again here: the page may have changed while the user was deciding.
        const target = await vision.ground(
          args.screenshotId as string,
          args.pointId as string,
          current,
        );
        if ('failure' in target) return target.failure;
        abortIfStopped(context.signal);
        return await sendToPage(
          target.tabId,
          target.interactive
            ? { type: 'content.click', ref: target.ref }
            : { type: 'content.click_point', ref: target.ref, ...target.viewportPoint },
          context.signal,
        );
      }

      const request = toRequest(name, args);
      if (!request) return toolFailure('unknown_tool', `Unknown tool: ${name}`, false);

      const tabId = await resolveTabId(args, context);
      if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to use.');

      abortIfStopped(context.signal);
      return await sendToPage(tabId, request, context.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return toolFailure('cancelled', 'Stopped.', false);
      }
      if (error instanceof NoPageAccessError) {
        return toolFailure(
          'no_page_access',
          'Dopilot does not have permission to use this site.',
          false,
        );
      }
      if (error instanceof ErrorPageError) {
        return toolFailure(
          'error_page',
          'This page failed to load, so there is nothing to use.',
          false,
        );
      }
      return toolFailure('execution_failed', 'That action could not be completed.');
    }
  }

  /** Waits for a free loading slot, without ever waiting long on one slow site. */
  async function waitForLoadingSlot(loading: Set<number>, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + BATCH_LOADING_WAIT_MS;
    while (!signal.aborted && Date.now() < deadline) {
      for (const id of loading) {
        const tab = await api.getTab(id).catch(() => null);
        if (!tab || tab.status === 'complete') loading.delete(id);
      }
      if (loading.size < BATCH_MAX_LOADING) return;
      await sleep(LOAD_POLL_MS);
    }
  }

  /**
   * One batch of new tabs, in the background so the user's tab stays in front. Each is counted
   * only once the browser has handed it back, and is checked again at the end. A tab the
   * browser refused is reported, never retried blindly, so nothing can end up doubled.
   */
  async function openTabs(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const urls = (args.urls as string[] | undefined)?.map((url) => {
      const validated = validateNavigationUrl(url);
      return validated.ok ? validated.url : null;
    });
    if (urls?.includes(null))
      return toolFailure('blocked_url', 'That address is not allowed.', false);
    const total = urls ? urls.length : (args.count as number);
    const created: number[] = [];
    const loading = new Set<number>();
    let failedInARow = 0;
    let attempted = 0;

    for (let index = 0; index < total; index += 1) {
      if (context.signal.aborted) break;
      if (failedInARow >= BATCH_MAX_CONSECUTIVE_FAILURES) break;
      const url = urls?.[index];
      context.onProgress?.({
        done: created.length,
        total,
        label: `Creating tab ${index + 1} of ${total}`,
      });
      if (url && loading.size >= BATCH_MAX_LOADING)
        await waitForLoadingSlot(loading, context.signal);
      if (context.signal.aborted) break;

      attempted += 1;
      const tab = await api.createTab({ ...(url && { url }), active: false }).catch(() => null);
      if (tab?.id === undefined) {
        failedInARow += 1;
      } else {
        failedInARow = 0;
        created.push(tab.id);
        if (url) loading.add(tab.id);
        // Reported even after Stop, because this tab now exists whatever happens next.
        context.onProgress?.({
          done: created.length,
          total,
          label: `Creating tab ${index + 1} of ${total}`,
        });
      }
      if (index < total - 1) await sleep(BATCH_PACE_MS);
    }

    // What is really open now, not what was asked for or what once succeeded.
    const present = await Promise.all(
      created.map((id) =>
        api.getTab(id).then(
          () => id,
          () => null,
        ),
      ),
    );
    const open = present.filter((id): id is number => id !== null);
    const noun = urls ? 'tabs' : 'new tabs';

    if (context.signal.aborted) {
      return toolFailure(
        'cancelled',
        `Stopped after opening ${open.length} of ${total} tabs.`,
        false,
      );
    }

    let currentTabId: number | undefined;
    let switchProblem = '';
    const wanted = args.activate as number | undefined;
    if (wanted !== undefined) {
      const target = created[wanted - 1];
      const failure =
        target !== undefined && open.length === total
          ? await runCommand({ action: 'tab.switch', target: { tabId: target } }, context)
          : toolFailure('tab_not_found', 'That tab was not opened.');
      if (failure || target === undefined) {
        switchProblem = ` Could not switch to tab ${wanted}.`;
      } else {
        currentTabId = target;
      }
    }

    if (open.length < total) {
      const missing = total - open.length;
      return {
        ...toolFailure(
          'batch_incomplete',
          `Opened ${open.length} of ${total} ${noun}. ${missing} could not be opened${
            attempted < total ? ', and the browser kept refusing, so the rest were not tried' : ''
          }.${switchProblem} Not retried, to avoid duplicate tabs.`,
          false,
        ),
        tabsCreated: open.length,
      } as ToolResult;
    }

    return {
      ok: true,
      summary: `Opened ${open.length} of ${total} ${noun}.${
        currentTabId === undefined && !switchProblem ? ' Your current tab was left in front.' : ''
      }${currentTabId !== undefined ? ` Switched to tab ${wanted}.` : ''}${switchProblem}`,
      tabsCreated: open.length,
      ...(currentTabId !== undefined && { currentTabId, pageChanged: true }),
      data: { requested: total, created: open.length, tabIds: open },
    };
  }

  const READ_REQUESTS = new Set<ContentRequest['type']>([
    'content.metadata',
    'content.page_content',
    'content.visible_text',
    'content.interactive',
    'content.wait',
  ]);

  async function sendToPage(
    tabId: number,
    request: ContentRequest,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const canNavigate =
      request.type === 'content.click' ||
      request.type === 'content.press' ||
      request.type === 'content.click_point';
    const before = canNavigate ? await api.getTab(tabId).catch(() => null) : null;
    let result: ToolResult;
    try {
      try {
        result = await content.send(tabId, request);
      } catch (error) {
        // Reading twice is harmless, so a page that was mid-load gets a second chance.
        if (!READ_REQUESTS.has(request.type) || error instanceof NoPageAccessError) throw error;
        if (error instanceof ErrorPageError) throw error;
        await sleep(READ_RETRY_MS);
        if (signal?.aborted) throw error;
        result = await content.send(tabId, request);
      }
    } catch (error) {
      if (error instanceof NoPageAccessError || error instanceof ErrorPageError) throw error;
      if (READ_REQUESTS.has(request.type)) {
        return toolFailure(
          error instanceof PageBusyError ? 'page_busy' : 'page_changed',
          'The page did not answer. It may still be loading, or showing a dialog. Look at it again shortly.',
        );
      }
      if (!canNavigate) {
        return toolFailure(
          'outcome_unknown',
          'The page changed or stopped answering during that, so it may not have worked. Look at the page before trying again.',
        );
      }
      // A page unloading ends the content script before it can reply, which looks the same
      // as the action never arriving. Only a real change of page counts as having worked.
      const loaded = await waitForLoad(tabId, signal);
      const after = await api.getTab(tabId).catch(() => null);
      const navigated = after !== null && (after.url !== before?.url || after.status === 'loading');
      if (!navigated) {
        return toolFailure(
          'outcome_unknown',
          'The page did not confirm that action and did not change, so it may not have worked. Look at the page before trying again, and do not repeat it blindly.',
        );
      }
      return {
        ok: true,
        summary: `Done. The page navigated away.${loaded ? '' : ' It is still loading.'}`,
        pageChanged: true,
        untrusted: true,
        data: await describeTab(tabId),
      };
    }
    // Replies quote labels and titles from the page, wherever they appear in the result.
    const marked: ToolResult = { ...result, untrusted: true };
    if (marked.ok && marked.pageChanged && canNavigate) {
      await waitForLoad(tabId, signal);
      return { ...marked, data: await describeTab(tabId) };
    }
    return marked;
  }

  async function describeContext(source: AgentSource, protectedTabId?: number | null) {
    const [tabs, rawTabs, currentTabId, details] = await Promise.all([
      listTabs(api),
      api.queryTabs({ windowType: 'normal' }),
      findCurrentTabId(api, source, protectedTabId ?? undefined),
      permissions.hasTabDetails(),
    ]);
    const current = tabs.find((tab) => tab.id === currentTabId);
    const previous = previousTabId(rawTabs, currentTabId, protectedTabId);
    const dopilot = rawTabs
      .filter(
        (tab) =>
          tab.id !== undefined && (tab.id === protectedTabId || isDopilotTab(tab.id, tab.url)),
      )
      .map((tab) => tab.id);
    const lines = [
      current
        ? `Current tab: id ${current.id}${current.restricted ? ' (internal page, cannot be used)' : ''}.`
        : 'There is no current tab, so open one if needed.',
      ...(previous !== null ? [`Previous tab: id ${previous}.`] : []),
      ...(dopilot.length > 0
        ? [`Tab ${dopilot.join(', ')} shows Dopilot itself and cannot be used.`]
        : []),
      `${tabs.length} tabs open.${details ? '' : ' Tab titles are hidden until allowed.'}`,
    ];
    // Titles and addresses are written by websites, so they are marked as such here too.
    const listed = tabs.slice(0, CONTEXT_TAB_LIMIT).flatMap(({ id, title, url }) =>
      title || url
        ? [
            {
              id,
              ...(title && { title: title.slice(0, 80) }),
              ...(url && { url: url.slice(0, 120) }),
            },
          ]
        : [],
    );
    if (listed.length > 0) lines.push(wrapUntrustedContent(JSON.stringify(listed)));
    return { text: lines.join('\n'), currentTabId };
  }

  /** The tab used most recently before this one. Browsers keep this for every tab. */
  function previousTabId(
    tabs: chrome.tabs.Tab[],
    currentTabId: number | null,
    protectedTabId?: number | null,
  ): number | null {
    const others = tabs
      .filter(
        (tab) =>
          tab.id !== undefined &&
          tab.id !== currentTabId &&
          tab.id !== protectedTabId &&
          !isDopilotTab(tab.id, tab.url),
      )
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return others[0]?.id ?? null;
  }

  /**
   * Turns a simple instruction into tool calls, or null if it needs real judgement. Those
   * calls take the same route as a model's, so nothing here bypasses a check. A tab named
   * in the instruction must match exactly one open tab, because otherwise it needs asking.
   */
  async function planSimple(
    instruction: string,
    source: AgentSource,
    protectedTabId?: number | null,
  ) {
    const steps = parseSimpleInstruction(instruction);
    if (!steps) return null;

    const [tabs, rawTabs, startTab, details] = await Promise.all([
      listTabs(api),
      api.queryTabs({ windowType: 'normal' }),
      findCurrentTabId(api, source, protectedTabId ?? undefined),
      permissions.hasTabDetails(),
    ]);
    let current = startTab;
    let previous = previousTabId(rawTabs, startTab, protectedTabId);
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    let openedSite: string | null = null;
    let inFreshTab = false;
    /** A "new tab" step with no address yet. The next address goes there, for one tab in all. */
    let blankCall: { name: string; arguments: Record<string, unknown> } | null = null;

    const switchTo = (tabId: number) => {
      calls.push({ name: 'switch_tab', arguments: { tabId } });
      previous = current;
      current = tabId;
    };
    const currentIsUnusable = () => {
      const raw = rawTabs.find((tab) => tab.id === current);
      const info = tabs.find((tab) => tab.id === current);
      return (
        current === null ||
        current === protectedTabId ||
        info?.restricted === true ||
        isDopilotTab(current, raw?.url)
      );
    };
    const open = (url: string, newTab: boolean) => {
      if (blankCall && blankCall === calls.at(-1)) {
        blankCall.arguments = { url };
        blankCall = null;
      } else if (newTab || (!inFreshTab && currentIsUnusable())) {
        calls.push({ name: 'open_tab', arguments: { url } });
        inFreshTab = true;
      } else {
        calls.push({ name: 'navigate', arguments: { url } });
      }
    };

    for (const step of steps) {
      const last = calls.at(-1);
      switch (step.kind) {
        case 'new_tabs':
          calls.push({ name: 'open_tabs', arguments: { count: step.count } });
          break;
        case 'open_many':
          calls.push({ name: 'open_tabs', arguments: { urls: step.urls } });
          break;
        case 'open_each': {
          const count = last?.name === 'open_tabs' ? (last.arguments.count as number) : 0;
          if (!last || count < 1) return null;
          // An impossible size is left for the safety check to refuse, with its explanation.
          if (count <= MAX_TABS_PER_REQUEST) {
            last.arguments = { urls: Array.from({ length: count }, () => step.url) };
          }
          break;
        }
        case 'switch_created': {
          if (last?.name !== 'open_tabs') return null;
          const size = Array.isArray(last.arguments.urls)
            ? last.arguments.urls.length
            : (last.arguments.count as number);
          last.arguments.activate = step.which === 'last' ? size : step.which;
          break;
        }
        case 'new_tab':
          blankCall = { name: 'open_tab', arguments: {} };
          calls.push(blankCall);
          inFreshTab = true;
          openedSite = null;
          break;
        case 'open':
          open(step.url, step.newTab);
          openedSite = step.site ?? null;
          break;
        case 'search': {
          const site: string | null = step.site ?? openedSite;
          const url = site ? siteSearchUrl(site, step.query) : null;
          if (!url || !site) return null;
          // Opening a site and then searching it needs only the one page load.
          const last = calls.at(-1);
          if (
            openedSite === site &&
            last &&
            (last.name === 'open_tab' || last.name === 'navigate')
          ) {
            last.arguments = { ...last.arguments, url };
          } else {
            open(url, true);
          }
          openedSite = site;
          break;
        }
        case 'switch_named': {
          const matches = tabsMatching(step.name, tabs, rawTabs, protectedTabId);
          if (matches.length === 1 && matches[0]) {
            switchTo(matches[0].id);
          } else if (!details) {
            // Names are hidden until allowed. Asking beats sending a tab switch to the AI.
            calls.push({ name: 'switch_tab_by_name', arguments: { name: step.name } });
            previous = current;
            current = null;
          } else {
            return null;
          }
          inFreshTab = false;
          break;
        }
        case 'switch_position': {
          const tab = tabs[step.position - 1];
          if (!tab) return null;
          switchTo(tab.id);
          inFreshTab = false;
          break;
        }
        case 'switch_previous':
          if (previous === null) return null;
          switchTo(previous);
          inFreshTab = false;
          break;
        case 'scroll_direction':
          calls.push({ name: 'scroll_page', arguments: { direction: step.direction } });
          break;
        case 'scroll_text':
          calls.push({ name: 'scroll_page', arguments: { text: step.text } });
          break;
        case 'press':
          calls.push({ name: 'press_key', arguments: { key: step.key } });
          break;
        case 'reload':
          calls.push({ name: 'reload_tab', arguments: {} });
          break;
        case 'back':
          calls.push({ name: 'go_back', arguments: {} });
          break;
        case 'forward':
          calls.push({ name: 'go_forward', arguments: {} });
          break;
        case 'close':
          calls.push({ name: 'close_tab', arguments: {} });
          break;
      }
    }
    return calls.length > 0 ? calls : null;
  }

  function toolTimeoutMs(name: string, args: Record<string, unknown>): number | undefined {
    if (
      [
        'open_tab',
        'navigate',
        'reload_tab',
        'go_back',
        'go_forward',
        'click_element',
        'press_key',
        'click_visual_target',
      ].includes(name)
    ) {
      return NAVIGATION_TOOL_TIMEOUT_MS;
    }
    if (name === 'open_tabs') return BATCH_TOOL_TIMEOUT_MS;
    if (name === 'wait_for_element') {
      return (
        ((args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000 +
        WAIT_MARGIN_MS
      );
    }
    return CAPTURE_TOOLS.has(name) ? VISION_TOOL_TIMEOUT_MS : undefined;
  }

  /**
   * The same checks as the agent. MCP cannot show a prompt, so it is refused instead. Every
   * call is bounded, so one stuck page cannot stop the bridge taking further calls.
   */
  async function runExternalCall(name: string, rawArgs: unknown): Promise<ToolResult> {
    const validation = validateToolCall(name, rawArgs);
    if (!validation.ok) return toolFailure('invalid_arguments', validation.error, false);

    if (validation.tool.effect === 'act' && (await isAgentBusy?.())) {
      return toolFailure(
        'agent_busy',
        'A Dopilot task is running in this browser. Wait for it to finish, or stop it first.',
      );
    }

    const abort = new AbortController();
    const context: ToolContext = { source: 'panel', currentTabId: null, signal: abort.signal };
    const work = (async () => {
      const assessment = await assess(name, validation.args, context);
      if (assessment.decision === 'block') return assessment.result;
      if (assessment.decision === 'approve') {
        return toolFailure(
          'approval_required',
          `${assessment.title} This needs approval, so it can only be done through the Dopilot agent, or by granting access in its settings.`,
          false,
        );
      }
      return execute(name, validation.args, context);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(
          toolFailure(
            validation.tool.effect === 'act' ? 'outcome_unknown' : 'tool_timeout',
            'This did not finish in time.',
          ),
        );
      }, EXTERNAL_CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } catch {
      return toolFailure('execution_failed', 'That action could not be completed.');
    } finally {
      clearTimeout(timer);
    }
  }

  const toolbox: AgentToolbox = {
    definitions: toolSpecs(),
    assess,
    execute,
    describeContext,
    planSimple,
    toolTimeoutMs,
  };
  return { toolbox, runExternalCall };
}
