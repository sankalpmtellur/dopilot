import { ToolCallSchema, toolFailure } from '@dopilot/shared';
import type { ToolResult } from '@dopilot/shared';
import { z } from 'zod';

/** Local development only, and off until a person pastes a token in settings. */
export const MCP_BRIDGE_ORIGIN = 'http://127.0.0.1:4319';
declare const __DOPILOT_MCP__: boolean | undefined;
/** Public builds leave this out, including from the security policy, unless asked for. */
export const MCP_AVAILABLE = typeof __DOPILOT_MCP__ === 'undefined' ? true : __DOPILOT_MCP__;
const STORAGE_KEY = 'mcpBridgeToken';
const RETRY_DELAY_MS = 3000;

const PendingCallSchema = ToolCallSchema.extend({ arguments: z.unknown() });

type RunCall = (name: string, args: unknown) => Promise<ToolResult>;

export interface McpBridgeDeps {
  runCall: RunCall;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Lets a local MCP server reach this browser. The extension connects outward with a
 * long poll, so it opens no port and needs no Node.js. Everything runs through the same
 * checks as the agent. The token lasts for this browser session only.
 */
export function createMcpBridge({ runCall, fetch: fetchImpl, sleep }: McpBridgeDeps) {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const wait = sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  let token: string | null = null;
  let connected = false;
  let running = false;
  let abort: AbortController | null = null;

  async function pollOnce(activeToken: string, signal: AbortSignal): Promise<void> {
    const headers = { Authorization: `Bearer ${activeToken}` };
    const response = await doFetch(`${MCP_BRIDGE_ORIGIN}/bridge/next`, { headers, signal });
    if (response.status === 204) {
      connected = true;
      return;
    }
    if (!response.ok) throw new Error(`Bridge replied ${response.status}`);
    connected = true;

    const call = PendingCallSchema.parse(await response.json());
    // A failure here belongs to this call. Treating it as a lost connection would leave the
    // caller waiting for a result that is never coming.
    const result = await runCall(call.name, call.arguments).catch(() =>
      toolFailure('execution_failed', 'That action could not be completed.'),
    );
    await doFetch(`${MCP_BRIDGE_ORIGIN}/bridge/result`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: call.id, result }),
      signal,
    });
  }

  async function loop(): Promise<void> {
    if (running) return;
    running = true;
    while (token) {
      const active = token;
      abort = new AbortController();
      try {
        await pollOnce(active, abort.signal);
      } catch {
        connected = false;
        if (token) await wait(RETRY_DELAY_MS);
      }
    }
    connected = false;
    running = false;
  }

  return {
    status: () => ({ enabled: token !== null, connected }),

    async configure(next: string | null): Promise<void> {
      if (!MCP_AVAILABLE) return;
      token = next;
      abort?.abort();
      if (next) {
        await chrome.storage.session.set({ [STORAGE_KEY]: next });
        void loop();
      } else {
        await chrome.storage.session.remove(STORAGE_KEY);
      }
    },

    /** Restores a connection after the service worker restarts. */
    async restore(): Promise<void> {
      if (!MCP_AVAILABLE) return;
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      const value = stored[STORAGE_KEY];
      if (typeof value === 'string' && value) {
        token = value;
        void loop();
      }
    },
  };
}
