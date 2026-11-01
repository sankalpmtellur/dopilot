import { ActionLogEntrySchema } from '@dopilot/shared';
import type { ActionLogEntry } from '@dopilot/shared';
import { z } from 'zod';

const STORAGE_KEY = 'recentActions';
const MAX_ENTRIES = 30;

let queue: Promise<unknown> = Promise.resolve();

/** Kept in session storage, so the history ends when the browser closes. */
export async function loadActionLog(): Promise<ActionLogEntry[]> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const parsed = z.array(ActionLogEntrySchema).safeParse(stored[STORAGE_KEY]);
  return parsed.success ? parsed.data : [];
}

export function appendActionLog(entry: ActionLogEntry): Promise<void> {
  // Sequential, because read-then-write from concurrent commands would lose entries.
  const next = queue.then(async () => {
    const entries = await loadActionLog();
    await chrome.storage.session.set({
      [STORAGE_KEY]: [entry, ...entries].slice(0, MAX_ENTRIES),
    });
  });
  queue = next.catch(() => undefined);
  return next;
}
