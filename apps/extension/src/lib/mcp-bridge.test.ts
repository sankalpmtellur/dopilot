import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpBridge, MCP_BRIDGE_ORIGIN } from './mcp-bridge';

let session: Map<string, unknown>;

beforeEach(() => {
  session = new Map();
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
        },
        remove: async (key: string) => void session.delete(key),
      },
    },
  });
});

describe('MCP bridge client', () => {
  it('does nothing until configured', async () => {
    const fetchStub = vi.fn<typeof fetch>();
    const bridge = createMcpBridge({ runCall: vi.fn(), fetch: fetchStub });
    await bridge.restore();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(bridge.status()).toEqual({ enabled: false, connected: false });
  });

  it('only talks to the loopback address, runs calls, and sends back results', async () => {
    const runCall = vi.fn(async () => ({ ok: true as const, summary: 'Listed.' }));
    const replies = [Response.json({ id: 'c1', name: 'get_tabs', arguments: {} })];
    const posted: unknown[] = [];
    const fetchStub = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).startsWith(MCP_BRIDGE_ORIGIN)).toBe(true);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        await bridge.configure(null);
        return new Response(null, { status: 204 });
      }
      return replies.shift() ?? new Response(null, { status: 204 });
    });

    const bridge = createMcpBridge({ runCall, fetch: fetchStub, sleep: async () => undefined });
    await bridge.configure('secret');

    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(runCall).toHaveBeenCalledWith('get_tabs', {});
    expect(posted[0]).toEqual({ id: 'c1', result: { ok: true, summary: 'Listed.' } });
    expect(bridge.status().enabled).toBe(false);
    expect(session.has('mcpBridgeToken')).toBe(false);
  });

  it('survives the server being absent', async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      if (fetchStub.mock.calls.length >= 2) await bridge.configure(null);
      throw new TypeError('Failed to fetch');
    });
    const bridge = createMcpBridge({
      runCall: vi.fn(),
      fetch: fetchStub,
      sleep: async () => undefined,
    });
    await bridge.configure('secret');
    await vi.waitFor(() => expect(bridge.status()).toEqual({ enabled: false, connected: false }));
  });
});
