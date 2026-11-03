import { describe, expect, it } from 'vitest';
import { parseCommand } from './command-parser.js';
import { BrowserCommandSchema } from './commands.js';

describe('parseCommand', () => {
  it.each([
    ['new tab', { action: 'tab.new' }],
    ['  NEW   Tab. ', { action: 'tab.new' }],
    ['open https://youtube.com', { action: 'tab.open_url', url: 'https://youtube.com/' }],
    ['open youtube.com', { action: 'tab.open_url', url: 'https://youtube.com/' }],
    ['go to example.com', { action: 'tab.open_url', url: 'https://example.com/' }],
    ['list tabs', { action: 'tab.list' }],
    ['reload', { action: 'tab.reload' }],
    ['go back', { action: 'tab.back' }],
    ['go forward', { action: 'tab.forward' }],
    ['close tab', { action: 'tab.close' }],
    ['close tab 3', { action: 'tab.close', target: { position: 3 } }],
    ['switch to tab 2', { action: 'tab.switch', target: { position: 2 } }],
    ['go to tab 2', { action: 'tab.switch', target: { position: 2 } }],
  ])('parses %s into a valid command', (input, command) => {
    expect(parseCommand(input)).toEqual({ kind: 'command', command });
    expect(BrowserCommandSchema.safeParse(command).success).toBe(true);
  });

  it('refuses unsafe addresses with a reason', () => {
    for (const input of ['open javascript:alert(1)', 'open chrome://settings']) {
      expect(parseCommand(input).kind).toBe('invalid');
    }
  });

  it('does not guess at natural language', () => {
    for (const input of [
      'please find me a cheap flight',
      'open youtube and play music',
      'Open YouTube.',
      'open youtube',
      'Scroll down.',
      '',
    ]) {
      expect(parseCommand(input).kind).toBe('unknown');
    }
  });

  it('rejects tab zero', () => {
    expect(parseCommand('close tab 0').kind).toBe('invalid');
  });
});

describe('tab numbers and addresses', () => {
  it('reads “go to 3” as a tab, not a site called 3', () => {
    expect(parseCommand('go to 3')).toEqual({
      kind: 'command',
      command: { action: 'tab.switch', target: { position: 3 } },
    });
  });
});
