import type { AgentToolbox, ToolAssessment, ToolContext } from '@dopilot/agent-core';
import {
  assessToolCall,
  needsPageFacts,
  toolSpecs,
  validateToolCall,
} from '@dopilot/browser-tools';
import type { PolicyDecision } from '@dopilot/browser-tools';
import {
  DescribeResultSchema,
  isRestrictedTabUrl,
  sanitizeTabTitle,
  sanitizeTabUrl,
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
import { NoPageAccessError } from './content-client';
import type { ContentPort } from './content-client';

const PAGE_CONTENT_CHARS = 3000;
const VISIBLE_TEXT_CHARS = 2000;
const INTERACTIVE_LIMIT = 40;
const DEFAULT_WAIT_SECONDS = 5;
const LOAD_TIMEOUT_MS = 15_000;
const LOAD_POLL_MS = 150;

export interface PermissionPort {
  hasTabDetails(): Promise<boolean>;
  hasOrigin(origin: string): Promise<boolean>;
}

export interface ToolServiceDeps {
  api: BrowserApi;
  content: ContentPort;
  permissions: PermissionPort;
  sleep?: (ms: number) => Promise<void>;
  loadTimeoutMs?: number;
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
]);

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
}: ToolServiceDeps) {
  const tabDetailsAskedIn = new Set<string>();

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

  async function waitForLoad(tabId: number): Promise<void> {
    const deadline = Date.now() + loadTimeoutMs;
    await sleep(LOAD_POLL_MS);
    while (Date.now() < deadline) {
      const tab = await api.getTab(tabId).catch(() => null);
      if (!tab || tab.status === 'complete') return;
      await sleep(LOAD_POLL_MS);
    }
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
      click_element: `Click “${elementName}”?`,
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
      if (await content.canAccess(tabId)) return { decision: 'allow' };
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

  function tabDetailsApproval(context: Pick<ToolContext, 'runId'>): ToolAssessment {
    if (context.runId) tabDetailsAskedIn.add(context.runId);
    return {
      decision: 'approve',
      kind: 'tab_details',
      title: 'Allow Dopilot to see your tabs?',
      detail:
        'Dopilot needs tab titles and addresses to know which site it is on. Your browser may describe this as reading your browsing history.',
      key: 'tab_details',
    };
  }

  async function assess(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolAssessment> {
    // The user is watching the task on this tab, so it must not be taken over or closed.
    if (
      context.protectedTabId !== undefined &&
      context.protectedTabId !== null &&
      args.tabId === context.protectedTabId
    ) {
      return {
        decision: 'block',
        result: toolFailure(
          'dopilot_tab',
          'That tab is showing Dopilot itself. Use another tab, or open a new one.',
          false,
        ),
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
      return fromPolicy(name, assessToolCall(name, args, null), null, args);
    }

    if (name === 'get_tabs' || name === 'get_active_tab') {
      const asked = context.runId !== undefined && tabDetailsAskedIn.has(context.runId);
      if (!asked && !(await permissions.hasTabDetails())) return tabDetailsApproval(context);
      return { decision: 'allow' };
    }

    if (name === 'close_tab') {
      return fromPolicy(name, assessToolCall(name, args, null), null, args);
    }

    if (!PAGE_TOOLS.has(name)) return { decision: 'allow' };

    const tabId = await resolveTabId(args, context);
    if (tabId === null) {
      return { decision: 'block', result: toolFailure('no_target_tab', 'There is no tab to use.') };
    }

    const access = await checkPageAccess(tabId, context);
    if (access.decision !== 'allow') return access;
    if (!needsPageFacts(name)) return { decision: 'allow' };

    // Facts come from the live page, so an action is judged by what is there now.
    let reply: ToolResult;
    try {
      reply = await content.send(tabId, {
        type: 'content.describe',
        ...(typeof args.ref === 'string' && { ref: args.ref }),
      });
    } catch {
      return {
        decision: 'block',
        result: toolFailure('page_error', 'The page could not be checked. Look at it again.'),
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
    return result.ok ? null : toolFailure(result.code, result.message);
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

        case 'open_tab': {
          const url = args.url as string | undefined;
          const validated = url === undefined ? null : validateNavigationUrl(url);
          if (validated && !validated.ok)
            return toolFailure('blocked_url', validated.reason, false);
          const tab = await api.createTab(validated ? { url: validated.url } : {});
          if (tab.id === undefined) return toolFailure('execution_failed', 'The tab did not open.');
          if (validated) await waitForLoad(tab.id);
          return {
            ok: true,
            summary: validated ? `Opened ${sanitizeTabUrl(validated.url)}.` : 'Opened a new tab.',
            currentTabId: tab.id,
            pageChanged: true,
            untrusted: true,
            data: await describeTab(tab.id),
          };
        }

        case 'navigate': {
          const validated = validateNavigationUrl(args.url as string);
          if (!validated.ok) return toolFailure('blocked_url', validated.reason, false);
          const tabId = await resolveTabId(args, context);
          if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to use.');
          await api.navigateTab(tabId, validated.url);
          await waitForLoad(tabId);
          return {
            ok: true,
            summary: `Went to ${sanitizeTabUrl(validated.url)}.`,
            currentTabId: tabId,
            pageChanged: true,
            untrusted: true,
            data: await describeTab(tabId),
          };
        }

        case 'switch_tab': {
          const tabId = args.tabId as number;
          const failure = await runCommand({ action: 'tab.switch', target: { tabId } }, context);
          if (failure) return failure;
          return {
            ok: true,
            summary: 'Switched tabs.',
            currentTabId: tabId,
            pageChanged: true,
            untrusted: true,
            data: await describeTab(tabId),
          };
        }

        case 'close_tab': {
          const tabId = await resolveTabId(args, context);
          if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to close.');
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
          const failure = await runCommand({ action, target: { tabId } }, context);
          if (failure) return failure;
          await waitForLoad(tabId);
          return {
            ok: true,
            summary: {
              reload_tab: 'Reloaded.',
              go_back: 'Went back.',
              go_forward: 'Went forward.',
            }[name],
            currentTabId: tabId,
            pageChanged: true,
            untrusted: true,
            data: await describeTab(tabId),
          };
        }
      }

      const request = toRequest(name, args);
      if (!request) return toolFailure('unknown_tool', `Unknown tool: ${name}`, false);

      const tabId = await resolveTabId(args, context);
      if (tabId === null) return toolFailure('no_target_tab', 'There is no tab to use.');

      return await sendToPage(tabId, request);
    } catch (error) {
      if (error instanceof NoPageAccessError) {
        return toolFailure(
          'no_page_access',
          'Dopilot does not have permission to use this site.',
          false,
        );
      }
      return toolFailure('execution_failed', 'That action could not be completed.');
    }
  }

  async function sendToPage(tabId: number, request: ContentRequest): Promise<ToolResult> {
    const canNavigate = request.type === 'content.click' || request.type === 'content.press';
    let result: ToolResult;
    try {
      result = await content.send(tabId, request);
    } catch (error) {
      if (error instanceof NoPageAccessError) throw error;
      // The page unloading ends the content script before it can reply.
      if (!canNavigate) {
        return toolFailure('page_changed', 'The page changed during that. Look at it again.');
      }
      await waitForLoad(tabId);
      return {
        ok: true,
        summary: 'Done. The page navigated away.',
        pageChanged: true,
        untrusted: true,
        data: await describeTab(tabId),
      };
    }
    if (result.ok && result.pageChanged && canNavigate) {
      await waitForLoad(tabId);
      return { ...result, untrusted: true, data: await describeTab(tabId) };
    }
    return result;
  }

  async function describeContext(source: AgentSource, protectedTabId?: number | null) {
    const [tabs, currentTabId, details] = await Promise.all([
      listTabs(api),
      findCurrentTabId(api, source, protectedTabId ?? undefined),
      permissions.hasTabDetails(),
    ]);
    const current = tabs.find((tab) => tab.id === currentTabId);
    const protectedNote =
      protectedTabId !== undefined && protectedTabId !== null
        ? ` Tab ${protectedTabId} shows Dopilot itself and cannot be used.`
        : '';
    const description = current
      ? `Current tab: id ${current.id}${current.title ? `, “${current.title.slice(0, 80)}”` : ''}${
          current.url ? `, ${current.url.slice(0, 120)}` : ''
        }${current.restricted ? ' (internal page)' : ''}.`
      : 'There is no current tab, so open one if needed.';
    return {
      text: `${description}${protectedNote} ${tabs.length} tabs open.${details ? '' : ' Tab titles are hidden until allowed.'}`,
      currentTabId,
    };
  }

  /** The same checks as the agent. MCP cannot show a prompt, so it is refused instead. */
  async function runExternalCall(name: string, rawArgs: unknown): Promise<ToolResult> {
    const validation = validateToolCall(name, rawArgs);
    if (!validation.ok) return toolFailure('invalid_arguments', validation.error, false);

    const context: ToolContext = {
      source: 'panel',
      currentTabId: null,
      signal: new AbortController().signal,
    };
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
  }

  const toolbox: AgentToolbox = { definitions: toolSpecs(), assess, execute, describeContext };
  return { toolbox, runExternalCall };
}
