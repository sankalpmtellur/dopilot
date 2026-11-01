import { ToolResultSchema, toolFailure } from '@dopilot/shared';
import type { ContentRequest, ToolResult } from '@dopilot/shared';

export class NoPageAccessError extends Error {}

/** Talks to the content script, adding it to the page first if it is not there yet. */
export interface ContentPort {
  /** True when the extension can run in this tab, through a host permission or activeTab. */
  canAccess(tabId: number): Promise<boolean>;
  send(tabId: number, request: ContentRequest): Promise<ToolResult>;
}

async function ping(tabId: number): Promise<boolean> {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'content.ping' }, { frameId: 0 });
    return ToolResultSchema.safeParse(reply).success;
  } catch {
    return false;
  }
}

async function inject(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

export const chromeContentPort: ContentPort = {
  async canAccess(tabId) {
    return (await ping(tabId)) || (await inject(tabId));
  },

  async send(tabId, request) {
    if (!(await ping(tabId)) && !(await inject(tabId))) throw new NoPageAccessError();
    const reply: unknown = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
    const parsed = ToolResultSchema.safeParse(reply);
    return parsed.success
      ? parsed.data
      : toolFailure('page_error', 'The page gave an unexpected response.');
  },
};
