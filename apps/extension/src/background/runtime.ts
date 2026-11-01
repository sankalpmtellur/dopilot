import { commandError, describeCommand } from '@dopilot/shared';
import type { BrowserCommand, CommandResult, CommandSource, ExtensionState } from '@dopilot/shared';
import { appendActionLog, loadActionLog } from '@/lib/action-log';
import { loadGroqStatus } from '@/lib/api-key-store';
import {
  chromeBrowserApi,
  executeCommand,
  findCurrentTabId,
  listTabs,
} from '@/lib/browser-commands';
import { ConfirmationManager } from '@/lib/confirmations';
import { hasTabDetails } from '@/permissions/tab-details';
import { agentRunner } from './agent-host';

export const confirmations = new ConfirmationManager({
  async open(id) {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL(`confirm/index.html?id=${id}`),
      type: 'popup',
      width: 420,
      height: 240,
    });
    return created?.id;
  },
  async close(windowId) {
    await chrome.windows.remove(windowId);
  },
});

export async function buildState(
  source: CommandSource,
  senderTabId?: number,
): Promise<ExtensionState> {
  const [tabDetailsAvailable, tabs, currentTabId, groq, recentActions, agent] = await Promise.all([
    hasTabDetails(),
    listTabs(chromeBrowserApi),
    findCurrentTabId(chromeBrowserApi, source, senderTabId),
    loadGroqStatus(),
    loadActionLog(),
    agentRunner.view(),
  ]);
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    tabDetailsAvailable,
    tabs,
    currentTabId,
    groq,
    agent,
    recentActions,
  };
}

async function record(
  command: BrowserCommand,
  source: CommandSource,
  result: CommandResult,
): Promise<void> {
  if (!result.ok && result.code === 'confirmation_required') return;
  await appendActionLog({
    id: crypto.randomUUID(),
    at: Date.now(),
    source,
    summary: describeCommand(command),
    ok: result.ok,
    detail: result.message,
  });
}

export async function runPanelCommand(
  command: BrowserCommand,
  confirmed: boolean,
): Promise<CommandResult> {
  const result = await executeCommand(chromeBrowserApi, command, { source: 'panel', confirmed });
  await record(command, 'panel', result);
  return result;
}

export async function runWebsiteCommand(
  command: BrowserCommand,
  requestId: string,
  senderTabId?: number,
): Promise<CommandResult> {
  const result = await executeCommand(chromeBrowserApi, command, {
    source: 'website',
    senderTabId,
    confirmed: false,
    requestConfirmation: async (prompt) => {
      if (confirmations.busy) {
        return commandError('confirmation_busy', 'Another confirmation is already waiting.');
      }
      const outcome = await confirmations.request(prompt, requestId);
      switch (outcome) {
        case 'approved':
          return null;
        case 'denied':
          return commandError('confirmation_denied', 'You chose not to do this.');
        case 'timeout':
          return commandError('confirmation_timeout', 'The confirmation expired.');
        case 'cancelled':
          return commandError('cancelled', 'Cancelled.');
      }
    },
  });
  await record(command, 'website', result);
  return result;
}
