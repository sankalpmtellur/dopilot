import { ToolResultSchema, toolFailure } from '@dopilot/shared';
import type { ContentRequest, ToolResult } from '@dopilot/shared';

export class NoPageAccessError extends Error {}
/** The browser is showing its own error page, because the site failed to load. */
export class ErrorPageError extends Error {}
/** The page did not answer. It may be loading, busy, or held up by a dialog. */
export class PageBusyError extends Error {}

export type PageState = 'ready' | 'error_page' | 'no_access' | 'busy';

/** Talks to the content script, adding it to the page first if it is not there yet. */
export interface ContentPort {
  /** True when the extension can run in this tab, through a host permission or activeTab. */
  canAccess(tabId: number): Promise<boolean>;
  send(tabId: number, request: ContentRequest): Promise<ToolResult>;
  /** Whether a page that finished loading is really a usable page. */
  pageState?(tabId: number): Promise<PageState>;
}

const PING_TIMEOUT_MS = 1500;
const INJECT_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A page in the middle of loading refuses scripts for a moment, so this tries again. */
const INJECT_ATTEMPTS = 3;
const INJECT_RETRY_MS = 300;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PageBusyError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Failed'));
      },
    );
  });
}

function timeoutFor(request: ContentRequest): number {
  return request.type === 'content.wait' ? request.timeoutMs + 3000 : REQUEST_TIMEOUT_MS;
}

async function ping(tabId: number): Promise<boolean> {
  try {
    const reply = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'content.ping' }, { frameId: 0 }),
      PING_TIMEOUT_MS,
    );
    return ToolResultSchema.safeParse(reply).success;
  } catch {
    return false;
  }
}

type InjectOutcome = 'ok' | 'no_access' | 'error_page' | 'busy';

/** Browsers explain a refusal only in the error text, and the reasons need different handling. */
export function classifyInjectError(message: string): InjectOutcome {
  if (/error page/i.test(message)) return 'error_page';
  if (
    /cannot access|permission|must request|gallery cannot be scripted|cannot be scripted/i.test(
      message,
    )
  ) {
    return 'no_access';
  }
  return 'busy';
}

async function inject(tabId: number): Promise<InjectOutcome> {
  let outcome: InjectOutcome = 'busy';
  for (let attempt = 0; attempt < INJECT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, INJECT_RETRY_MS));
    try {
      await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: ['content.js'],
        }),
        INJECT_TIMEOUT_MS,
      );
      return 'ok';
    } catch (error) {
      // Timing out already took seconds, and a frozen page will not recover in a few more.
      if (error instanceof PageBusyError) return 'busy';
      outcome = classifyInjectError(error instanceof Error ? error.message : '');
      if (outcome !== 'busy') return outcome;
    }
  }
  return outcome;
}

async function ensureScript(tabId: number): Promise<InjectOutcome> {
  return (await ping(tabId)) ? 'ok' : inject(tabId);
}

export const chromeContentPort: ContentPort = {
  async canAccess(tabId) {
    return (await ensureScript(tabId)) === 'ok';
  },

  async pageState(tabId) {
    const outcome = await ensureScript(tabId);
    return outcome === 'ok' ? 'ready' : outcome;
  },

  async send(tabId, request) {
    const outcome = await ensureScript(tabId);
    if (outcome === 'no_access') throw new NoPageAccessError();
    if (outcome === 'error_page') throw new ErrorPageError();
    if (outcome === 'busy') throw new PageBusyError();
    const reply: unknown = await withTimeout(
      chrome.tabs.sendMessage(tabId, request, { frameId: 0 }),
      timeoutFor(request),
    );
    const parsed = ToolResultSchema.safeParse(reply);
    return parsed.success
      ? parsed.data
      : toolFailure('page_error', 'The page gave an unexpected response.');
  },
};
