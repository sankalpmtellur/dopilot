import { BROWSER_TOOLS } from '@dopilot/browser-tools';
import type { ToolResult } from '@dopilot/shared';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserMcpServer } from './server.js';

async function connect() {
  const execute = vi.fn(async (): Promise<ToolResult> => ({
    ok: true,
    summary: 'done',
    data: { value: 1 },
  }));
  const server = createBrowserMcpServer({ execute }, { name: 'test', version: '0.0.0' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, execute };
}

describe('createBrowserMcpServer', () => {
  it('lists every browser tool', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      BROWSER_TOOLS.map((tool) => tool.name).sort(),
    );
  });

  it('passes valid calls to the executor and returns its structured result', async () => {
    const { client, execute } = await connect();
    const result = await client.callTool({ name: 'switch_tab', arguments: { tabId: 7 } });
    expect(execute).toHaveBeenCalledWith('switch_tab', { tabId: 7 });
    expect(result.isError).toBeFalsy();
    const [content] = result.content as { text: string }[];
    expect(JSON.parse(content?.text ?? '')).toEqual({
      ok: true,
      summary: 'done',
      data: { value: 1 },
    });
  });

  it('reports failures as errors', async () => {
    const { client, execute } = await connect();
    execute.mockResolvedValue({
      ok: false,
      code: 'approval_required',
      message: 'No.',
      recoverable: false,
    });
    const result = await client.callTool({ name: 'close_tab', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('does not pass along a malformed result', async () => {
    const { client, execute } = await connect();
    execute.mockResolvedValue({ unexpected: true } as never);
    const result = await client.callTool({ name: 'get_tabs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('invalid_result');
  });

  it('never executes invalid calls', async () => {
    const { client, execute } = await connect();
    const result = await client
      .callTool({ name: 'switch_tab', arguments: { tabId: 'not-a-number' } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
