import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS, requiresConfirmation, validateToolCall } from './catalog.js';

describe('validateToolCall', () => {
  it('accepts a valid call', () => {
    expect(validateToolCall('page_click', { tabId: 1, selector: '#buy' }).ok).toBe(true);
  });

  it('rejects unknown tools, bad types and extra fields', () => {
    expect(validateToolCall('run_shell', {}).ok).toBe(false);
    expect(validateToolCall('page_click', { tabId: '1', selector: '#buy' }).ok).toBe(false);
    expect(validateToolCall('tabs_list', { confirmed: true }).ok).toBe(false);
  });
});

describe('BROWSER_TOOLS', () => {
  it('uses names accepted by MCP and model function calling', () => {
    for (const tool of BROWSER_TOOLS) expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('requires confirmation for clicking and typing', () => {
    for (const name of ['page_click', 'page_type']) {
      const tool = BROWSER_TOOLS.find((candidate) => candidate.name === name);
      expect(tool && requiresConfirmation(tool)).toBe(true);
    }
  });
});
