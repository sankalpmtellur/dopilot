import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridge } from './bridge.js';
import { createBackendMcpServer } from './server.js';

const token = 'test-token-value';
const auth = { authorization: `Bearer ${token}`, host: '127.0.0.1:4319' };

let bridge: ReturnType<typeof createBridge>;

function setup(options: { longPollMs?: number; callTimeoutMs?: number } = {}) {
  bridge = createBridge({ token, longPollMs: 20, callTimeoutMs: 200, ...options });
  return bridge;
}

/** Stands in for the extension: collects one call and answers it. */
async function answerNext(result: object) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const next = await bridge.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });
    if (next.statusCode === 200) {
      const call = next.json();
      await bridge.app.inject({
        method: 'POST',
        url: '/bridge/result',
        headers: auth,
        payload: { id: call.id, result },
      });
      return call;
    }
  }
  throw new Error('No call arrived');
}

afterEach(() => bridge?.stop());

describe('access control', () => {
  it.each([
    ['no token', { host: '127.0.0.1:4319' }, 401],
    ['the wrong token', { host: '127.0.0.1:4319', authorization: 'Bearer nope' }, 401],
    ['a rebinding host', { ...auth, host: 'evil.example' }, 403],
    ['a website origin', { ...auth, origin: 'https://evil.example' }, 403],
  ])('rejects %s', async (_label, headers, status) => {
    setup();
    const response = await bridge.app.inject({ method: 'GET', url: '/bridge/next', headers });
    expect(response.statusCode).toBe(status);
  });

  it('accepts the extension', async () => {
    setup();
    const response = await bridge.app.inject({
      method: 'GET',
      url: '/bridge/next',
      headers: { ...auth, origin: 'chrome-extension://abc' },
    });
    expect(response.statusCode).toBe(204);
  });

  it('rejects malformed results', async () => {
    setup();
    const response = await bridge.app.inject({
      method: 'POST',
      url: '/bridge/result',
      headers: auth,
      payload: { id: 'x', result: { nonsense: true } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('tool calls', () => {
  it('fails immediately when no extension is connected', async () => {
    setup();
    expect(await bridge.execute('get_tabs', {})).toMatchObject({
      ok: false,
      code: 'extension_not_connected',
    });
  });

  it('times out when the extension stops answering', async () => {
    setup();
    await bridge.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });
    expect(await bridge.execute('get_tabs', {})).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('runs end to end: MCP client, server, bridge, extension and back', async () => {
    setup({ callTimeoutMs: 2000 });
    await bridge.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });

    const server = createBackendMcpServer({ execute: bridge.execute });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const pending = client.callTool({ name: 'switch_tab', arguments: { tabId: 3 } });
    const delivered = await answerNext({ ok: true, summary: 'Switched tabs.' });
    const result = await pending;

    expect(delivered).toMatchObject({ name: 'switch_tab', arguments: { tabId: 3 } });
    expect(JSON.stringify(result.content)).toContain('Switched tabs.');
    expect(result.isError).toBeFalsy();
  });

  it('rejects invalid arguments before they reach the extension', async () => {
    setup();
    await bridge.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });
    const server = createBackendMcpServer({ execute: bridge.execute });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const result = await client
      .callTool({ name: 'press_key', arguments: { key: 'Control+W' } })
      .catch(() => ({ isError: true }));
    expect(result.isError).toBe(true);
    const next = await bridge.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });
    expect(next.statusCode).toBe(204);
  });
});

describe('bridge reliability', () => {
  it('forgets a call the caller has given up on, so it cannot run later', async () => {
    const instance = setup({ callTimeoutMs: 30 });
    await instance.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });
    const result = await instance.execute('close_tab', {});
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    const next = await instance.app.inject({ method: 'GET', url: '/bridge/next', headers: auth });
    expect(next.statusCode).toBe(204);
  });

  it('refuses requests with a wrong token, a foreign origin or a rebound host', async () => {
    const instance = setup();
    const get = (headers: Record<string, string>) =>
      instance.app.inject({ method: 'GET', url: '/bridge/next', headers });
    expect((await get({ host: '127.0.0.1:4319' })).statusCode).toBe(401);
    expect((await get({ ...auth, authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await get({ ...auth, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await get({ ...auth, host: 'evil.example' })).statusCode).toBe(403);
  });

  it('fails fast when no extension is connected', async () => {
    const instance = setup();
    const result = await instance.execute('get_tabs', {});
    expect(result).toMatchObject({ ok: false, code: 'extension_not_connected' });
  });
});
