import {
  loadApiKey,
  loadGroqStatus,
  recordConnectionTest,
  restrictStorageToTrustedContexts,
} from '@/lib/api-key-store';
import { testGroqKey } from '@/lib/groq-test';
import { createExternalHandler } from '@/messaging/external';
import { handleInternalMessage } from '@/messaging/internal';
import { buildState, confirmations, runPanelCommand, runWebsiteCommand } from './runtime';

// Listeners are registered synchronously so the browser can wake this worker for each event.
void restrictStorageToTrustedContexts();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.windows.onRemoved.addListener((windowId) => confirmations.handleWindowClosed(windowId));

const handleExternalMessage = createExternalHandler({
  extensionVersion: chrome.runtime.getManifest().version,
  getState: (senderTabId) => buildState('website', senderTabId),
  execute: runWebsiteCommand,
  cancel: (requestId) => confirmations.cancelRequest(requestId),
  openSettings: () => chrome.runtime.openOptionsPage(),
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void handleExternalMessage(message, { origin: sender.origin, tabId: sender.tab?.id })
    .then(sendResponse)
    .catch(() => sendResponse(undefined));
  return true;
});

let groqTest: Promise<void> | null = null;

/** The only code that contacts Groq, and only for an explicit Test action. */
async function runGroqTest() {
  groqTest ??= (async () => {
    const apiKey = await loadApiKey();
    if (!apiKey) return;
    const outcome = await testGroqKey(apiKey);
    await recordConnectionTest(outcome.connection, outcome.models);
  })().finally(() => {
    groqTest = null;
  });
  await groqTest;
  return loadGroqStatus();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleInternalMessage(message, sender, {
    extensionId: chrome.runtime.id,
    getState: () => buildState('panel'),
    execute: runPanelCommand,
    testGroq: runGroqTest,
    getConfirmationPrompt: (id) => confirmations.getPrompt(id),
    decideConfirmation: (id, approved) => confirmations.decide(id, approved),
  })
    .then(sendResponse)
    .catch(() => sendResponse(undefined));
  return true;
});
