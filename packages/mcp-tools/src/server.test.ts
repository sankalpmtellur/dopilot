import { BROWSER_TOOLS } from '@dopilot/browser-tools';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserMcpServer } from './server.js';

async function connect() {
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }));
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

  it('passes valid calls to the executor', async () => {
    const { client, execute } = await connect();
    await client.callTool({ name: 'tabs_activate', arguments: { tabId: 7 } });
    expect(execute).toHaveBeenCalledWith('tabs_activate', { tabId: 7 });
  });

  it('never executes invalid calls', async () => {
    const { client, execute } = await connect();
    const result = await client
      .callTool({ name: 'tabs_activate', arguments: { tabId: 'not-a-number' } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
