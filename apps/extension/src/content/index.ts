import { ContentRequestSchema, toolFailure } from '@dopilot/shared';
import { createPageAgent } from './page-agent';

// Injected on demand with chrome.scripting, and possibly more than once per page.
const scope = globalThis as { __dopilotContentLoaded?: boolean };

if (!scope.__dopilotContentLoaded) {
  scope.__dopilotContentLoaded = true;
  const agent = createPageAgent();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the extension's service worker may send these. Webpages cannot reach this listener.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;

    const parsed = ContentRequestSchema.safeParse(message);
    if (!parsed.success) return false;

    void agent
      .handle(parsed.data)
      .then(sendResponse)
      .catch(() => sendResponse(toolFailure('page_error', 'That could not be done on this page.')));
    return true;
  });
}
