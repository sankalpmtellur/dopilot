import type { ModelClient, ModelMessage, ModelResponse } from '@dopilot/agent-core';
import Groq from 'groq-sdk';

type GroqMessage = Groq.Chat.ChatCompletionMessageParam;

function toGroqMessage(message: ModelMessage): GroqMessage {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

  switch (message.role) {
    case 'system':
      return { role: 'system', content: text };
    case 'tool':
      return { role: 'tool', content: text, tool_call_id: message.toolCallId ?? '' };
    case 'assistant':
      return {
        role: 'assistant',
        content: text,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }),
      };
    case 'user':
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text' as const, text: part.text }
                  : { type: 'image_url' as const, image_url: { url: part.dataUrl } },
              ),
      };
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Left for tool validation to reject; malformed output must not crash the loop.
    return raw;
  }
}

/**
 * Sends requests straight from the extension to Groq, so the key never touches
 * our backend. `dangerouslyAllowBrowser` is required for that design: the key is
 * the user's own and stays in the extension, never in a webpage.
 */
export function createGroqModelClient(apiKey: string, fetchImpl?: typeof fetch): ModelClient {
  const groq = new Groq({
    apiKey,
    dangerouslyAllowBrowser: true,
    ...(fetchImpl && { fetch: fetchImpl }),
  });

  return {
    async complete({ model, messages, tools, signal }): Promise<ModelResponse> {
      const completion = await groq.chat.completions.create(
        {
          model,
          messages: messages.map(toGroqMessage),
          ...(tools.length > 0 && {
            tools: tools.map((tool) => ({ type: 'function' as const, function: tool })),
          }),
        },
        { signal },
      );

      const reply = completion.choices[0]?.message;
      return {
        text: reply?.content ?? null,
        toolCalls: (reply?.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),
        })),
      };
    },
  };
}
