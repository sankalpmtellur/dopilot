import { describe, expect, it, vi } from 'vitest';
import { createGroqModelClient } from './groq-client';

// Uses a stub fetch. No test ever contacts Groq.
describe('createGroqModelClient', () => {
  it('maps vision requests and tool calls without touching the network', async () => {
    const fetchStub = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: '1', type: 'function', function: { name: 'tabs_list', arguments: '{}' } },
                { id: '2', type: 'function', function: { name: 'page_read', arguments: 'oops' } },
              ],
            },
          },
        ],
      }),
    );

    const client = createGroqModelClient('test-key', fetchStub);
    const response = await client.complete({
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
          ],
        },
      ],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.toolCalls).toEqual([
      { id: '1', name: 'tabs_list', arguments: {} },
      { id: '2', name: 'page_read', arguments: 'oops' },
    ]);

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(String(url)).toContain('api.groq.com');
    const body = JSON.parse(String(init?.body));
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AA==' },
    });
  });
});
