import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOLS,
  describeToolCall,
  requiresConfirmation,
  toolSpecs,
  validateToolCall,
} from './catalog.js';

const REQUIRED = [
  'get_active_tab',
  'get_page_content',
  'get_interactive_elements',
  'get_page_metadata',
  'get_visible_text',
  'get_tabs',
  'open_tab',
  'open_tabs',
  'navigate',
  'switch_tab',
  'switch_tab_by_name',
  'close_tab',
  'reload_tab',
  'go_back',
  'go_forward',
  'click_element',
  'type_text',
  'clear_input',
  'scroll_page',
  'select_option',
  'press_key',
  'wait_for_element',
  'capture_visible_tab',
  'analyze_screenshot',
  'get_visual_page_context',
  'click_visual_target',
];

describe('tool registry', () => {
  it('has every required tool, once', () => {
    expect(BROWSER_TOOLS.map((tool) => tool.name).sort()).toEqual([...REQUIRED].sort());
  });

  it('uses names accepted by MCP and model function calling', () => {
    for (const tool of BROWSER_TOOLS) expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('always asks before closing a tab', () => {
    const close = BROWSER_TOOLS.find((tool) => tool.name === 'close_tab');
    expect(close && requiresConfirmation(close)).toBe(true);
  });

  it('produces JSON Schema for the model', () => {
    const click = toolSpecs().find((tool) => tool.name === 'click_element');
    expect(click?.parameters).toMatchObject({
      type: 'object',
      required: ['ref'],
      properties: { ref: { type: 'string' }, tabId: { type: 'integer' } },
    });
    expect(click?.parameters.$schema).toBeUndefined();
  });

  it('keeps definitions small, since they count against the quota on every request', () => {
    const size = JSON.stringify(toolSpecs().map((tool) => ({ type: 'function', function: tool })));
    expect(size.length).toBeLessThan(6500);
    expect(size).not.toContain('9007199254740991');
  });

  it('still enforces the limits it leaves out of the definitions', () => {
    expect(validateToolCall('switch_tab', { tabId: -1 }).ok).toBe(false);
    expect(validateToolCall('click_element', { ref: 'not a ref' }).ok).toBe(false);
    expect(validateToolCall('navigate', { url: 'x'.repeat(3000) }).ok).toBe(false);
    expect(validateToolCall('get_tabs', { extra: true }).ok).toBe(false);
  });
});

describe('validateToolCall', () => {
  it('accepts valid calls, and no arguments for tools without any', () => {
    expect(validateToolCall('click_element', { ref: 'ab12.4' }).ok).toBe(true);
    expect(validateToolCall('get_tabs', undefined).ok).toBe(true);
  });

  it.each([
    ['unknown tool', 'run_javascript', { code: 'alert(1)' }],
    ['CSS selector instead of ref', 'click_element', { ref: '#buy' }],
    ['wrong type', 'switch_tab', { tabId: '1' }],
    ['self-approval', 'close_tab', { confirmed: true }],
    ['missing argument', 'navigate', {}],
    ['unrestricted shortcut', 'press_key', { key: 'Control+W' }],
    ['raw model output', 'get_tabs', 'not json'],
    ['scroll with no target', 'scroll_page', {}],
    ['scroll with two targets', 'scroll_page', { direction: 'down', text: 'History' }],
    ['wait for nothing', 'wait_for_element', {}],
    ['very long wait', 'wait_for_element', { text: 'x', timeoutSeconds: 600 }],
    ['raw coordinates from the model', 'click_visual_target', { x: 10, y: 20 }],
    ['a question that is too long', 'analyze_screenshot', { question: 'x'.repeat(600) }],
  ])('rejects %s', (_label, name, args) => {
    expect(validateToolCall(name, args).ok).toBe(false);
  });
});

describe('describeToolCall', () => {
  it('keeps query strings out of labels', () => {
    expect(describeToolCall('navigate', { url: 'https://a.com/x?token=secret' })).toBe(
      'Going to https://a.com/x',
    );
  });
});

describe('open_tabs', () => {
  it('needs exactly one of count or urls', () => {
    expect(validateToolCall('open_tabs', {}).ok).toBe(false);
    expect(validateToolCall('open_tabs', { count: 2, urls: ['a.com'] }).ok).toBe(false);
    expect(validateToolCall('open_tabs', { count: 2 }).ok).toBe(true);
    expect(validateToolCall('open_tabs', { urls: ['a.com'] }).ok).toBe(true);
  });

  it('refuses anything that is not a whole number', () => {
    expect(validateToolCall('open_tabs', { count: 2.5 }).ok).toBe(false);
    expect(validateToolCall('open_tabs', { count: '10' }).ok).toBe(false);
    expect(validateToolCall('open_tabs', { count: 2, activate: 0 }).ok).toBe(false);
  });

  it('knows how many actions a call stands for', () => {
    const tool = BROWSER_TOOLS.find((item) => item.name === 'open_tabs');
    expect(tool?.batchSize?.({ count: 7 })).toBe(7);
    expect(tool?.batchSize?.({ urls: ['a', 'b'] })).toBe(2);
  });
});
