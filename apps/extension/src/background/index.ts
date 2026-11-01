import { PanelRequestSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type { PanelResponse } from '@dopilot/shared';
import { loadApiKey, restrictStorageToTrustedContexts } from '@/lib/api-key-store';
import { handleExternalMessage } from '@/messaging/external';
import { isExtensionPage } from '@/messaging/sender';

// Registered synchronously so the browser can wake this worker for each event.
void restrictStorageToTrustedContexts();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  sendResponse(handleExternalMessage(message, sender.origin, chrome.runtime.getManifest().version));
});

let agentStatus: PanelResponse['agentStatus'] = 'idle';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionPage(sender, chrome.runtime.id)) return false;

  const parsed = PanelRequestSchema.safeParse(message);
  if (!parsed.success) return false;

  if (parsed.data.type === 'panel.stop_agent') agentStatus = 'cancelled';

  void loadApiKey().then((apiKey) => {
    const response: PanelResponse = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'panel.status',
      hasApiKey: apiKey !== undefined,
      agentStatus,
    };
    sendResponse(response);
  });
  return true;
});
