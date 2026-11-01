import type { ConsoleMessage } from '@dopilot/ui';

const STORAGE_KEY = 'dopilot.conversation';

/** Session storage, so history survives reloads but not closing the tab. */
export async function loadConversation(): Promise<ConsoleMessage[]> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as ConsoleMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveConversation(messages: ConsoleMessage[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // History is a convenience; the conversation still works without it.
  }
}
