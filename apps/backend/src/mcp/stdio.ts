#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BRIDGE_PORT, createBridge } from './bridge.js';
import { createBackendMcpServer } from './server.js';

// A local development entry point for MCP clients: stdio on one side, the extension on
// the other. It listens on loopback only and is never part of the normal backend.
const token = process.env.DOPILOT_MCP_TOKEN || randomBytes(24).toString('base64url');
const bridge = createBridge({ token, port: Number(process.env.DOPILOT_MCP_PORT) || BRIDGE_PORT });
await bridge.start();

const server = createBackendMcpServer({ execute: bridge.execute });
await server.connect(new StdioServerTransport());

// Stderr, because stdout carries the MCP protocol.
console.error(`Dopilot MCP server ready. Bridge token for extension settings: ${token}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void bridge.stop().finally(() => process.exit(0)));
}
