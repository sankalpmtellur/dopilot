import type { BrowserCommand } from './commands.js';
import { validateNavigationUrl } from './url-policy.js';

export type ParsedInput =
  | { kind: 'command'; command: BrowserCommand }
  | { kind: 'help' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unknown' };

export const COMMAND_EXAMPLES = [
  'new tab',
  'open https://example.com',
  'list tabs',
  'switch to tab 2',
  'reload',
  'go back',
  'go forward',
  'close tab',
  'close tab 2',
] as const;

const FIXED_COMMANDS: Record<string, BrowserCommand> = {
  'new tab': { action: 'tab.new' },
  'open new tab': { action: 'tab.new' },
  'open a new tab': { action: 'tab.new' },
  'list tabs': { action: 'tab.list' },
  'show tabs': { action: 'tab.list' },
  tabs: { action: 'tab.list' },
  reload: { action: 'tab.reload' },
  refresh: { action: 'tab.reload' },
  'reload tab': { action: 'tab.reload' },
  back: { action: 'tab.back' },
  'go back': { action: 'tab.back' },
  forward: { action: 'tab.forward' },
  'go forward': { action: 'tab.forward' },
  'close tab': { action: 'tab.close' },
  'close this tab': { action: 'tab.close' },
};

/**
 * Exact command matching, with no AI involved. Anything else is reported as
 * unknown rather than guessed at, because these commands act on the user's browser.
 */
export function parseCommand(input: string): ParsedInput {
  const text = input.trim();
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');

  if (normalized === 'help' || normalized === '?') return { kind: 'help' };

  const fixed = FIXED_COMMANDS[normalized];
  if (fixed) return { kind: 'command', command: fixed };

  const opened = /^(?:open|go to|goto)\s+(\S+)$/i.exec(text);
  if (opened?.[1]) {
    const validation = validateNavigationUrl(opened[1]);
    if (validation.ok) {
      return { kind: 'command', command: { action: 'tab.open_url', url: validation.url } };
    }
    // "open youtube" is a request for the agent. "open chrome://settings" is refused outright.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(opened[1]);
    return hasScheme ? { kind: 'invalid', message: validation.reason } : { kind: 'unknown' };
  }

  const switched = /^(?:switch to|go to)(?: tab)? (\d+)$/.exec(normalized);
  if (switched?.[1]) {
    const position = Number(switched[1]);
    if (position < 1 || position > 10000) {
      return { kind: 'invalid', message: 'Tab numbers start at 1.' };
    }
    return { kind: 'command', command: { action: 'tab.switch', target: { position } } };
  }

  const closed = /^close tab (\d+)$/.exec(normalized);
  if (closed?.[1]) {
    const position = Number(closed[1]);
    if (position < 1 || position > 10000) {
      return { kind: 'invalid', message: 'Tab numbers start at 1.' };
    }
    return { kind: 'command', command: { action: 'tab.close', target: { position } } };
  }

  return { kind: 'unknown' };
}
