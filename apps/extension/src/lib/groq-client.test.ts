import { ModelError } from '@dopilot/agent-core';
import { toolSpecs } from '@dopilot/browser-tools';
import { describe, expect, it, vi } from 'vitest';
import { createGroqModelClient } from './groq-client';

const KEY = 'gsk_test_key_abcdefghijklmnopqrstuvwxyz';

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status, headers }));
}

const request = {
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
};

async function failure(fetchStub: typeof fetch, signal = request.signal): Promise<ModelError> {
  const error = await createGroqModelClient(KEY, fetchStub)
    .complete({ ...request, signal })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

// Every test uses a stub fetch. No test ever contacts Groq.
describe('tool calling', () => {
  it('sends tool definitions, and reads structured tool calls', async () => {
    const fetchStub = reply(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'navigate', arguments: '{"url":"https://youtube.com"}' },
              },
              { id: 'c2', type: 'function', function: { name: 'get_tabs', arguments: '' } },
            ],
          },
        },
      ],
    });
    const response = await createGroqModelClient(KEY, fetchStub).complete({
      ...request,
      tools: toolSpecs(),
    });

    expect(response.toolCalls).toEqual([
      { id: 'c1', name: 'navigate', arguments: { url: 'https://youtube.com' } },
      { id: 'c2', name: 'get_tabs', arguments: {} },
    ]);

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(String(url)).toContain('/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test-model');
    expect(body.tool_choice).toBe('auto');
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain(
      'click_element',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('leaves malformed arguments for validation to reject, rather than crashing', async () => {
    const fetchStub = reply(200, {
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'c', type: 'function', function: { name: 'navigate', arguments: '{oops' } },
            ],
          },
        },
      ],
    });
    const response = await createGroqModelClient(KEY, fetchStub).complete(request);
    expect(response.toolCalls[0]?.arguments).toBe('{oops');
  });

  it('sends earlier tool calls and their results back in the right shape', async () => {
    const fetchStub = reply(200, { choices: [{ message: { content: 'Done' } }] });
    const response = await createGroqModelClient(KEY, fetchStub).complete({
      ...request,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'get_tabs', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      ],
    });
    expect(response.text).toBe('Done');

    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].tool_calls[0]).toMatchObject({
      id: 'c1',
      function: { name: 'get_tabs', arguments: '{}' },
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
  });

  it('maps vision content for later use', async () => {
    const fetchStub = reply(200, { choices: [{ message: { content: 'ok' } }] });
    await createGroqModelClient(KEY, fetchStub).complete({
      ...request,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
          ],
        },
      ],
    });
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AA==' },
    });
  });
});

describe('Groq errors', () => {
  it('reads rate limits and their retry delay, and never retries by itself', async () => {
    const fetchStub = reply(429, { error: {} }, { 'retry-after': '12' });
    const error = await failure(fetchStub);
    expect(error).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 12 });
    expect(error.message).toContain('12s');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('explains a long rate limit in hours', async () => {
    const error = await failure(reply(429, { error: {} }, { 'retry-after': '7200' }));
    expect(error.message).toContain('2 hours');
  });

  it('reports a rejected key, without repeating the API text', async () => {
    const error = await failure(reply(401, { error: { message: `bad key ${KEY}` } }));
    expect(error.kind).toBe('invalid_key');
    expect(error.message).not.toContain(KEY);
  });

  it.each([
    ['a missing model', 404, { error: { code: 'model_not_found', message: 'gone' } }],
    ['a retired model', 400, { error: { code: 'model_decommissioned', message: 'gone' } }],
    ['a model without tools', 400, { error: { message: 'This model does not support tools' } }],
  ])('treats %s as unavailable, so another can be tried', async (_label, status, body) => {
    expect((await failure(reply(status, body))).kind).toBe('model_unavailable');
  });

  it('recognizes a malformed tool call from the model', async () => {
    const error = await failure(
      reply(400, { error: { code: 'tool_use_failed', message: 'Failed to call a function' } }),
    );
    expect(error.kind).toBe('bad_tool_call');
  });

  it('reports oversized requests, server problems, and being offline', async () => {
    expect((await failure(reply(413, { error: {} }))).kind).toBe('request_too_large');
    expect((await failure(reply(503, { error: {} }))).kind).toBe('server');
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(offline)).kind).toBe('network');
  });

  it('reports cancellation', async () => {
    const controller = new AbortController();
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const pending = failure(hanging, controller.signal);
    controller.abort();
    expect((await pending).kind).toBe('cancelled');
  });
});
