import { ContentRequestSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type { ContentResponse } from '@dopilot/shared';

// Injected on demand with chrome.scripting, and possibly more than once per page.
const scope = globalThis as { __dopilotContentLoaded?: boolean };

if (!scope.__dopilotContentLoaded) {
  scope.__dopilotContentLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (!ContentRequestSchema.safeParse(message).success) return false;

    const response: ContentResponse = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'content.pong',
      url: location.href,
    };
    sendResponse(response);
    return false;
  });
}
