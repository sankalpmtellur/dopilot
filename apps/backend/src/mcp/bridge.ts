import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ToolResultSchema, toolFailure } from '@dopilot/shared';
import type { ToolResult } from '@dopilot/shared';
import Fastify from 'fastify';
import { z } from 'zod';

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 4319;

const LONG_POLL_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
/** A call fails fast if no extension has polled recently, rather than hanging. */
const CONNECTED_WITHIN_MS = LONG_POLL_MS + 10_000;

const ResultBodySchema = z.strictObject({ id: z.string().min(1), result: ToolResultSchema });

interface PendingCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface BridgeOptions {
  token: string;
  port?: number;
  longPollMs?: number;
  callTimeoutMs?: number;
}

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Connects a local MCP server to the extension. Calls wait here until the extension
 * collects them. The server binds to loopback only, requires a random token, and checks
 * the Host header so a malicious website cannot reach it through DNS rebinding. There is
 * no way to run a tool except through the extension's own permission and safety checks.
 */
export function createBridge({
  token,
  port = BRIDGE_PORT,
  longPollMs = LONG_POLL_MS,
  callTimeoutMs = CALL_TIMEOUT_MS,
}: BridgeOptions) {
  // Stdout carries the MCP protocol, so this server must never log.
  const app = Fastify({ logger: false });
  const queue: PendingCall[] = [];
  const waiting = new Map<string, (result: ToolResult) => void>();
  let wakePoller: (() => void) | null = null;
  let lastPollAt = 0;

  app.addHook('onRequest', async (request, reply) => {
    const hostname = request.headers.host?.split(':')[0];
    if (hostname !== BRIDGE_HOST && hostname !== 'localhost') {
      return reply.code(403).send();
    }
    const origin = request.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) return reply.code(403).send();

    const given = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!tokensMatch(given, token)) return reply.code(401).send();
  });

  app.get('/bridge/next', async (request, reply) => {
    lastPollAt = Date.now();
    if (queue.length === 0) {
      // A restarted worker polls again while its old request still looks open. Only the
      // newest may wait, or a call could be handed to a connection nobody is reading.
      wakePoller?.();
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          if (wakePoller === finish) wakePoller = null;
          request.raw.off('close', finish);
          resolve();
        };
        const timer = setTimeout(finish, longPollMs);
        wakePoller = finish;
        request.raw.once('close', finish);
      });
      lastPollAt = Date.now();
    }
    if (request.raw.destroyed || reply.raw.destroyed) return reply.code(204).send();
    const next = queue.shift();
    return next ? next : reply.code(204).send();
  });

  app.post('/bridge/result', async (request, reply) => {
    const body = ResultBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send();
    waiting.get(body.data.id)?.(body.data.result);
    return reply.code(204).send();
  });

  return {
    app,
    start: () => app.listen({ host: BRIDGE_HOST, port }),
    stop: () => app.close(),

    execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      if (Date.now() - lastPollAt > CONNECTED_WITHIN_MS) {
        return Promise.resolve(
          toolFailure(
            'extension_not_connected',
            'The Dopilot extension is not connected. In its settings, turn on the MCP bridge with the token this server printed.',
            false,
          ),
        );
      }
      const id = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          // Otherwise the extension could still act on it later, long after the caller gave up.
          const index = queue.findIndex((call) => call.id === id);
          if (index !== -1) queue.splice(index, 1);
          resolve(toolFailure('timeout', 'The extension did not respond in time.'));
        }, callTimeoutMs);
        waiting.set(id, (result) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(result);
        });
        queue.push({ id, name, arguments: args });
        wakePoller?.();
      });
    },
  };
}
